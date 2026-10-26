import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { StatusModalComponent } from "./lib/status-modal.ts";
import { ASK_USER_VOICE_PROMPT, isQuestionVoicePrompt, type QuestionVoicePrompt } from "./lib/ask-user-voice.ts";
import { type Static, Type } from "typebox";

import { parseVoices, resolveVoice, VoiceDirectory, voicePage, type VoiceItem } from "./lib/voice-catalog.ts";
import { VoicePickerComponent } from "./lib/voice-picker.ts";
export type { VoiceItem } from "./lib/voice-catalog.ts";
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
	voice_id: Type.Optional(Type.String({ description: "Optional stable ID from voice_list_voices (query it live first); overrides this call only. Routes to the voice's engine. Native voice-library: at most 80 characters, speed=1, no instruct; whole-utterance synthesis remains the default." })),
	instruct: Type.Optional(Type.String({ description: "Optional tone or emotion instruction (e.g. 'cheerful', 'urgent')" })),
	speed: Type.Optional(Type.Number({ minimum: 0.5, maximum: 2 })),
});
export const VoiceListenParamsSchema = Type.Object({
	prompt: Type.Optional(Type.String({ description: "Optional prompt displayed in the UI while listening (not spoken aloud)" })),
	timeout_sec: Type.Optional(Type.Integer({ minimum: 3, maximum: 60, description: "Total timeout for recording and transcription in seconds (default 15)" })),
});
export const VoiceListVoicesParamsSchema = Type.Object({
	query: Type.Optional(Type.String({ maxLength: 256, description: "Search name, stable ID, engine or description; spaces require all terms" })),
	offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based result offset (default 0)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Page size, default 20, maximum 50" })),
	refresh: Type.Optional(Type.Boolean({ description: "Force live refresh; otherwise reuse an in-memory snapshot for at most 5 seconds. Concurrent refreshes coalesce." })),
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
	total?: number;
	matched?: number;
	offset?: number;
	limit?: number;
	has_more?: boolean;
	source?: "live" | "memory" | "cache";
	stale?: boolean;
	checked_at?: string;
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
	private readonly directory: VoiceDirectory;
	constructor(baseUrl: string) {
		this.baseUrl = gatewayKey(baseUrl);
		this.directory = new VoiceDirectory(async signal => ({ voices: parseVoices(await this.json("/api/voices", signal), true) }));
	}
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
		try { await this.getVoices(signal); return { online: true }; }
		catch { return { online: false }; }
	}
	public async getVoices(signal: AbortSignal): Promise<VoiceItem[]> {
		return (await this.directory.get(true, signal)).voices;
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
		const voice = resolveVoice((await this.directory.get(false, options.signal)).voices, options.voiceId);
		checkSignal(options.signal);
		const native = voice.engine === "voice-library";
		if (native && (text.trim().length > 80 || options.speed !== 1 || options.instruct?.trim())) {
			throw new Error("原配方音色每次最多80字，仅支持 speed=1 且不支持 instruct；不会静默修改参数或改用其它引擎");
		}
		const payload: Record<string, unknown> = {
			text,
			engine: voice.engine ?? "cosyvoice",
			voice_id: voice.id,
			...(!native ? { speed: options.speed ?? 1.0 } : {}),
			output_mode: "speaker_playback",
			concurrency: "preempt",
			wait: true,
		};
		if (!native && options.instruct) payload.instruct = options.instruct;

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
			if (!isObject(data) || data.status !== "completed" || data.error || (data.code !== undefined && data.code !== 0)) {
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
	defaultEnabled: boolean;
	live: boolean;
	activeTool: string | null;
	gatewayUrl: string;
	deliveryMode: DeliveryMode;
	defaultVoiceId: string;
	speed: number;
	speakerSupported: boolean;
}

export class VoiceStatusModalComponent implements Component {
	private readonly modal: StatusModalComponent;

	constructor(tui: any, theme: any, info: VoiceStatusModalInfo, onClose: () => void) {
		const mode = info.deliveryMode === "editor" ? "editor (追加至草稿待确认)" : "submit (直接提交/排队)";
		this.modal = new StatusModalComponent(tui, theme, "Pi Voice Extension Status", [
			`• 扩展总开关   : ${info.enabled ? "ENABLED (ON)" : "DISABLED (OFF)"}`,
			`• 新会话默认   : ${info.defaultEnabled ? "ON（不自动开启 Live）" : "OFF"}`,
			`• 持续语音输入 : ${info.live ? "RUNNING (🔴 LIVE ON)" : "STOPPED (⏸ OFF)"}`,
			`• 当前主动活动 : ${info.activeTool ? `BUSY (${info.activeTool})` : "IDLE"}`,
			`• 识别投递模式 : ${mode}`,
			`• 后台网关地址 : ${info.gatewayUrl}`,
			`• 默认发音音色 : ${info.defaultVoiceId} (${info.speed}x 语速)`,
			`• 扬声发音服务 : ${info.speakerSupported ? "按目录引擎路由（未探测连接）" : "INCOMPATIBLE (已保护阻断)"}`,
			"• 发音风险     : 全局抢占/停播，未确认物理播放完成（VOICE-001）",
			"• 参数命令     : /voice voice | speed | gateway | default | mode",
			"• 完整帮助     : /voice help",
			"• 全局快捷键   : F2 (持续输入切换) | Alt+X (紧急停播/停录)",
		], onClose, { maxWidth: 74, maxHeight: 20, center: true });
	}

	invalidate(): void { this.modal.invalidate(); }
	render(width: number): string[] { return this.modal.render(width); }
	handleInput(data: string): void { this.modal.handleInput(data); }
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.modal.handleMouse(event); }
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
	private readonly directories = new Map<string, VoiceDirectory>();
	private completionGateway?: { url: string; expires: number };
	private initialization?: { epoch: number; url: string; promise: Promise<VoiceListVoicesResult> };
	private questionSpeech: Promise<void> = Promise.resolve();

	private toastTimer?: NodeJS.Timeout;
	private footerTimer?: NodeJS.Timeout;

	constructor(pi: ExtensionAPI, options: VoiceRuntimeOptions = {}) {
		this.pi = pi;
		this.config = options.config ?? new VoiceConfigManager();
		const adapters = new Map<string, TtsGatewayAdapter>();
		this.gateway = options.gateway ?? (url => {
			let adapter = adapters.get(url);
			if (!adapter) { adapter = new TtsGatewayAdapter(url); adapters.set(url, adapter); }
			return adapter;
		});
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
		for (const directory of this.directories.values()) directory.clear();
		this.directories.clear();
		this.completionGateway = undefined;
		this.initialization = undefined;
		if (this.toastTimer) {
			clearTimeout(this.toastTimer);
			this.toastTimer = undefined;
			try { this.context?.ui?.setWidget?.("voice-toast", undefined); } catch {}
		}
		if (this.footerTimer) {
			clearTimeout(this.footerTimer);
			this.footerTimer = undefined;
		}
		// Local state is invalidated synchronously. The HTTP speak adapter still
		// issues global playback stop on abort (deferred risk VOICE-001).
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
	/** Best-effort questionnaire reminder. Never blocks the dialog or opens a microphone. */
	public promptQuestion(prompt: QuestionVoicePrompt): void {
		if (!this.enabled || prompt.signal.aborted) return;
		const epoch = this.generationEpoch;
		// Serialize our own reminders so a new dialog cannot race the previous one's abort cleanup.
		// Explicit audio tools retain their existing busy semantics; do not interrupt or retry them.
		this.questionSpeech = this.questionSpeech.then(async () => {
			if (!this.enabled || epoch !== this.generationEpoch || prompt.signal.aborted) return;
			const result = await this.speak({ text: prompt.text }, prompt.signal);
			if (result.status === "error" && this.enabled && epoch === this.generationEpoch && !prompt.signal.aborted) {
				this.showToast(`问题语音提醒未播放：${result.message}`);
			}
		}).catch(() => { /* A reminder failure must not affect question/answer delivery. */ });
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
			return { status: "success", message: "音频已提交网关；尚未确认扬声器物理播放完成（VOICE-001）" };
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
	private directory(url: string): VoiceDirectory {
		let directory = this.directories.get(url);
		if (!directory) {
			directory = new VoiceDirectory(async signal => {
				const epoch = this.generationEpoch;
				const voices = await this.gateway(url).getVoices(signal);
				checkSignal(signal);
				if (epoch !== this.generationEpoch || this.config.get().gatewayUrl !== url) throw abortError();
				let warning: string | undefined;
				try {
					if (JSON.stringify(this.config.get().voicesCacheByGateway[url]) !== JSON.stringify(voices)) {
						await this.config.update(current => {
							checkSignal(signal);
							if (epoch !== this.generationEpoch || current.gatewayUrl !== url) throw abortError();
							return { ...current, voicesCacheByGateway: { ...current.voicesCacheByGateway, [url]: voices } };
						}, signal);
					}
				} catch (error) { checkSignal(signal); if (epoch !== this.generationEpoch || this.config.get().gatewayUrl !== url) throw abortError(); warning = `目录获取成功，但持久化失败: ${errorText(error)}`; }
				return { voices, warning };
			});
			this.directories.set(url, directory);
		}
		return directory;
	}
	/** Autocomplete reuses the indexed snapshot; no per-key config reads or HTTP. */
	public async voiceCompletions(command: string, query: string): Promise<AutocompleteItem[] | null> {
		try {
			if (!this.completionGateway || this.completionGateway.expires < Date.now()) this.completionGateway = { url: this.config.get().gatewayUrl, expires: Date.now() + 5000 };
			const snapshot = await this.directory(this.completionGateway.url).get();
			const voices = voicePage(snapshot.voices, { query, limit: 20 }, snapshot.index).voices;
			return voices.length ? voices.map(v => ({ value: `${command} ${v.id}`, label: `${v.name} · ${v.id}`, description: `${v.engine ?? "引擎未知"}${v.ready === false ? " · 未就绪" : ""}` })) : null;
		} catch { return null; }
	}
	public async listVoices(params: VoiceListVoicesParams, signal?: AbortSignal, allowDisabled = false): Promise<VoiceListVoicesResult> {
		let cfg: VoiceConfig;
		try { cfg = this.config.get(); voicePage([], params); }
		catch (error) { return { success: false, default_voice_id: "", voices: [], message: errorText(error) }; }
		const empty = { success: false, default_voice_id: cfg.defaultVoiceId, voices: [] };
		if (!this.enabled && !allowDisabled) return { ...empty, message: "语音扩展已关闭" };
		if (signal?.aborted) return { ...empty, message: "音色查询已取消" };
		const epoch = this.generationEpoch;
		const directory = this.directory(cfg.gatewayUrl);
		const before = directory.peek();
		try {
			const snapshot = await directory.get(params.refresh, signal);
			if (epoch !== this.generationEpoch) throw abortError();
			return { success: true, default_voice_id: this.config.get().defaultVoiceId, ...voicePage(snapshot.voices, params, snapshot.index), source: snapshot === before ? "memory" : "live", stale: false, checked_at: new Date(snapshot.checkedAt).toISOString(), ...(snapshot.warning ? { warning: snapshot.warning } : {}) };
		} catch (error) {
			if (signal?.aborted || epoch !== this.generationEpoch) return { ...empty, message: "音色查询已取消" };
			const cached = cfg.voicesCacheByGateway[cfg.gatewayUrl] ?? null;
			return cached === null ? { ...empty, message: `无可用音色缓存: ${errorText(error)}` } : { success: true, default_voice_id: cfg.defaultVoiceId, ...voicePage(cached, params), source: "cache", stale: true, warning: `刷新失败，展示历史缓存，不能据此保存选择或确认可用: ${errorText(error)}` };
		}
	}
	private async selectVoice(argument: string, ctx: ExtensionContext): Promise<void> {
		const cfg = this.config.get();
		const epoch = this.generationEpoch;
		const snapshot = await this.directory(cfg.gatewayUrl).get(true);
		const exactIds = snapshot.voices.filter(v => v.id.toLowerCase() === argument.toLowerCase());
		const exactNames = snapshot.voices.filter(v => v.name.toLowerCase() === argument.toLowerCase());
		let id: string | undefined;
		let interactive = false;
		if (argument && exactIds.length === 1) id = exactIds[0].id;
		else if (argument && exactNames.length === 1) id = exactNames[0].id;
		else {
			if (!ctx.hasUI || ctx.mode === "rpc" || !ctx.ui?.custom) {
				const matches = voicePage(snapshot.voices, { query: argument, limit: 10 }, snapshot.index);
				throw new Error(`请指定唯一音色 ID；匹配 ${matches.matched} 项: ${matches.voices.map(v => `${v.id} (${v.name})`).join(", ")}`);
			}
			interactive = true;
			id = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => new VoicePickerComponent(snapshot.voices, argument, theme, () => tui.requestRender(), done, Math.min(10, Math.max(2, (tui.terminal.rows || 24) - 8))), { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%" } });
			if (!id) return;
		}
		// Recheck after an interactive wait; never trust stale/offline choices.
		if (epoch !== this.generationEpoch) throw abortError();
		if (this.config.get().gatewayUrl !== cfg.gatewayUrl) throw new Error("网关已变更，请重新选择音色");
		const latest = interactive ? await this.directory(cfg.gatewayUrl).get(true) : snapshot;
		const voice = resolveVoice(latest.voices, id);
		await this.config.update(current => {
			if (epoch !== this.generationEpoch) throw abortError();
			if (current.gatewayUrl !== cfg.gatewayUrl) throw new Error("网关已变更，请重新选择音色");
			return { ...current, defaultVoiceId: voice.id };
		});
		this.notify(`默认音色已保存: ${voice.name} (${voice.id}, ${voice.engine ?? "cosyvoice"})；仅后续请求生效，语音开关及当前句不变`);
	}
	public openStatusModal(ctx: ExtensionContext): void {
		this.attach(ctx);
		const cfg = this.config.get();
		const info: VoiceStatusModalInfo = {
			enabled: this.enabled,
			defaultEnabled: cfg.defaultEnabled,
			live: this.live,
			activeTool: this.active?.kind ?? null,
			gatewayUrl: cfg.gatewayUrl,
			deliveryMode: cfg.deliveryMode,
			defaultVoiceId: cfg.defaultVoiceId,
			speed: cfg.speed,
			speakerSupported: true, // Adapter supports the protocol; status does not probe the gateway.
		};

		if (!ctx.hasUI || ctx.mode === "rpc" || !ctx.ui?.custom) {
			const text = `Voice: ${info.enabled ? "ON" : "OFF"}\nDefault: ${info.defaultEnabled ? "ON" : "OFF"}\nLive: ${info.live ? "ON" : "OFF"}\nGateway: ${info.gatewayUrl}\nMode: ${info.deliveryMode}\nVoice: ${info.defaultVoiceId}\nSpeed: ${info.speed}x\n连接状态: 未探测\n发音风险: 全局抢占/停播，未确认物理播放完成（VOICE-001）\n帮助: /voice help\n快捷键: F2 / Alt+X`;
			if (ctx.hasUI) ctx.ui?.notify?.(text, "info");
			else console.log(text);
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

	private async showInfo(ctx: ExtensionContext, title: string, lines: string[]): Promise<void> {
		if (!ctx.hasUI || ctx.mode === "rpc" || !ctx.ui?.custom) {
			if (ctx.hasUI) ctx.ui.notify(`${title}\n${lines.join("\n")}`, "info");
			else console.log(`${title}\n${lines.join("\n")}`);
			return;
		}
		await ctx.ui.custom<void>((tui, theme, _keys, done) =>
			new StatusModalComponent(tui, theme, title, lines, () => done(), { maxWidth: 84, maxHeight: 22, center: true }),
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } },
		);
	}

	public async command(args: string, ctx: ExtensionContext): Promise<void> {
		this.attach(ctx);
		const raw = args.trim();
		const [rawAction = "status", param, extra] = raw.split(/\s+/);
		const action = rawAction.toLowerCase() || "status";
		try {
			switch (action) {
				case "on": this.enable(); this.notify("语音工具已启用；Live 需单独开启。共享网关存在全局停播风险，详见 /voice status"); break;
				case "off": this.stop(true); this.notify("语音已关闭，后续新调用将拒绝"); break;
				case "stop": this.stop(); this.notify("现有活动已取消；扩展开关不变，开启时仍接受新调用"); break;
				case "live":
					if (param && param !== "on" && param !== "off") throw new Error("用法: /voice live [on|off]");
					this.setLive(param ? param === "on" : !this.live);
					this.notify(`Live: ${this.live ? "ON（请求边界交接可能丢弃当前半句）" : "OFF"}`);
					break;
				case "speed": {
					if (!param) { this.openStatusModal(ctx); break; }
					const speed = Number(param);
					if (extra || !Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error("用法: /voice speed <0.5–2>");
					await this.config.update(current => ({ ...current, speed }));
					this.notify(`语速已保存: ${speed}x（后续发音生效）`); break;
				}
				case "gateway": {
					if (!param) { this.openStatusModal(ctx); break; }
					if (extra) throw new Error("用法: /voice gateway <HTTP(S) URL>");
					const url = gatewayKey(param);
					await this.config.update(current => ({ ...current, gatewayUrl: url }));
					this.stop();
					if (this.enabled) this.initializeVoices();
					this.notify("网关地址已保存，旧语音任务及 Live 已停止；总开关不变"); break;
				}
				case "default":
					if (!param) { this.openStatusModal(ctx); break; }
					if (extra || (param !== "on" && param !== "off")) throw new Error("用法: /voice default on|off");
					await this.config.update(current => ({ ...current, defaultEnabled: param === "on" }));
					this.notify(`新会话默认开关已保存: ${param.toUpperCase()}（当前开关及 Live 不变）`); break;
				case "mode":
					if (param !== "editor" && param !== "submit") throw new Error("用法: /voice mode editor|submit");
					await this.config.update(current => ({ ...current, deliveryMode: param }));
					this.notify(`投递模式已更新: ${param}`); break;
				case "voice":
				case "set-voice":
					await this.selectVoice(raw.slice(rawAction.length).trim(), ctx); break;
				case "voices": {
					const result = await this.listVoices({ query: raw.slice(rawAction.length).trim(), refresh: true }, undefined, true);
					await this.showInfo(ctx, "Voice 音色目录", result.success
						? [result.warning, `默认: ${result.default_voice_id} · 匹配 ${result.matched}/${result.total} · 本页 ${result.voices.length} 项`, ...result.voices.map(v => `${v.id}: ${v.name} · ${v.engine ?? "引擎未知"}${v.ready === false ? " · 未就绪" : ""}`), "更多：/voice voice [关键词] 搜索选择；工具 voice_list_voices 支持 offset/limit 分页"].filter((line): line is string => Boolean(line))
						: [result.message || "查询失败"]);
					break;
				}
				case "status": {
					this.openStatusModal(ctx);
					break;
				}
				case "help":
					await this.showInfo(ctx, "Voice 命令帮助", VOICE_HELP);
					break;
				default: throw new Error("未知语音命令；用 /voice help 查看用法");
			}
		} catch (error) { this.notify(errorText(error), "error"); }
	}
}

function toolResult<T extends { status?: string; success?: boolean }>(details: T) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(details) }], details,
		...(details.status === "error" || details.success === false ? { isError: true } : {}),
	};
}
const VOICE_HELP = [
	"/voice 或 /voice status — 查看当前开关、默认开关及全部参数（不探测网关）",
	"/voice on | off — 仅启用/禁用当前会话；off 同时取消现有语音任务",
	"/voice stop — 取消当前任务并关闭 Live，保留当前总开关；快捷键 Alt+X",
	"/voice live [on|off] — 切换持续收音；快捷键 F2；需先 on",
	"/voice mode editor|submit — 转写填入草稿或直接发送（持久化）",
	"/voice voice [ID或关键词] — 实时搜索选择默认音色；不自动开启语音或试听",
	"/voice set-voice [ID或关键词] — 兼容入口，同上；Esc 不更改配置",
	"/voice voices [关键词] — 实时查询，最多展示20项；工具可用 offset/limit 分页",
	"/voice speed <0.5–2> — 保存默认语速；仅影响后续发音",
	"/voice gateway <HTTP(S) URL> — 保存网关并取消旧任务/Live；总开关不变",
	"/voice default on|off — 保存新会话默认开关；当前开关不变，不自动开启 Live",
	"speed / gateway / default 不带参数时打开状态窗；参数保存到 agent 目录的 voice.json",
	"发音风险 VOICE-001：取消可能全局停播，无法确认物理播放完成；共享网关请谨慎",
];
const VOICE_SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "help", label: "help", description: "查看全部语音命令与参数说明" },
	{ value: "speed", label: "speed", description: "保存默认语速 (speed 0.5–2)；无参数查看状态" },
	{ value: "gateway", label: "gateway", description: "保存 HTTP(S) 网关地址，停止旧任务及 Live" },
	{ value: "default", label: "default", description: "新会话默认开关 (default on | default off)，当前会话不变" },
	{ value: "status", label: "status", description: "打开语音配置与状态模态窗" },
	{ value: "on", label: "on", description: "启用语音扩展" },
	{ value: "off", label: "off", description: "关闭语音扩展" },
	{ value: "stop", label: "stop", description: "立即停止当前语音活动（播报或收音）" },
	{ value: "live", label: "live", description: "持续收音模式开关 (live on | live off)" },
	{ value: "mode", label: "mode", description: "转写投递模式 (mode editor | mode submit)" },
	{ value: "voice", label: "voice", description: "实时搜索选择默认音色；不启用语音、不自动试听" },
	{ value: "voices", label: "voices", description: "实时查询目录 (voices [关键词])；最多20项" },
	{ value: "set-voice", label: "set-voice", description: "设置默认音色 (用法: /voice set-voice <id>)" },
];

export function getVoiceArgumentCompletions(
	argumentPrefix: string,
	runtime?: VoiceRuntime,
): AutocompleteItem[] | null | Promise<AutocompleteItem[] | null> {
	const prefix = (argumentPrefix || "").trimStart();

	const toggleCommand = prefix.startsWith("default") ? "default" : "live";
	if (prefix.startsWith(toggleCommand)) {
		const sub = prefix.slice(toggleCommand.length).trimStart().toLowerCase();
		const options: AutocompleteItem[] = [
			{ value: `${toggleCommand} on`, label: "on", description: toggleCommand === "live" ? "开启持续语音输入模式" : "保存新会话默认开启（不自动录音）" },
			{ value: `${toggleCommand} off`, label: "off", description: toggleCommand === "live" ? "关闭持续语音输入模式" : "保存新会话默认关闭" },
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

	const selection = /^(voice|set-voice)(?:\s+|$)/.exec(prefix);
	if (selection) return runtime?.voiceCompletions(selection[1], prefix.slice(selection[0].length)) ?? null;

	const filtered = VOICE_SUBCOMMANDS.filter((item) =>
		item.value.toLowerCase().startsWith(prefix.toLowerCase()),
	);
	return filtered.length > 0 ? filtered : null;
}

export default function voiceExtension(pi: ExtensionAPI, options: VoiceRuntimeOptions = {}): void {
	const runtime = new VoiceRuntime(pi, options);
	pi.events.on(ASK_USER_VOICE_PROMPT, data => {
		if (isQuestionVoicePrompt(data)) runtime.promptQuestion(data);
	});
	pi.registerTool({
		name: "voice_speak",
		label: "Voice Speak",
		parameters: VoiceSpeakParamsSchema,
		promptSnippet: "Speak concise, natural text aloud to verbally alert or prompt the user.",
		promptGuidelines: [
			"Call `voice_speak` when you need to verbally alert, prompt, or notify the user (e.g. asking questions, reporting key progress, or completing a task). For `ask_user_question`, use its `voice_prompt` instead: it automatically speaks when voice is enabled, so do not duplicate it with `voice_speak`.",
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
		description: "Query the live TTS catalog before choosing a voice. Search with query and page with offset/limit (20 default, 50 max); a 5-second snapshot reduces traffic. Cache-only fallback is explicitly stale and does not confirm availability. Only use when requested or changing voices.",
		async execute(_id, params, signal, _update, ctx) { runtime.attach(ctx); return toolResult(await runtime.listVoices(params, signal)); },
	});
	pi.registerCommand("voice", {
		description: "Voice: status/help/on/off/stop/live/mode/set-voice/voices/speed/gateway/default",
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
