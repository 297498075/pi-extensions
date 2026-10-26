import { stripVTControlCharacters } from "node:util";
const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f]/g, " ");
/** Small catalog snapshots: never expand voice IDs into tool schemas or fetch on each key. */
export interface VoiceItem {
	id: string;
	name: string;
	description?: string;
	engine?: string;
	ready?: boolean;
	capabilities?: Record<string, boolean>;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export function parseVoices(value: unknown, wireFormat = false): VoiceItem[] {
	if (!Array.isArray(value)) throw new Error("音色目录响应必须是数组");
	const ids = new Set<string>();
	return value.map(item => {
		if (!object(item)) throw new Error("无效的音色目录条目");
		const id = item[wireFormat ? "voice_id" : "id"];
		if (typeof id !== "string" || !id.trim() || /[\x00-\x1f\x7f]/.test(id) || id.length > 256 || typeof item.name !== "string" || !item.name.trim()) throw new Error("音色目录缺少有效 ID 或名称");
		if (ids.has(id)) throw new Error(`音色目录出现重复 ID: ${id}`);
		ids.add(id);
		if (item.description != null && typeof item.description !== "string") throw new Error("音色描述必须是字符串");
		const rawEngine = typeof item.engine === "string" ? item.engine.trim().toLowerCase() : wireFormat ? "cosyvoice" : undefined;
		const engine = rawEngine && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(rawEngine) ? rawEngine : rawEngine === undefined ? undefined : "unknown";
		const capabilities = object(item.capabilities) ? Object.fromEntries(Object.entries(item.capabilities).filter(([, v]) => typeof v === "boolean")) as Record<string, boolean> : undefined;
		return { id, name: clean(item.name).slice(0, 256), ...(typeof item.description === "string" ? { description: clean(item.description).slice(0, 512) } : {}), ...(engine ? { engine } : {}), ...(typeof item.ready === "boolean" ? { ready: item.ready } : {}), ...(capabilities ? { capabilities } : {}) };
	});
}
export function voiceUnavailableReason(voice: VoiceItem): string | undefined {
	if (voice.ready === false) return "音色尚未就绪";
	if (voice.engine && !["cosyvoice", "voice-library"].includes(voice.engine)) return `当前扩展不支持 ${voice.engine} 所需的引擎专用参数`;
	return undefined;
}
export function resolveVoice(voices: VoiceItem[], id: string): VoiceItem {
	const matches = voices.filter(v => v.id.toLowerCase() === id.toLowerCase());
	if (matches.length !== 1) throw new Error(`音色 ID 不存在或不唯一: ${id}；请实时查询 /voice voices`);
	const reason = voiceUnavailableReason(matches[0]);
	if (reason) throw new Error(`${matches[0].id}: ${reason}`);
	return matches[0];
}
export function voiceSearchIndex(voices: VoiceItem[]): string[] {
	return voices.map(v => `${v.id}\n${v.name}\n${v.engine ?? ""}\n${v.description ?? ""}`.toLowerCase());
}
export function filterVoices(voices: VoiceItem[], query = "", index = voiceSearchIndex(voices)): VoiceItem[] {
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return words.length ? voices.filter((_, i) => words.every(word => index[i].includes(word))) : voices;
}
export function voicePage(voices: VoiceItem[], params: { query?: string; offset?: number; limit?: number }, index?: string[]) {
	const { query = "", offset = 0, limit = 20 } = params;
	if (typeof query !== "string" || query.length > 256 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("音色查询参数无效：query ≤256 字，offset ≥0，limit 1–50");
	const matches = filterVoices(voices, query, index);
	return { voices: matches.slice(offset, offset + limit), total: voices.length, matched: matches.length, offset, limit, has_more: offset + limit < matches.length };
}
export interface CatalogSnapshot { voices: VoiceItem[]; index: string[]; checkedAt: number; warning?: string }
function cancelled(): Error { return new DOMException("音色查询已取消", "AbortError"); }
function wait<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation;
	return new Promise((resolve, reject) => {
		const cancel = () => { cleanup(); reject(cancelled()); };
		const cleanup = () => signal.removeEventListener("abort", cancel);
		signal.addEventListener("abort", cancel, { once: true });
		operation.then(v => { cleanup(); resolve(v); }, e => { cleanup(); reject(e); });
		if (signal.aborted) cancel();
	});
}
/** One producer per gateway. A cancelled subscriber cannot abort other subscribers. */
export class VoiceDirectory {
	private snapshot?: CatalogSnapshot;
	private pending?: { controller: AbortController; promise: Promise<CatalogSnapshot> };
	private readonly loader: (signal: AbortSignal) => Promise<{ voices: VoiceItem[]; warning?: string }>;
	private readonly ttlMs: number;
	private readonly timeoutMs: number;
	constructor(loader: (signal: AbortSignal) => Promise<{ voices: VoiceItem[]; warning?: string }>, ttlMs = 5000, timeoutMs = 3000) { this.loader = loader; this.ttlMs = ttlMs; this.timeoutMs = timeoutMs; }
	public clear(): void { this.snapshot = undefined; this.pending?.controller.abort(); this.pending = undefined; }
	public peek(): CatalogSnapshot | undefined { return this.snapshot; }
	public get(refresh = false, signal?: AbortSignal): Promise<CatalogSnapshot> {
		if (signal?.aborted) return Promise.reject(cancelled());
		if (!refresh && this.snapshot && Date.now() - this.snapshot.checkedAt < this.ttlMs) return Promise.resolve(this.snapshot);
		if (!this.pending) {
			const controller = new AbortController();
			const task = { controller, promise: undefined as unknown as Promise<CatalogSnapshot> };
			this.pending = task;
			const timer = setTimeout(() => controller.abort(), this.timeoutMs);
			let operation: Promise<{ voices: VoiceItem[]; warning?: string }>;
			try { operation = this.loader(controller.signal); } catch (error) { operation = Promise.reject(error); }
			task.promise = wait(operation, controller.signal).then(result => {
				if (controller.signal.aborted || this.pending !== task) throw cancelled();
				return this.snapshot = { ...result, index: voiceSearchIndex(result.voices), checkedAt: Date.now() };
			}).catch(error => { if (this.pending === task) this.snapshot = undefined; throw error; }).finally(() => { clearTimeout(timer); if (this.pending === task) this.pending = undefined; });
		}
		return wait(this.pending.promise, signal);
	}
}
