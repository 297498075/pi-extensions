import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

export interface VoiceItem {
	id: string;
	name: string;
	description?: string;
}
export type DeliveryMode = "editor" | "submit";
export interface VoiceConfig {
	gatewayUrl: string;
	defaultEnabled: boolean;
	defaultVoiceId: string;
	speed: number;
	deliveryMode: DeliveryMode;
	voicesCacheByGateway: Record<string, VoiceItem[] | null>;
}
export const DEFAULT_CONFIG: VoiceConfig = {
	gatewayUrl: "http://127.0.0.1:5234",
	defaultEnabled: false,
	defaultVoiceId: "default",
	speed: 1,
	deliveryMode: "editor",
	voicesCacheByGateway: {},
};
export const VoiceSpeakParamsSchema = Type.Object({
	text: Type.String({ minLength: 1, description: "Concise, natural spoken text (1-2 sentences). Speak like a human; do not read code, paths, logs, or tables." }),
	voice_id: Type.Optional(Type.String({ description: "Voice ID (optional; defaults to saved setting)" })),
	instruct: Type.Optional(Type.String({ description: "Optional tone or emotion instruction (e.g. 'cheerful', 'urgent')" })),
	speed: Type.Optional(Type.Number({ minimum: 0.5, maximum: 2 })),
});
export const VoiceListenParamsSchema = Type.Object({
	prompt: Type.Optional(Type.String({ description: "Optional prompt displayed in the UI while listening (not spoken aloud)" })),
	timeout_sec: Type.Optional(Type.Integer({ minimum: 3, maximum: 60, description: "Total timeout for recording and transcription in seconds (default 15)" })),
});
export const VoiceListVoicesParamsSchema = Type.Object({
	refresh: Type.Optional(Type.Boolean({ description: "Force refresh from gateway instead of using local cache" })),
});
export type VoiceSpeakParams = Static<typeof VoiceSpeakParamsSchema>;
export type VoiceListenParams = Static<typeof VoiceListenParamsSchema>;
export type VoiceListVoicesParams = Static<typeof VoiceListVoicesParamsSchema>;
export interface VoiceSpeakResult {
	status: "success" | "cancelled" | "error";
	reason?: string;
	message?: string;
}
export interface VoiceListenResult {
	status: "success" | "timeout" | "cancelled" | "error";
	reason?: "deadline_exceeded" | "busy" | "disabled";
	text: string;
	duration_ms?: number;
	message?: string;
}
export interface VoiceListVoicesResult {
	success: boolean;
	default_voice_id: string;
	voices: VoiceItem[];
	message?: string;
	warning?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function abortError(): Error {
	return new DOMException("Operation cancelled", "AbortError");
}
function checkSignal(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}
// Abort settles local waits even if a transport ignores cancellation. The underlying
// operation still receives the signal; its late resolution cannot mutate runtime state.
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const cancel = () => { cleanup(); reject(abortError()); };
		const cleanup = () => signal.removeEventListener("abort", cancel);
		signal.addEventListener("abort", cancel, { once: true });
		operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
		if (signal.aborted) cancel();
	});
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const cancel = () => { clearTimeout(timer); cleanup(); reject(abortError()); };
		const cleanup = () => signal?.removeEventListener("abort", cancel);
		const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
	});
}
function gatewayKey(value: string): string {
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash) {
		throw new Error("gatewayUrl 必须是无查询参数及 fragment 的 HTTP(S) 地址");
	}
	return url.toString().replace(/\/+$/, "");
}
function parseVoices(value: unknown, wireFormat = false): VoiceItem[] {
	if (!Array.isArray(value)) throw new Error("音色目录响应必须是数组");
	return value.map(item => {
		if (!isObject(item)) throw new Error("无效的音色目录条目");
		const id = item[wireFormat ? "voice_id" : "id"];
		if (typeof id !== "string" || !id.trim() || typeof item.name !== "string" || !item.name.trim()) {
			throw new Error("音色目录缺少有效 ID 或名称");
		}
		if (item.description !== undefined && item.description !== null && typeof item.description !== "string") {
			throw new Error("音色描述必须是字符串");
		}
		return { id, name: item.name, ...(typeof item.description === "string" ? { description: item.description } : {}) };
	});
}
function parseConfig(raw: unknown): VoiceConfig {
	if (!isObject(raw)) throw new Error("语音配置必须是 JSON object");
	const config = { ...DEFAULT_CONFIG, ...raw };
	if (typeof config.gatewayUrl !== "string" || typeof config.defaultEnabled !== "boolean" ||
		typeof config.defaultVoiceId !== "string" || !config.defaultVoiceId.trim() ||
		typeof config.speed !== "number" || !Number.isFinite(config.speed) || config.speed < 0.5 || config.speed > 2 ||
		!["editor", "submit"].includes(String(config.deliveryMode))) {
		throw new Error("无效的语音配置字段");
	}
	const cache = config.voicesCacheByGateway;
	if (!isObject(cache)) throw new Error("voicesCacheByGateway 必须是 object");
	const entries = Object.entries(cache).map(([key, value]) => [gatewayKey(key), value === null ? null : parseVoices(value)]);
	return { ...config, gatewayUrl: gatewayKey(config.gatewayUrl), voicesCacheByGateway: Object.fromEntries(entries) } as VoiceConfig;
}

export interface VoiceConfigStore {
	get(): VoiceConfig;
	update(updater: (current: VoiceConfig) => VoiceConfig, signal?: AbortSignal): Promise<VoiceConfig>;
}

export function defaultVoiceConfigDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Cross-process read/merge/replace. Failure to acquire the lock NEVER permits a write. */
export class VoiceConfigManager implements VoiceConfigStore {
	private readonly directory: string;
	private readonly configPath: string;
	private readonly legacyConfigPath: string;
	private readonly lockPath: string;
	private readonly lockTimeoutMs: number;

	constructor(customDir = defaultVoiceConfigDir(), lockTimeoutMs = 2000) {
		this.directory = customDir;
		this.configPath = join(customDir, "voice.json");
		this.legacyConfigPath = join(homedir(), ".pi", "voice.json");
		this.lockPath = join(customDir, "voice.json.lock");
		this.lockTimeoutMs = lockTimeoutMs;
	}
	public get(): VoiceConfig {
		try {
			return parseConfig(JSON.parse(readFileSync(this.configPath, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				// Seamless migration from legacy ~/.pi/voice.json if present
				try {
					if (this.configPath !== this.legacyConfigPath) {
						const legacy = parseConfig(JSON.parse(readFileSync(this.legacyConfigPath, "utf8")));
						return legacy;
					}
				} catch {
					// Ignore legacy fallback errors
				}
				return structuredClone(DEFAULT_CONFIG);
			}
			throw new Error(`读取 ${this.configPath} 失败: ${errorText(error)}`);
		}
	}
	public async update(updater: (current: VoiceConfig) => VoiceConfig, signal?: AbortSignal): Promise<VoiceConfig> {
		checkSignal(signal);
		await mkdir(this.directory, { recursive: true });
		const owner = JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: Date.now() });
		const deadline = Date.now() + this.lockTimeoutMs;
		let handle;
		for (;;) {
			checkSignal(signal);
			try {
				handle = await open(this.lockPath, "wx");
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (Date.now() >= deadline) throw new Error(`语音配置锁超时: ${this.lockPath}；未写入。若进程异常退出，请确认无写入进程后移除遗留锁。`);
				await delay(Math.min(25, Math.max(1, deadline - Date.now())), signal);
			}
		}
		let tempPath: string | undefined;
		try {
			await handle.writeFile(owner, "utf8");
			checkSignal(signal);
			// Read the newest file INSIDE the mutex. Invalid files are never reset/overwritten.
			const next = parseConfig(updater(this.get()));
			tempPath = join(this.directory, `voice.json.tmp.${process.pid}.${randomUUID()}`);
			await writeFile(tempPath, JSON.stringify(next, null, 2), { flag: "wx" });
			checkSignal(signal);
			await rename(tempPath, this.configPath);
			return next;
		} finally {
			await handle.close();
			if (tempPath) await unlink(tempPath).catch(() => {});
			// Never steal a time-based 'stale' lock or delete another owner's lock.
			const contents = await readFile(this.lockPath, "utf8").catch(() => null);
			if (contents === owner || contents === "") await unlink(this.lockPath).catch(() => {});
		}
	}
	public getVoicesCache(gatewayUrl: string): VoiceItem[] | null {
		return this.get().voicesCacheByGateway[gatewayKey(gatewayUrl)] ?? null;
	}
	public async setVoicesCache(gatewayUrl: string, voices: VoiceItem[]): Promise<void> {
		await this.update(config => ({ ...config, voicesCacheByGateway: { ...config.voicesCacheByGateway, [gatewayKey(gatewayUrl)]: voices } }));
	}
}

export interface RecordingResult { text: string; durationMs: number; }
/** A speaker bridge must settle only after physical playback and cancel only its own work. */
export interface VoiceGateway {
	probe(signal: AbortSignal): Promise<{ online: boolean }>;
	getVoices(signal: AbortSignal): Promise<VoiceItem[]>;
	recordAndTranscribe(options: { maxDurationSec: number; silenceTimeoutMs?: number; signal: AbortSignal }): Promise<RecordingResult>;
	speak(text: string, options: { voiceId: string; instruct?: string; speed: number; signal: AbortSignal }): Promise<void>;
}
export const UNSUPPORTED_SPEAKER = "当前 TtsGateway 不提供任务级取消和扬声器物理播放完成确认；已拒绝发音，不发送全局停播。需要后端协议升级。";

export class TtsGatewayAdapter implements VoiceGateway {
	private readonly baseUrl: string;
	constructor(baseUrl: string) { this.baseUrl = gatewayKey(baseUrl); }
	private async json(path: string, signal: AbortSignal, payload?: unknown): Promise<unknown> {
		checkSignal(signal);
		const res = await fetch(`${this.baseUrl}${path}`, {
			method: payload === undefined ? "GET" : "POST",
			...(payload === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
			signal,
		});
		if (!res.ok) throw new Error(`网关 HTTP ${res.status}`);
		return res.json();
	}
	public async probe(signal: AbortSignal): Promise<{ online: boolean }> {
		try { await this.json("/api/tts/playback/state", signal); return { online: true }; }
		catch { return { online: false }; }
	}
	public async getVoices(signal: AbortSignal): Promise<VoiceItem[]> {
		return parseVoices(await this.json("/api/voices", signal), true);
	}
	public async recordAndTranscribe(options: { maxDurationSec: number; silenceTimeoutMs?: number; signal: AbortSignal }): Promise<RecordingResult> {
		const data = await this.json("/api/v1/input/record-and-transcribe", options.signal, {
			max_duration_sec: options.maxDurationSec,
			silence_timeout_ms: options.silenceTimeoutMs ?? 1000,
		});
		if (!isObject(data) || data.code !== 0 || typeof data.text !== "string" ||
			(data.duration_ms !== undefined && (typeof data.duration_ms !== "number" || !Number.isFinite(data.duration_ms) || data.duration_ms < 0))) {
			throw new Error(isObject(data) && typeof data.error === "string" ? data.error : "无效或失败的录音转写响应");
		}
		return { text: data.text.trim(), durationMs: typeof data.duration_ms === "number" ? data.duration_ms : 0 };
	}
	public async speak(text: string, options: { voiceId: string; instruct?: string; speed: number; signal: AbortSignal }): Promise<void> {
		checkSignal(options.signal);
		const payload: Record<string, unknown> = {
			text,
			engine: "cosyvoice",
			voice_id: options.voiceId || "default",
			speed: options.speed ?? 1.0,
			output_mode: "speaker_playback",
			concurrency: "preempt",
			wait: true,
		};
		if (options.instruct) {
			payload.instruct = options.instruct;
		}

		// When cancelled, notify gateway to stop physical playback immediately
		const onAbort = () => {
			fetch(`${this.baseUrl}/api/tts/playback/control`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "stop" }),
				signal: AbortSignal.timeout(1000),
			}).catch(() => {});
		};
		options.signal.addEventListener("abort", onAbort, { once: true });

		try {
			const data = await this.json("/api/tts/synthesize", options.signal, payload);
			if (!isObject(data) || (typeof data.status === "string" && data.status !== "completed")) {
				const errMsg = isObject(data) && typeof data.error === "string" ? data.error : (isObject(data) && typeof data.status === "string" ? data.status : "合成播音失败");
				throw new Error(errMsg);
			}
		} finally {
			options.signal.removeEventListener("abort", onAbort);
		}
	}
}

interface AudioTask {
	id: string;
	epoch: number;
	kind: "speak" | "listen";
	controller: AbortController;
	gateway: VoiceGateway;
	config: VoiceConfig;
}
interface LiveRun {
	id: string;
	epoch: number;
	controller: AbortController;
}
export interface VoiceStatusModalInfo {
	enabled: boolean;
	live: boolean;
	activeTool: string | null;
	gatewayUrl: string;
	deliveryMode: DeliveryMode;
	defaultVoiceId: string;
	speed: number;
	speakerSupported: boolean;
}

export class VoiceStatusModalComponent implements Component {
	private boxLeft = 0;
	private boxTop = 0;
	private boxWidth = 0;
	private boxHeight = 0;
	private readonly tui: any;
	private readonly theme: any;
	private readonly info: VoiceStatusModalInfo;
	private readonly onClose: () => void;

	constructor(
		tui: any,
		theme: any,
		info: VoiceStatusModalInfo,
		onClose: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.info = info;
		this.onClose = onClose;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const totalLines = this.tui?.terminal?.rows || 24;
		this.boxWidth = Math.min(74, Math.max(50, Math.floor(width * 0.75)));
		this.boxHeight = 15;
		this.boxLeft = Math.max(0, Math.floor((width - this.boxWidth) / 2));
		this.boxTop = Math.max(0, Math.floor((totalLines - this.boxHeight) / 2));

		const innerWidth = this.boxWidth - 2;
		const lines: string[] = [];

		for (let i = 0; i < this.boxTop; i++) lines.push("");

		const title = " Pi Voice Extension Status ";
		const topDashTotal = Math.max(0, innerWidth - visibleWidth(title));
		const leftDash = Math.floor(topDashTotal / 2);
		const rightDash = topDashTotal - leftDash;
		lines.push(
			`${" ".repeat(this.boxLeft)}${this.theme.fg("accent", "┌" + "─".repeat(leftDash))}${this.theme.style(title, { bold: true, fg: "accent" })}${this.theme.fg("accent", "─".repeat(rightDash) + "┐")}`,
		);

		const pushRow = (contentStr: string, rawLen: number) => {
			const pad = Math.max(0, innerWidth - 2 - rawLen);
			lines.push(
				`${" ".repeat(this.boxLeft)}${this.theme.fg("accent", "│ ")}${contentStr}${" ".repeat(pad)} ${this.theme.fg("accent", "│")}`,
			);
		};

		// 1. Extension State
		const stateText = this.info.enabled ? "ENABLED (ON)" : "DISABLED (OFF)";
		const stateColored = this.info.enabled ? this.theme.fg("success", "ENABLED (ON)") : this.theme.fg("muted", "DISABLED (OFF)");
		pushRow(`• 扩展总开关   : ${stateColored}`, `• 扩展总开关   : ${stateText}`.length);

		// 2. Live Input State
		const liveText = this.info.live ? "RUNNING (🔴 LIVE ON)" : "STOPPED (⏸ OFF)";
		const liveColored = this.info.live ? this.theme.fg("error", "RUNNING (🔴 LIVE ON)") : this.theme.fg("muted", "STOPPED (⏸ OFF)");
		pushRow(`• 持续语音输入 : ${liveColored}`, `• 持续语音输入 : ${liveText}`.length);

		// 3. Active Tool
		const toolText = this.info.activeTool ? `BUSY (${this.info.activeTool})` : "IDLE";
		const toolColored = this.info.activeTool ? this.theme.fg("warning", `BUSY (${this.info.activeTool})`) : this.theme.fg("text", "IDLE");
		pushRow(`• 当前主动活动 : ${toolColored}`, `• 当前主动活动 : ${toolText}`.length);

		// 4. Delivery Mode
		const modeDesc = this.info.deliveryMode === "editor" ? "editor (追加至草稿待确认)" : "submit (直接提交/排队)";
		pushRow(`• 识别投递模式 : ${this.theme.fg("accent", modeDesc)}`, `• 识别投递模式 : ${modeDesc}`.length);

		// 5. Gateway URL
		const gwText = this.info.gatewayUrl;
		const gwTrunc = truncateToWidth(gwText, innerWidth - 18);
		pushRow(`• 后台网关地址 : ${this.theme.fg("text", gwTrunc)}`, `• 后台网关地址 : ${visibleWidth(gwTrunc)}`.length);

		// 6. Voice & Speed
		const voiceText = `${this.info.defaultVoiceId} (${this.info.speed}x 语速)`;
		pushRow(`• 默认发音音色 : ${this.theme.fg("text", voiceText)}`, `• 默认发音音色 : ${voiceText}`.length);

		// 7. Speaker Protocol Status
		const spkText = this.info.speakerSupported ? "ONLINE (CosyVoice 直出)" : "INCOMPATIBLE (已保护阻断)";
		const spkColored = this.info.speakerSupported ? this.theme.fg("success", "ONLINE (CosyVoice 直出)") : this.theme.fg("warning", "INCOMPATIBLE (已保护阻断)");
		pushRow(`• 扬声发音服务 : ${spkColored}`, `• 扬声发音服务 : ${spkText}`.length);

		// 8. Shortcuts
		const scText = "F2 (持续输入切换) | Alt+X (紧急停播/停录)";
		pushRow(`• 全局快捷键   : ${this.theme.fg("muted", scText)}`, `• 全局快捷键   : ${scText}`.length);

		pushRow("", 0);

		// Hint row
		const hint = "按 [Esc]、[Enter] 或任意键 / 点击关闭窗口";
		const hintTrunc = truncateToWidth(hint, innerWidth - 2);
		const hintPad = Math.max(0, innerWidth - 2 - visibleWidth(hintTrunc));
		lines.push(
			`${" ".repeat(this.boxLeft)}${this.theme.fg("accent", "│ ")}${this.theme.fg("muted", hintTrunc)}${" ".repeat(hintPad)} ${this.theme.fg("accent", "│")}`,
		);

		lines.push(`${" ".repeat(this.boxLeft)}${this.theme.fg("accent", "└" + "─".repeat(innerWidth) + "┘")}`);

		return lines;
	}

	handleInput(_data: string): void {
		this.onClose();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "click") {
			this.onClose();
			return { handled: true };
		}
		return undefined;
	}
}

export interface VoiceRuntimeOptions {
	config?: VoiceConfigStore;
	gateway?: (url: string) => VoiceGateway;
}

/** One request has exactly one owner. Cancellation changes ownership before any await. */
export class VoiceRuntime {
	public enabled = false;
	public live = false;
	public generationEpoch = 0;
	private context?: ExtensionContext;
	private readonly pi: ExtensionAPI;
	private readonly config: VoiceConfigStore;
	private readonly gateway: (url: string) => VoiceGateway;
	private active?: AudioTask;
	private liveRun?: LiveRun;
	private readonly auxiliary = new Set<AbortController>();
	private initialization?: { epoch: number; url: string; promise: Promise<VoiceListVoicesResult> };

	private toastTimer?: NodeJS.Timeout;
	private footerTimer?: NodeJS.Timeout;

	constructor(pi: ExtensionAPI, options: VoiceRuntimeOptions = {}) {
		this.pi = pi;
		this.config = options.config ?? new VoiceConfigManager();
		this.gateway = options.gateway ?? (url => new TtsGatewayAdapter(url));
	}
	public attach(ctx: ExtensionContext): void { this.context = ctx; }
	public getVoiceConfig(): VoiceConfig { return this.config.get(); }
	
	/**
	 * 显示交互反馈：优先使用输入框上方靠左底部 Widget (aboveEditor) 与最下方状态栏 (setStatus)，
	 * 彻底绕过被 rolling-tools 拦截静音的 ctx.ui.notify，并在变更时立即触发 TUI 界面重绘！
	 */
	public showToast(message: string, durationMs = 3500): void {
		if (!this.context?.hasUI) return;
		if (this.toastTimer) {
			clearTimeout(this.toastTimer);
			this.toastTimer = undefined;
		}

		// 1. 输入框上方靠左底部 Widget
		if (typeof this.context.ui?.setWidget === "function") {
			try {
				this.context.ui.setWidget("voice-toast", [message], { placement: "aboveEditor" });
				this.toastTimer = setTimeout(() => {
					try {
						this.context?.ui?.setWidget?.("voice-toast", undefined);
					} catch {}
					this.toastTimer = undefined;
				}, durationMs);
			} catch {}
		}

		// 2. 最下方状态栏单启一行（靠右）实时状态
		this.footer(message);
		if (this.footerTimer) {
			clearTimeout(this.footerTimer);
		}
		this.footerTimer = setTimeout(() => {
			this.footer();
			this.footerTimer = undefined;
		}, durationMs);
	}

	private notify(message: string, level: "info" | "warning" | "error" = "info"): void {
		// 重要错误/警告使用 notify；常规提示一律使用 showToast 保证可见性与即时重绘
		if (level === "error" || level === "warning") {
			if (this.context?.hasUI) this.context.ui.notify(message, level);
		}
		this.showToast(message);
	}

	private footer(extra?: string): void {
		if (!this.context?.hasUI) return;
		const base = !this.enabled ? "Voice: OFF" :
			`Voice: ON | Live: ${this.live ? "ON" : "OFF"}${this.active ? ` | ${this.active.kind}` : ""}`;
		const text = extra ? `${base} | ${extra}` : base;
		this.context.ui.setStatus("voice", text);
	}
	private tools(): void {
		const names = ["voice_speak", "voice_listen", "voice_list_voices"];
		const active = this.pi.getActiveTools();
		this.pi.setActiveTools(this.enabled ? [...new Set([...active, ...names])] : active.filter(name => !names.includes(name)));
	}
	private suspendLive(): void {
		const run = this.liveRun;
		this.liveRun = undefined;
		run?.controller.abort();
	}
	public setLive(enabled: boolean): void {
		if (enabled && !this.enabled) throw new Error("请先执行 /voice on");
		this.live = enabled;
		if (!enabled) {
			// 关闭 Live 时：不粗暴 abort 当前正在录音或正在转写的请求，允许当前正在说的这句顺利完成并出字！
			this.footer();
		} else {
			this.resumeLive();
			this.footer();
		}
	}
	public stop(disable = false): void {
		if (disable) this.enabled = false;
		this.live = false;
		this.generationEpoch++;
		this.suspendLive();
		const task = this.active;
		this.active = undefined;
		task?.controller.abort();
		for (const controller of this.auxiliary) controller.abort();
		this.auxiliary.clear();
		this.initialization = undefined;
		if (this.toastTimer) {
			clearTimeout(this.toastTimer);
			this.toastTimer = undefined;
			try { this.context?.ui?.setWidget?.("voice-toast", undefined); } catch {}
		}
		// No network cleanup behind the audio mutex, no global stop endpoint.
		if (disable) this.tools();
		this.footer();
	}
	public enable(): void {
		const changed = !this.enabled;
		this.enabled = true;
		this.tools();
		this.footer();
		if (changed) this.initializeVoices();
	}
	public start(ctx: ExtensionContext): void {
		this.attach(ctx);
		this.stop(true);
		try { if (this.config.get().defaultEnabled) this.enable(); }
		catch (error) { this.notify(errorText(error), "error"); }
	}
	private initializeVoices(): void {
		try {
			const cfg = this.config.get();
			if ((cfg.voicesCacheByGateway[cfg.gatewayUrl] ?? null) !== null) return;
			const item = { epoch: this.generationEpoch, url: cfg.gatewayUrl, promise: this.listVoices({}) };
			this.initialization = item;
			void item.promise.finally(() => { if (this.initialization === item) this.initialization = undefined; });
		} catch (error) { this.notify(errorText(error), "warning"); }
	}
	private begin(kind: AudioTask["kind"], signal?: AbortSignal): AudioTask {
		if (!this.enabled) throw new Error("disabled");
		checkSignal(signal);
		if (this.active) throw new Error("busy");
		const config = structuredClone(this.config.get());
		const task: AudioTask = {
			id: randomUUID(), epoch: this.generationEpoch, kind, controller: new AbortController(),
			gateway: this.gateway(config.gatewayUrl), config,
		};
		this.active = task;
		// Request-boundary handoff: discard the entire background request. Do not
		// pretend the polling API exposes a speech-onset event or reuse its result.
		this.suspendLive();
		this.footer();
		return task;
	}
	private isCurrent(task: AudioTask): boolean {
		return this.active === task && task.epoch === this.generationEpoch && this.enabled && !task.controller.signal.aborted;
	}
	private finish(task: AudioTask): void {
		if (this.active !== task) return; // Old finally must NEVER unlock a newer task.
		this.active = undefined;
		task.controller.abort(); // Release any remaining local waits/listeners.
		this.footer();
		if (task.epoch === this.generationEpoch && this.enabled && this.live) this.resumeLive();
	}
	private linkSignal(task: AudioTask, signal?: AbortSignal): () => void {
		const cancel = () => task.controller.abort();
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
		return () => signal?.removeEventListener("abort", cancel);
	}
	private failure(error: unknown): { reason: string; message: string } {
		const reason = errorText(error);
		return { reason: reason === "busy" || reason === "disabled" ? reason : "gateway_error",
			message: reason === "busy" ? "Audio channel busy: another audio tool is active." :
				reason === "disabled" ? "语音扩展已关闭；用户可执行 /voice on" : reason };
	}
	public async speak(params: VoiceSpeakParams, signal?: AbortSignal): Promise<VoiceSpeakResult> {
		let task: AudioTask;
		try { task = this.begin("speak", signal); }
		catch (error) { return signal?.aborted ? { status: "cancelled", message: "发音已被取消" } : { status: "error", ...this.failure(error) }; }
		const unlink = this.linkSignal(task, signal);
		let expired = false;
		const timer = setTimeout(() => { expired = true; task.controller.abort(); }, 120000);
		try {
			if (!params.text.trim()) throw new Error("发音文本不能为空");
			await abortable(task.gateway.speak(params.text, {
				voiceId: params.voice_id ?? task.config.defaultVoiceId, instruct: params.instruct,
				speed: params.speed ?? task.config.speed, signal: task.controller.signal,
			}), task.controller.signal);
			if (!this.isCurrent(task)) throw abortError();
			await delay(150, task.controller.signal);
			if (!this.isCurrent(task)) throw abortError();
			return { status: "success", message: "播放及残响保护结束" };
		} catch (error) {
			if (expired && this.active === task && task.epoch === this.generationEpoch && this.enabled) {
				return { status: "error", reason: "deadline_exceeded", message: "发音总等待超时，已取消自身任务；不要自动重试" };
			}
			if (!this.isCurrent(task)) return { status: "cancelled", message: "发音已被取消" };
			return { status: "error", reason: errorText(error) === UNSUPPORTED_SPEAKER ? "incompatible_gateway" : "gateway_error", message: errorText(error) };
		} finally { clearTimeout(timer); unlink(); this.finish(task); }
	}
	public async listen(params: VoiceListenParams, signal?: AbortSignal): Promise<VoiceListenResult> {
		let task: AudioTask;
		try { task = this.begin("listen", signal); }
		catch (error) {
			if (signal?.aborted) return { status: "cancelled", text: "", message: "收音已被用户取消" };
			const failure = this.failure(error);
			return { status: "error", text: "", message: failure.message,
				...(failure.reason === "busy" || failure.reason === "disabled" ? { reason: failure.reason } : {}) };
		}
		const unlink = this.linkSignal(task, signal);
		const timeout = Math.max(3, Math.min(60, params.timeout_sec ?? 15));
		let expired = false;
		const timer = setTimeout(() => { expired = true; task.controller.abort(); }, timeout * 1000);
		this.notify(`🎙️ ${params.prompt || "请说出这一次答复"}（${timeout}s 总时限）`);
		try {
			const result = await abortable(task.gateway.recordAndTranscribe({ maxDurationSec: timeout, signal: task.controller.signal }), task.controller.signal);
			if (!this.isCurrent(task)) throw abortError();
			if (!result.text.trim()) return { status: "timeout", reason: "deadline_exceeded", text: "", message: "本次未获得有效转写；无法判断是否已说话" };
			return { status: "success", text: result.text.trim(), duration_ms: result.durationMs };
		} catch (error) {
			if (expired && this.active === task && task.epoch === this.generationEpoch && this.enabled) {
				return { status: "timeout", reason: "deadline_exceeded", text: "", message: "收音／转写总等待超时；网关未提供说话起始状态，无法判断是否已说话" };
			}
			if (!this.isCurrent(task)) return { status: "cancelled", text: "", message: "收音已被用户取消" };
			return { status: "error", text: "", message: errorText(error) };
		} finally { clearTimeout(timer); unlink(); this.finish(task); }
	}
	private resumeLive(): void {
		if (!this.enabled || !this.live || this.active || this.liveRun) return;
		const run: LiveRun = { id: randomUUID(), epoch: this.generationEpoch, controller: new AbortController() };
		this.liveRun = run;
		void this.pumpLive(run);
	}
	private liveCurrent(run: LiveRun): boolean {
		return this.liveRun === run && run.epoch === this.generationEpoch && this.enabled && !this.active && !run.controller.signal.aborted;
	}
	private async pumpLive(run: LiveRun): Promise<void> {
		try {
			while (this.liveCurrent(run) && this.live) {
				const cfg = structuredClone(this.config.get());
				const gateway = this.gateway(cfg.gatewayUrl);
				const request = new AbortController();
				const signal = AbortSignal.any([run.controller.signal, request.signal]);
				const timer = setTimeout(() => request.abort(), 20000);
				let result: RecordingResult;
				try {
					result = await abortable(gateway.recordAndTranscribe({ maxDurationSec: 10, silenceTimeoutMs: 1000, signal }), signal);
				} finally { clearTimeout(timer); request.abort(); }

				// 关键契约：只要代次未被 stop/Alt+X 作废，即使用户刚刚在说话后按 F2 关闭了 Live，这次在途录音也必须正常出字！
				if (run.epoch === this.generationEpoch && this.enabled && !run.controller.signal.aborted) {
					if (result.text.trim()) {
						this.deliver(result.text.trim(), cfg.deliveryMode);
					}
				}

				if (!this.live) break; // 若已退出持续模式，交付本句后优雅结束循环
				await delay(100, run.controller.signal);
			}
		} catch (error) {
			if (this.live && run.epoch === this.generationEpoch && !run.controller.signal.aborted) {
				this.live = false;
				this.showToast(`Live 已停止: ${errorText(error)}`);
			}
		} finally {
			if (this.liveRun === run) {
				this.liveRun = undefined;
				this.footer();
			}
		}
	}
	private deliver(text: string, mode: DeliveryMode): void {
		const ctx = this.context;
		if (mode === "editor") {
			if (!ctx?.hasUI) throw new Error("editor 模式需要交互终端；不会自动降级为提交");
			if (typeof ctx.ui.pasteToEditor === "function") {
				const draft = ctx.ui.getEditorText();
				const prefix = draft && !/\s$/.test(draft) ? " " : "";
				ctx.ui.pasteToEditor(prefix + text);
			} else {
				const draft = ctx.ui.getEditorText();
				const newText = draft + (draft && !/\s$/.test(draft) ? " " : "") + text;
				ctx.ui.setEditorText(newText);
			}
			// 在输入框上方靠左底部显示已识别提示，同时触发 TUI 即时重绘刷新输入框！
			this.showToast(`🎙️ 已识别: "${text}"`);
		} else if (ctx?.isIdle()) {
			this.pi.sendUserMessage(text);
			this.showToast(`🎙️ 语音已提交: "${text}"`);
		} else {
			this.pi.sendUserMessage(text, { deliverAs: "followUp" });
			this.showToast(`📥 语音已排队: "${text}"`);
		}
	}
	public async listVoices(params: VoiceListVoicesParams, signal?: AbortSignal): Promise<VoiceListVoicesResult> {
		let cfg: VoiceConfig;
		try { cfg = this.config.get(); }
		catch (error) { return { success: false, default_voice_id: "", voices: [], message: errorText(error) }; }
		const empty = { success: false, default_voice_id: cfg.defaultVoiceId, voices: [] };
		if (!this.enabled) return { ...empty, message: "语音扩展已关闭" };
		if (signal?.aborted) return { ...empty, message: "音色查询已取消" };
		const cached = cfg.voicesCacheByGateway[cfg.gatewayUrl] ?? null;
		if (!params.refresh && cached !== null) return { success: true, default_voice_id: cfg.defaultVoiceId, voices: cached };
		if (!params.refresh && this.initialization?.epoch === this.generationEpoch && this.initialization.url === cfg.gatewayUrl) {
			try { return signal ? await abortable(this.initialization.promise, signal) : await this.initialization.promise; }
			catch { return { ...empty, message: "音色查询已取消" }; }
		}
		const controller = new AbortController();
		const epoch = this.generationEpoch;
		this.auxiliary.add(controller);
		const deadline = new AbortController();
		const timer = setTimeout(() => deadline.abort(), 3000);
		const combined = AbortSignal.any([controller.signal, deadline.signal, ...(signal ? [signal] : [])]);
		try {
			const voices = await abortable(this.gateway(cfg.gatewayUrl).getVoices(combined), combined);
			if (!this.enabled || epoch !== this.generationEpoch) throw abortError();
			try {
				await this.config.update(current => ({ ...current, voicesCacheByGateway: { ...current.voicesCacheByGateway, [cfg.gatewayUrl]: voices } }), combined);
			} catch (error) {
				checkSignal(combined);
				return { success: true, default_voice_id: cfg.defaultVoiceId, voices, warning: `目录获取成功，但持久化失败: ${errorText(error)}` };
			}
			checkSignal(combined);
			if (!this.enabled || epoch !== this.generationEpoch) throw abortError();
			return { success: true, default_voice_id: cfg.defaultVoiceId, voices };
		} catch (error) {
			if (controller.signal.aborted || signal?.aborted || epoch !== this.generationEpoch) return { ...empty, message: "音色查询已取消" };
			return cached === null ? { ...empty, message: `无可用音色缓存: ${errorText(error)}` } :
				{ success: true, default_voice_id: cfg.defaultVoiceId, voices: cached, warning: `刷新失败，展示历史缓存: ${errorText(error)}` };
		} finally { clearTimeout(timer); controller.abort(); deadline.abort(); this.auxiliary.delete(controller); }
	}
	public openStatusModal(ctx: ExtensionContext): void {
		this.attach(ctx);
		const cfg = this.config.get();
		const info: VoiceStatusModalInfo = {
			enabled: this.enabled,
			live: this.live,
			activeTool: this.active?.kind ?? null,
			gatewayUrl: cfg.gatewayUrl,
			deliveryMode: cfg.deliveryMode,
			defaultVoiceId: cfg.defaultVoiceId,
			speed: cfg.speed,
			speakerSupported: true, // Connected to running gateway CosyVoice
		};

		if (!ctx.hasUI || !ctx.ui?.custom) {
			this.notify(
				`Voice: ${info.enabled ? "ON" : "OFF"}\nLive: ${info.live ? "ON" : "OFF"}\nGateway: ${info.gatewayUrl}\nMode: ${info.deliveryMode}\nVoice: ${info.defaultVoiceId}\n发音: ${UNSUPPORTED_SPEAKER}\n快捷键: F2 / Alt+X`,
				"info",
			);
			return;
		}

		ctx.ui.custom(
			(tui: any, theme: any, _keybindings: any, done: (result: unknown) => void) => {
				return new VoiceStatusModalComponent(tui, theme, info, () => done(undefined));
			},
			{
				overlay: true,
				overlayOptions: {
					width: "100%",
					maxHeight: "100%",
					anchor: "top-left",
					margin: 0,
				},
			},
		).catch((err: unknown) => {
			console.error("[voice] status modal error:", err);
		});
	}

	public async command(args: string, ctx: ExtensionContext): Promise<void> {
		this.attach(ctx);
		const raw = args.trim();
		const [rawAction = "status", param] = raw.split(/\s+/);
		const action = rawAction.toLowerCase() || "status";
		try {
			switch (action) {
				case "on": this.enable(); this.notify("语音工具已启用；Live 需单独开启。当前网关发音协议不兼容，详见 /voice status", "warning"); break;
				case "off": this.stop(true); this.notify("语音已关闭，后续新调用将拒绝"); break;
				case "stop": this.stop(); this.notify("现有活动已取消；扩展开关不变，开启时仍接受新调用"); break;
				case "live":
					if (param && param !== "on" && param !== "off") throw new Error("用法: /voice live [on|off]");
					this.setLive(param ? param === "on" : !this.live);
					this.notify(`Live: ${this.live ? "ON（请求边界交接可能丢弃当前半句）" : "OFF"}`);
					break;
				case "mode":
					if (param !== "editor" && param !== "submit") throw new Error("用法: /voice mode editor|submit");
					await this.config.update(current => ({ ...current, deliveryMode: param }));
					this.notify(`投递模式已更新: ${param}`); break;
				case "set-voice": {
					const voiceArg = raw.slice(rawAction.length).trim();
					if (!voiceArg) throw new Error("用法: /voice set-voice <音色名称或ID>");
					const cfg = this.config.get();
					const voices = cfg.voicesCacheByGateway[cfg.gatewayUrl] || [];
					// 优先精确匹配名称或 ID，次选忽略大小写匹配，再次选子串模糊匹配
					let matched = voices.find(v => v.name === voiceArg || v.id === voiceArg);
					if (!matched) {
						matched = voices.find(v => v.name.toLowerCase() === voiceArg.toLowerCase() || v.id.toLowerCase() === voiceArg.toLowerCase());
					}
					if (!matched) {
						matched = voices.find(v => v.name.toLowerCase().includes(voiceArg.toLowerCase()) || v.id.toLowerCase().includes(voiceArg.toLowerCase()));
					}
					const targetId = matched ? matched.id : voiceArg;
					const displayName = matched ? `${matched.name} (${matched.id})` : targetId;
					await this.config.update(current => ({ ...current, defaultVoiceId: targetId }));
					this.notify(`默认音色已保存: ${displayName}`); break;
				}
				case "voices": {
					const result = await this.listVoices({});
					this.notify(result.success ? [result.warning, `默认: ${result.default_voice_id}`, ...result.voices.map(v => `${v.id}: ${v.name}`)].filter(Boolean).join("\n") : result.message || "查询失败", result.success && !result.warning ? "info" : "warning");
					break;
				}
				case "status": {
					this.openStatusModal(ctx);
					break;
				}
				default: throw new Error("用法: /voice on|off|stop|live|mode|set-voice|voices|status");
			}
		} catch (error) { this.notify(errorText(error), "error"); }
	}
}

function toolResult<T extends object>(details: T) {
	return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}
const VOICE_SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "status", label: "status", description: "打开语音配置与状态模态窗" },
	{ value: "on", label: "on", description: "启用语音扩展" },
	{ value: "off", label: "off", description: "关闭语音扩展" },
	{ value: "stop", label: "stop", description: "立即停止当前语音活动（播报或收音）" },
	{ value: "live", label: "live", description: "持续收音模式开关 (live on | live off)" },
	{ value: "mode", label: "mode", description: "转写投递模式 (mode editor | mode submit)" },
	{ value: "voices", label: "voices", description: "列出当前网关可用音色" },
	{ value: "set-voice", label: "set-voice", description: "设置默认音色 (用法: /voice set-voice <id>)" },
];

export function getVoiceArgumentCompletions(
	argumentPrefix: string,
	runtime?: VoiceRuntime,
): AutocompleteItem[] | null {
	const prefix = (argumentPrefix || "").trimStart();

	if (prefix.startsWith("live")) {
		const sub = prefix.slice(4).trimStart().toLowerCase();
		const options: AutocompleteItem[] = [
			{ value: "live on", label: "on", description: "开启持续语音输入模式" },
			{ value: "live off", label: "off", description: "关闭持续语音输入模式" },
		];
		const filtered = options.filter(
			(o) => o.label.toLowerCase().startsWith(sub) || o.value.toLowerCase().startsWith(prefix.toLowerCase()),
		);
		return filtered.length > 0 ? filtered : options;
	}

	if (prefix.startsWith("mode")) {
		const sub = prefix.slice(4).trimStart().toLowerCase();
		const options: AutocompleteItem[] = [
			{ value: "mode editor", label: "editor", description: "转写结果填入输入框（可编辑后再发送）" },
			{ value: "mode submit", label: "submit", description: "转写结果直接提交给 Agent" },
		];
		const filtered = options.filter(
			(o) => o.label.toLowerCase().startsWith(sub) || o.value.toLowerCase().startsWith(prefix.toLowerCase()),
		);
		return filtered.length > 0 ? filtered : options;
	}

	if (prefix.startsWith("set-voice")) {
		const rawSub = prefix.slice(9).trimStart();
		const sub = rawSub.toLowerCase();
		const options: AutocompleteItem[] = [];
		if (runtime) {
			try {
				const cfg = runtime.getVoiceConfig();
				const voices = cfg.voicesCacheByGateway[cfg.gatewayUrl] || [];
				for (const v of voices) {
					options.push({
						value: `set-voice ${v.name}`,
						label: v.name,
						description: `音色ID: ${v.id}${v.description ? ` · ${v.description}` : ""}`,
					});
				}
			} catch {}
		}
		const filtered = options.filter(
			(o) =>
				o.label.toLowerCase().includes(sub) ||
				o.value.toLowerCase().includes(sub) ||
				(o.description && o.description.toLowerCase().includes(sub)),
		);
		return filtered.length > 0 ? filtered : options.length > 0 ? options : null;
	}

	const filtered = VOICE_SUBCOMMANDS.filter((item) =>
		item.value.toLowerCase().startsWith(prefix.toLowerCase()),
	);
	return filtered.length > 0 ? filtered : null;
}

export default function voiceExtension(pi: ExtensionAPI, options: VoiceRuntimeOptions = {}): void {
	const runtime = new VoiceRuntime(pi, options);
	pi.registerTool({
		name: "voice_speak",
		label: "Voice Speak",
		parameters: VoiceSpeakParamsSchema,
		promptSnippet: "Speak concise, natural text aloud to verbally alert or prompt the user.",
		promptGuidelines: [
			"Call `voice_speak` when you need to verbally alert, prompt, or notify the user (e.g. asking questions, reporting key progress, or completing a task).",
			"Speak naturally like a human: keep it concise and conversational (1-2 sentences). Never read code, logs, paths, or markdown tables directly.",
		],
		description: "Speak natural text aloud to verbally alert or notify the user (e.g. asking questions, completing a task, or flagging issues). Keep it brief and conversational like human speech.",
		async execute(_id, params, signal, _update, ctx) { runtime.attach(ctx); return toolResult(await runtime.speak(params, signal)); },
	});
	pi.registerTool({
		name: "voice_listen",
		label: "Voice Listen",
		parameters: VoiceListenParamsSchema,
		promptSnippet: "Listen for a single spoken voice response ONLY when explicitly requested by the user.",
		promptGuidelines: [
			"Do NOT call `voice_listen` by default. Only call it when the user explicitly requests voice input or asks you to listen to their spoken answer.",
		],
		description: "Record and transcribe a single spoken response from the user. Do NOT call this tool unless the user explicitly requests voice input or asks you to listen.",
		async execute(_id, params, signal, _update, ctx) { runtime.attach(ctx); return toolResult(await runtime.listen(params, signal)); },
	});
	pi.registerTool({
		name: "voice_list_voices",
		label: "Voice List Voices",
		parameters: VoiceListVoicesParamsSchema,
		promptSnippet: "List available TTS voice options from cache or gateway.",
		description: "Query available TTS voices. Prefers local cache; only use when specifically requested or changing voices.",
		async execute(_id, params, signal, _update, ctx) { runtime.attach(ctx); return toolResult(await runtime.listVoices(params, signal)); },
	});
	pi.registerCommand("voice", {
		description: "Voice: on/off/stop/live/mode/set-voice/voices/status",
		getArgumentCompletions: (prefix) => getVoiceArgumentCompletions(prefix, runtime),
		handler: (args, ctx) => runtime.command(args, ctx),
	});
	pi.registerShortcut("alt+x", { description: "取消现有语音活动，保留开关", handler: async ctx => { runtime.attach(ctx); runtime.stop(); } });
	pi.registerShortcut("f2", { description: "切换持续语音输入", handler: ctx => runtime.command("live", ctx) });
	pi.on("session_start", (_event, ctx) => runtime.start(ctx));
	pi.on("session_shutdown", () => runtime.stop(true));
	pi.on("session_before_switch", () => runtime.stop(true));
	pi.on("session_before_fork", () => runtime.stop(true));
}
