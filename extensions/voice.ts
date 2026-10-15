import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
	text: Type.String({ minLength: 1, description: "精炼口语文本，不要朗读大段代码或表格" }),
	voice_id: Type.Optional(Type.String({ description: "不传则使用持久化默认音色；无目录时按需调用 voice_list_voices" })),
	instruct: Type.Optional(Type.String({ description: "可选的语气指导" })),
	speed: Type.Optional(Type.Number({ minimum: 0.5, maximum: 2 })),
});
export const VoiceListenParamsSchema = Type.Object({
	prompt: Type.Optional(Type.String({ description: "仅显示在终端，不自动朗读" })),
	timeout_sec: Type.Optional(Type.Integer({ minimum: 3, maximum: 60, description: "收音和转写的总时限，默认 15 秒" })),
});
export const VoiceListVoicesParamsSchema = Type.Object({
	refresh: Type.Optional(Type.Boolean({ description: "默认使用缓存；无缓存时获取，仅确需更新时强制刷新" })),
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

/** Cross-process read/merge/replace. Failure to acquire the lock NEVER permits a write. */
export class VoiceConfigManager implements VoiceConfigStore {
	private readonly directory: string;
	private readonly configPath: string;
	private readonly lockPath: string;
	private readonly lockTimeoutMs: number;

	constructor(customDir = join(homedir(), ".pi"), lockTimeoutMs = 2000) {
		this.directory = customDir;
		this.configPath = join(customDir, "voice.json");
		this.lockPath = join(customDir, "voice.json.lock");
		this.lockTimeoutMs = lockTimeoutMs;
	}
	public get(): VoiceConfig {
		try {
			return parseConfig(JSON.parse(readFileSync(this.configPath, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
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
	recordAndTranscribe(options: { maxDurationSec: number; signal: AbortSignal }): Promise<RecordingResult>;
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
	public async recordAndTranscribe(options: { maxDurationSec: number; signal: AbortSignal }): Promise<RecordingResult> {
		const data = await this.json("/api/v1/input/record-and-transcribe", options.signal, {
			max_duration_sec: options.maxDurationSec, silence_timeout_ms: 1200,
		});
		if (!isObject(data) || data.code !== 0 || typeof data.text !== "string" ||
			(data.duration_ms !== undefined && (typeof data.duration_ms !== "number" || !Number.isFinite(data.duration_ms) || data.duration_ms < 0))) {
			throw new Error(isObject(data) && typeof data.error === "string" ? data.error : "无效或失败的录音转写响应");
		}
		return { text: data.text.trim(), durationMs: typeof data.duration_ms === "number" ? data.duration_ms : 0 };
	}
	public async speak(_text: string, options: { voiceId: string; instruct?: string; speed: number; signal: AbortSignal }): Promise<never> {
		checkSignal(options.signal);
		// The current API's wait=true acknowledges PCM enqueue, not speaker drain.
		// /playback/control ignores task_id. No unsafe fallback or guessed capability.
		throw new Error(UNSUPPORTED_SPEAKER);
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

	constructor(pi: ExtensionAPI, options: VoiceRuntimeOptions = {}) {
		this.pi = pi;
		this.config = options.config ?? new VoiceConfigManager();
		this.gateway = options.gateway ?? (url => new TtsGatewayAdapter(url));
	}
	public attach(ctx: ExtensionContext): void { this.context = ctx; }
	private notify(message: string, level: "info" | "warning" | "error" = "info"): void {
		if (this.context?.hasUI) this.context.ui.notify(message, level);
	}
	private footer(): void {
		if (this.context?.hasUI) this.context.ui.setStatus("voice", !this.enabled ? "Voice: OFF" :
			`Voice: ON | Live: ${this.live ? "ON" : "OFF"}${this.active ? ` | ${this.active.kind}` : ""}`);
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
		// Listen has its OWN request; live off never cancels a listen.
		if (!enabled) this.suspendLive();
		else this.resumeLive();
		this.footer();
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
		return this.liveRun === run && run.epoch === this.generationEpoch && this.enabled && this.live && !this.active && !run.controller.signal.aborted;
	}
	private async pumpLive(run: LiveRun): Promise<void> {
		try {
			while (this.liveCurrent(run)) {
				// Freeze gateway and delivery mode for this whole request, never read
				// preferences midway and never redirect a cancelled result to listen.
				const cfg = structuredClone(this.config.get());
				const gateway = this.gateway(cfg.gatewayUrl);
				const request = new AbortController();
				const signal = AbortSignal.any([run.controller.signal, request.signal]);
				const timer = setTimeout(() => request.abort(), 20000);
				let result: RecordingResult;
				try {
					result = await abortable(gateway.recordAndTranscribe({ maxDurationSec: 15, signal }), signal);
				} finally { clearTimeout(timer); request.abort(); }
				if (!this.liveCurrent(run)) break;
				if (result.text.trim()) this.deliver(result.text.trim(), cfg.deliveryMode);
				await delay(100, run.controller.signal);
			}
		} catch (error) {
			if (this.liveCurrent(run)) {
				// Fail closed rather than spin/hit an offline gateway indefinitely.
				this.live = false;
				this.notify(`Live 已停止: ${errorText(error)}；可执行 /voice live on 重启`, "warning");
			}
		} finally {
			run.controller.abort();
			if (this.liveRun === run) { this.liveRun = undefined; this.footer(); }
		}
	}
	private deliver(text: string, mode: DeliveryMode): void {
		const ctx = this.context;
		if (mode === "editor") {
			if (!ctx?.hasUI) throw new Error("editor 模式需要交互终端；不会自动降级为提交");
			const draft = ctx.ui.getEditorText();
			ctx.ui.setEditorText(draft + (draft && !/\s$/.test(draft) ? " " : "") + text);
		} else if (ctx?.isIdle()) this.pi.sendUserMessage(text);
		else { this.pi.sendUserMessage(text, { deliverAs: "followUp" }); this.notify("语音已作为 followUp 排队"); }
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
	public async command(args: string, ctx: ExtensionContext): Promise<void> {
		this.attach(ctx);
		const [rawAction = "status", param] = args.trim().split(/\s+/);
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
				case "set-voice":
					if (!param) throw new Error("用法: /voice set-voice <id>");
					await this.config.update(current => ({ ...current, defaultVoiceId: param }));
					this.notify(`默认音色已保存: ${param}`); break;
				case "voices": {
					const result = await this.listVoices({});
					this.notify(result.success ? [result.warning, `默认: ${result.default_voice_id}`, ...result.voices.map(v => `${v.id}: ${v.name}`)].filter(Boolean).join("\n") : result.message || "查询失败", result.success && !result.warning ? "info" : "warning");
					break;
				}
				case "status": {
					const cfg = this.config.get();
					this.notify(`Voice: ${this.enabled ? "ON" : "OFF"}\nLive: ${this.live ? "ON" : "OFF"}\nGateway: ${cfg.gatewayUrl}\nMode: ${cfg.deliveryMode}\nVoice: ${cfg.defaultVoiceId}\n发音: ${UNSUPPORTED_SPEAKER}\n快捷键: F2 / Alt+X`);
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
export default function voiceExtension(pi: ExtensionAPI, options: VoiceRuntimeOptions = {}): void {
	const runtime = new VoiceRuntime(pi, options);
	pi.registerTool({ name: "voice_speak", label: "Voice Speak", parameters: VoiceSpeakParamsSchema,
		description: "口头朗读。需要安全的任务级取消和物理播放完成协议，当前旧版 TtsGateway 不兼容时明确失败，不自动重试。先说后听必须等待本工具成功再顺序调用 voice_listen，不得并行。",
		async execute(_id, params, signal, _update, ctx) { runtime.attach(ctx); return toolResult(await runtime.speak(params, signal)); },
	});
	pi.registerTool({ name: "voice_listen", label: "Voice Listen", parameters: VoiceListenParamsSchema,
		description: "收取一次口头答复，prompt 仅终端展示。与背景 Live 使用同一输入能力，但交接时取消并丢弃当前背景录音，开启新的请求，可能丢失正在说的半句。取消不重问；超时不能推断用户未说话。",
		async execute(_id, params, signal, _update, ctx) { runtime.attach(ctx); return toolResult(await runtime.listen(params, signal)); },
	});
	pi.registerTool({ name: "voice_list_voices", label: "Voice List Voices", parameters: VoiceListVoicesParamsSchema,
		description: "获取音色目录：优先持久化缓存，无缓存才联网；仅确需更新时 refresh=true，不要每次发音前查询。",
		async execute(_id, params, signal, _update, ctx) { runtime.attach(ctx); return toolResult(await runtime.listVoices(params, signal)); },
	});
	pi.registerCommand("voice", { description: "Voice: on/off/stop/live/mode/set-voice/voices/status", handler: (args, ctx) => runtime.command(args, ctx) });
	pi.registerShortcut("alt+x", { description: "取消现有语音活动，保留开关", handler: async ctx => { runtime.attach(ctx); runtime.stop(); } });
	pi.registerShortcut("f2", { description: "切换持续语音输入", handler: ctx => runtime.command("live", ctx) });
	pi.on("session_start", (_event, ctx) => runtime.start(ctx));
	pi.on("session_shutdown", () => runtime.stop(true));
	pi.on("session_before_switch", () => runtime.stop(true));
	pi.on("session_before_fork", () => runtime.stop(true));
}
