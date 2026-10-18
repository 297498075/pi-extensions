import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import zlib from "node:zlib";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { showStatusModal } from "./lib/status-modal.ts";

export type CompressionAlgorithm = "zstd" | "gzip" | "deflate" | "br";

export interface RequestCompressConfig {
	/**
	 * 是否启用请求体压缩
	 * @default true
	 */
	enabled: boolean;

	/**
	 * 压缩算法：zstd | gzip | deflate | br
	 * @default "zstd"
	 */
	algorithm: CompressionAlgorithm;

	/**
	 * 针对哪些 Provider 开启压缩（支持通配符 *，或关键字 "default" 代表默认 Provider）
	 * @default ["default"]
	 */
	providers: string[];

	/**
	 * 针对哪些 Model 开启压缩（支持通配符 *）
	 * @default ["*"]
	 */
	models: string[];

	/**
	 * 排除不压缩的 Provider 列表
	 * @default []
	 */
	excludeProviders: string[];

	/**
	 * 排除不压缩的 Model 列表
	 * @default []
	 */
	excludeModels: string[];

	/**
	 * 触发压缩的最小请求体字节数阈值（小于该大小直接明文发送，避免小请求负优化）
	 * @default 1024
	 */
	minBytesThreshold: number;

	/**
	 * zstd 压缩级别 (1-22)
	 * @default 3
	 */
	zstdLevel: number;

	/**
	 * gzip / deflate 压缩级别 (1-9)
	 * @default 6
	 */
	gzipLevel: number;

	/**
	 * brotli 压缩质量等级 (0-11)
	 * @default 4
	 */
	brotliQuality: number;

	/**
	 * 目标 URL / Host 过滤列表（可选，支持通配符 *。为空时根据 provider/model 自动判定）
	 * 例如: ["*.yqdcc.site", "101.35.25.253*"]
	 * @default []
	 */
	targetHosts: string[];

	/**
	 * 是否在控制台打印调试信息
	 * @default false
	 */
	debug: boolean;
}

export const DEFAULT_CONFIG: RequestCompressConfig = {
	enabled: true,
	algorithm: "zstd",
	providers: ["default"],
	models: ["*"],
	excludeProviders: [],
	excludeModels: [],
	minBytesThreshold: 1024,
	zstdLevel: 3,
	gzipLevel: 6,
	brotliQuality: 4,
	targetHosts: [],
	debug: false,
};

export interface CompressionStats {
	totalRequests: number;
	compressedRequests: number;
	originalBytes: number;
	compressedBytes: number;
}

const STATS_REF_SYMBOL = Symbol.for("__pi_request_compress_stats_ref__");
if (!(globalThis as any)[STATS_REF_SYMBOL]) {
	(globalThis as any)[STATS_REF_SYMBOL] = {
		totalRequests: 0,
		compressedRequests: 0,
		originalBytes: 0,
		compressedBytes: 0,
	};
}
const stats: CompressionStats = (globalThis as any)[STATS_REF_SYMBOL];

/**
 * 检查二进制 Buffer 是否已经是压缩数据（避免重复压缩损坏 payload）
 */
export function isAlreadyCompressed(buf: Buffer): boolean {
	if (buf.length < 4) return false;
	// zstd 魔数: 0x28 0xB5 0x2F 0xFD (小端 0xFD2FB528)
	if (buf.readUInt32LE(0) === 0xFD2FB528) return true;
	// gzip 魔数: 0x1F 0x8B
	if (buf[0] === 0x1F && buf[1] === 0x8B) return true;
	return false;
}

export function matchesPattern(value: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern === value) return true;
	if (pattern.includes("*")) {
		const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
		return new RegExp(`^${escaped}$`, "i").test(value);
	}
	return pattern.toLowerCase() === value.toLowerCase();
}

export function matchesAnyPattern(value: string, patterns: string[]): boolean {
	return patterns.some((p) => matchesPattern(value, p));
}

function getGlobalConfigDir(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(agentDir, "extensions", "request-compress");
}

function getGlobalConfigPath(): string {
	return join(getGlobalConfigDir(), "config.json");
}

function getLocalConfigPath(cwd: string): string {
	return join(cwd, ".pi", "request-compress.json");
}

export function mergeConfig(
	base: RequestCompressConfig,
	override: Partial<RequestCompressConfig>,
): RequestCompressConfig {
	return {
		enabled: typeof override.enabled === "boolean" ? override.enabled : base.enabled,
		algorithm: override.algorithm ?? base.algorithm,
		providers: Array.isArray(override.providers) ? [...override.providers] : base.providers,
		models: Array.isArray(override.models) ? [...override.models] : base.models,
		excludeProviders: Array.isArray(override.excludeProviders)
			? [...override.excludeProviders]
			: base.excludeProviders,
		excludeModels: Array.isArray(override.excludeModels) ? [...override.excludeModels] : base.excludeModels,
		minBytesThreshold:
			typeof override.minBytesThreshold === "number" && !Number.isNaN(override.minBytesThreshold)
				? override.minBytesThreshold
				: base.minBytesThreshold,
		zstdLevel:
			typeof override.zstdLevel === "number" && !Number.isNaN(override.zstdLevel)
				? override.zstdLevel
				: base.zstdLevel,
		gzipLevel:
			typeof override.gzipLevel === "number" && !Number.isNaN(override.gzipLevel)
				? override.gzipLevel
				: base.gzipLevel,
		brotliQuality:
			typeof override.brotliQuality === "number" && !Number.isNaN(override.brotliQuality)
				? override.brotliQuality
				: base.brotliQuality,
		targetHosts: Array.isArray(override.targetHosts) ? [...override.targetHosts] : base.targetHosts,
		debug: typeof override.debug === "boolean" ? override.debug : base.debug,
	};
}

export function loadConfig(cwd: string = process.cwd()): RequestCompressConfig {
	let config: RequestCompressConfig = { ...DEFAULT_CONFIG };

	const globalPath = getGlobalConfigPath();
	if (existsSync(globalPath)) {
		try {
			const content = readFileSync(globalPath, "utf-8");
			config = mergeConfig(config, JSON.parse(content));
		} catch (err) {
			console.error(`[request-compress] Failed to parse global config: ${globalPath}`, err);
		}
	} else {
		try {
			const dir = getGlobalConfigDir();
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			writeFileSync(globalPath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
		} catch {}
	}

	const localPath = getLocalConfigPath(cwd);
	if (existsSync(localPath)) {
		try {
			const content = readFileSync(localPath, "utf-8");
			config = mergeConfig(config, JSON.parse(content));
		} catch (err) {
			console.error(`[request-compress] Failed to parse local config: ${localPath}`, err);
		}
	}

	return config;
}

export interface PiEnvironmentContext {
	defaultProvider?: string;
	providerBaseUrls: Map<string, string | string[]>; // Full API base URL -> provider(s); shared endpoints stay ambiguous
	modelToProvider: Map<string, string>;  // modelId -> providerId
}

export function resolvePiEnvironment(): PiEnvironmentContext {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const ctx: PiEnvironmentContext = {
		defaultProvider: undefined,
		providerBaseUrls: new Map(),
		modelToProvider: new Map(),
	};

	try {
		const settingsPath = join(agentDir, "settings.json");
		if (existsSync(settingsPath)) {
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			if (typeof settings.defaultProvider === "string") {
				ctx.defaultProvider = settings.defaultProvider;
			}
		}
	} catch {}

	try {
		const modelsPath = join(agentDir, "models.json");
		if (existsSync(modelsPath)) {
			const modelsData = JSON.parse(readFileSync(modelsPath, "utf-8"));
			const providers = modelsData.providers || {};
			for (const [providerId, providerObj] of Object.entries<any>(providers)) {
				if (providerObj?.baseUrl && typeof providerObj.baseUrl === "string") {
					try {
						const url = new URL(providerObj.baseUrl);
						if (url.protocol === "http:" || url.protocol === "https:") {
							const normalizedUrl = url.origin + url.pathname.replace(/\/+$/, "");
							const previous = ctx.providerBaseUrls.get(normalizedUrl);
							ctx.providerBaseUrls.set(normalizedUrl, previous === undefined ? providerId :
								[...new Set([...(Array.isArray(previous) ? previous : [previous]), providerId])]);
						}
					} catch { /* Invalid base URLs cannot establish request ownership. */ }
				}
				if (Array.isArray(providerObj?.models)) {
					for (const modelItem of providerObj.models) {
						const mId = typeof modelItem === "string" ? modelItem : modelItem?.id;
						if (mId && typeof mId === "string") {
							ctx.modelToProvider.set(mId.toLowerCase(), providerId);
						}
					}
				}
			}
		}
	} catch {}

	return ctx;
}

/** Match origin and case-sensitive path boundaries, preferring the most specific API prefix. */
function requestProvider(url: URL | undefined, envCtx: PiEnvironmentContext): { providerId?: string; ambiguous: boolean } {
	let longestPrefix = -1;
	const providers = new Set<string>();
	if (!url) return { ambiguous: false };
	for (const [baseUrl, ids] of envCtx.providerBaseUrls) {
		let prefixLength: number;
		if (baseUrl.includes("://")) {
			try {
				const base = new URL(baseUrl);
				const prefix = base.pathname.replace(/\/+$/, "");
				if (base.origin !== url.origin || (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))) continue;
				prefixLength = prefix.length;
			} catch { continue; }
		} else {
			// Retain the exported helper's legacy host-only environment contract.
			if (baseUrl.toLowerCase() !== url.host.toLowerCase()) continue;
			prefixLength = 0;
		}
		if (prefixLength < longestPrefix) continue;
		if (prefixLength > longestPrefix) { providers.clear(); longestPrefix = prefixLength; }
		for (const id of Array.isArray(ids) ? ids : [ids]) providers.add(id);
	}
	return { providerId: providers.size === 1 ? providers.values().next().value : undefined, ambiguous: providers.size > 1 };
}

export function compressPayload(
	payload: Buffer,
	algorithm: CompressionAlgorithm,
	config: RequestCompressConfig,
): { compressed: Buffer; encoding: string } | null {
	try {
		switch (algorithm) {
			case "zstd": {
				if (typeof zlib.zstdCompressSync !== "function") {
					return null;
				}
				const compressed = zlib.zstdCompressSync(payload, {
					params: { [zlib.constants.ZSTD_c_compressionLevel]: config.zstdLevel },
				});
				return { compressed, encoding: "zstd" };
			}
			case "gzip": {
				const compressed = zlib.gzipSync(payload, { level: config.gzipLevel });
				return { compressed, encoding: "gzip" };
			}
			case "deflate": {
				const compressed = zlib.deflateSync(payload, { level: config.gzipLevel });
				return { compressed, encoding: "deflate" };
			}
			case "br": {
				const compressed = zlib.brotliCompressSync(payload, {
					params: { [zlib.constants.BROTLI_PARAM_QUALITY]: config.brotliQuality },
				});
				return { compressed, encoding: "br" };
			}
			default:
				return null;
		}
	} catch {
		return null;
	}
}

export function shouldCompressRequest(
	urlStr: string,
	method: string,
	bodyRaw: Buffer | null,
	existingEncoding: string | null | undefined,
	config: RequestCompressConfig,
	envCtx: PiEnvironmentContext,
): { shouldCompress: boolean; reason?: string; modelId?: string; providerId?: string } {
	if (!config.enabled) {
		return { shouldCompress: false, reason: "Extension is disabled in config" };
	}

	if (method !== "POST" || !bodyRaw) {
		return { shouldCompress: false, reason: "Not a POST request or body is empty" };
	}

	// 1. 如果请求头中已存在 Content-Encoding，禁止二次压缩
	if (existingEncoding && existingEncoding !== "identity") {
		return { shouldCompress: false, reason: `Request already has Content-Encoding: ${existingEncoding}` };
	}

	// 2. 检查数据流是否已是压缩二进制格式
	if (isAlreadyCompressed(bodyRaw)) {
		return { shouldCompress: false, reason: "Payload is already compressed binary data" };
	}

	// 3. 检查字节大小阈值
	if (bodyRaw.length < config.minBytesThreshold) {
		return {
			shouldCompress: false,
			reason: `Body size (${bodyRaw.length}B) is below threshold (${config.minBytesThreshold}B)`,
		};
	}

	let urlObj: URL | undefined;
	try {
		urlObj = new URL(urlStr);
	} catch {}

	if (config.targetHosts.length > 0) {
		const host = urlObj ? urlObj.host : urlStr;
		if (!matchesAnyPattern(host, config.targetHosts)) {
			return { shouldCompress: false, reason: `Host ${host} does not match targetHosts filter` };
		}
	}

	let modelId: string | undefined;
	try {
		const parsed = JSON.parse(bodyRaw.toString("utf-8"));
		if (parsed && typeof parsed.model === "string") modelId = parsed.model;
	} catch {
		// 非合法 JSON 文本，避免对未知二进制乱压缩
		return { shouldCompress: false, reason: "Body cannot be parsed as JSON text" };
	}

	// A model name alone is not proof of ownership: unrelated services can use
	// the same JSON fields. Unknown API addresses require explicit targetHosts opt-in.
	const { providerId: knownProvider, ambiguous } = requestProvider(urlObj, envCtx);
	if (ambiguous) {
		return { shouldCompress: false, reason: "Ambiguous provider API base URL; leaving request uncompressed" };
	}
	if (!knownProvider && config.targetHosts.length === 0) {
		return { shouldCompress: false, reason: "Unknown API URL (outside provider base URLs or targetHosts)" };
	}
	if (!modelId && config.targetHosts.length === 0) {
		return { shouldCompress: false, reason: "Request has no model; explicit targetHosts opt-in required" };
	}
	const providerId = knownProvider || (modelId ? envCtx.modelToProvider.get(modelId.toLowerCase()) : undefined) || envCtx.defaultProvider;

	if (providerId && matchesAnyPattern(providerId, config.excludeProviders)) {
		return { shouldCompress: false, reason: `Provider ${providerId} is in excludeProviders` };
	}

	if (modelId && matchesAnyPattern(modelId, config.excludeModels)) {
		return { shouldCompress: false, reason: `Model ${modelId} is in excludeModels` };
	}

	const isProviderTargeted = config.providers.some((p) => {
		if (p === "*") return true;
		if (p.toLowerCase() === "default") {
			return !providerId || !envCtx.defaultProvider || providerId.toLowerCase() === envCtx.defaultProvider.toLowerCase();
		}
		return providerId ? matchesPattern(providerId, p) : false;
	});

	if (!isProviderTargeted) {
		return {
			shouldCompress: false,
			reason: `Provider ${providerId || "unknown"} is not in target providers [${config.providers.join(", ")}]`,
		};
	}

	const isModelTargeted = !modelId || matchesAnyPattern(modelId, config.models);
	if (!isModelTargeted) {
		return {
			shouldCompress: false,
			reason: `Model ${modelId} does not match target models [${config.models.join(", ")}]`,
		};
	}

	return { shouldCompress: true, modelId, providerId };
}

const HOOKED_SYMBOL = Symbol.for("__pi_request_compress_fetch_hooked__");
const ORIGINAL_FETCH_SYMBOL = Symbol.for("__pi_request_compress_original_fetch__");
const CONFIG_REF_SYMBOL = Symbol.for("__pi_request_compress_config_ref__");
const ENV_REF_SYMBOL = Symbol.for("__pi_request_compress_env_ref__");
const FETCH_WRAPPER_SYMBOL = Symbol.for("__pi_request_compress_fetch_wrapper__");
const FETCH_ACTIVE_SYMBOL = Symbol.for("__pi_request_compress_fetch_active__");

function hasLegacyFetchHook(): boolean {
	return Boolean((globalThis as any)[HOOKED_SYMBOL]) && !(globalThis as any)[FETCH_WRAPPER_SYMBOL];
}

export function setupFetchHook(): boolean {
	// Older releases did not retain wrapper identity or an inert switch.
	// Disable their shared config; do not overwrite an unknown wrapper chain.
	if (hasLegacyFetchHook()) {
		const config = (globalThis as any)[CONFIG_REF_SYMBOL] as RequestCompressConfig | undefined;
		if (config) config.enabled = false;
		return false;
	}
	(globalThis as any)[FETCH_ACTIVE_SYMBOL] = true;
	// 如果已经 Hook 过 globalThis.fetch，不重复包装，只更新全局配置引用
	if ((globalThis as any)[HOOKED_SYMBOL]) {
		return true;
	}
	(globalThis as any)[HOOKED_SYMBOL] = true;

	const originalFetch = (globalThis as any)[ORIGINAL_FETCH_SYMBOL] || globalThis.fetch;
	(globalThis as any)[ORIGINAL_FETCH_SYMBOL] = originalFetch;

	const wrappedFetch: typeof fetch = async function (input: any, init: RequestInit = {}) {
		if (!(globalThis as any)[FETCH_ACTIVE_SYMBOL]) return originalFetch(input, init);
		// Fetch treats a null Web IDL dictionary exactly like omitted options.
		init ??= {};
		const liveConfig: RequestCompressConfig = (globalThis as any)[CONFIG_REF_SYMBOL] || DEFAULT_CONFIG;
		const liveEnvCtx: PiEnvironmentContext = (globalThis as any)[ENV_REF_SYMBOL] || {
			defaultProvider: undefined,
			providerBaseUrls: new Map(),
			modelToProvider: new Map(),
		};

		stats.totalRequests++;

		let urlStr = "";
		if (typeof input === "string") {
			urlStr = input;
		} else if (input instanceof URL) {
			urlStr = input.href;
		} else if (input && typeof input.url === "string") {
			urlStr = input.url;
		}

		let method = (init.method || (input && typeof input.method === "string" ? input.method : "GET")).toUpperCase();

		let rawBuf: Buffer | null = null;
		const reqBody = init.body ?? (typeof input === "object" && input !== null && "body" in input ? (input as any).body : undefined);

		if (typeof reqBody === "string") {
			rawBuf = Buffer.from(reqBody, "utf-8");
		} else if (Buffer.isBuffer(reqBody) || reqBody instanceof Uint8Array) {
			rawBuf = Buffer.from(reqBody);
		}

		// 提取现有请求头中的 Content-Encoding
		const headers = new Headers(init.headers || (input instanceof Request ? input.headers : {}));
		const existingEncoding = headers.get("content-encoding");

		const check = shouldCompressRequest(urlStr, method, rawBuf, existingEncoding, liveConfig, liveEnvCtx);

		if (!check.shouldCompress || !rawBuf) {
			if (liveConfig.debug && rawBuf && rawBuf.length > 200) {
				console.log(`[request-compress] Skipped: ${check.reason} (${urlStr})`);
			}
			return originalFetch(input, init);
		}

		const compressedRes = compressPayload(rawBuf, liveConfig.algorithm, liveConfig);
		if (!compressedRes) {
			if (liveConfig.debug) {
				console.warn(`[request-compress] Compression with ${liveConfig.algorithm} failed, fallback to plain.`);
			}
			return originalFetch(input, init);
		}

		stats.compressedRequests++;
		stats.originalBytes += rawBuf.length;
		stats.compressedBytes += compressedRes.compressed.length;

		if (liveConfig.debug) {
			const saved = (((rawBuf.length - compressedRes.compressed.length) / rawBuf.length) * 100).toFixed(1);
			console.log(
				`[request-compress] [${compressedRes.encoding}] Compressed ${check.providerId || "api"}/${check.modelId || "model"}: ${rawBuf.length}B -> ${compressedRes.compressed.length}B (saved ${saved}%)`,
			);
		}

		headers.set("Content-Encoding", compressedRes.encoding);
		headers.delete("Content-Length");

		return (originalFetch as any)(input, {
			...init,
			headers,
			body: new Uint8Array(compressedRes.compressed),
		});
	};
	(globalThis as any)[FETCH_WRAPPER_SYMBOL] = wrappedFetch;
	globalThis.fetch = wrappedFetch;
	return true;
}

export function teardownFetchHook(): void {
	if (hasLegacyFetchHook()) {
		const config = (globalThis as any)[CONFIG_REF_SYMBOL] as RequestCompressConfig | undefined;
		if (config) config.enabled = false;
	}
	(globalThis as any)[FETCH_ACTIVE_SYMBOL] = false;
	if (globalThis.fetch === (globalThis as any)[FETCH_WRAPPER_SYMBOL]) {
		globalThis.fetch = (globalThis as any)[ORIGINAL_FETCH_SYMBOL];
		delete (globalThis as any)[HOOKED_SYMBOL];
		delete (globalThis as any)[ORIGINAL_FETCH_SYMBOL];
		delete (globalThis as any)[FETCH_WRAPPER_SYMBOL];
	}
	// If another wrapper surrounds ours, leave it intact; ours is now inert.
}

export function updateLiveContext(config: RequestCompressConfig, envCtx: PiEnvironmentContext): void {
	(globalThis as any)[CONFIG_REF_SYMBOL] = config;
	(globalThis as any)[ENV_REF_SYMBOL] = envCtx;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function getStats(): CompressionStats {
	return { ...stats };
}

export function resetStats(): void {
	stats.totalRequests = 0;
	stats.compressedRequests = 0;
	stats.originalBytes = 0;
	stats.compressedBytes = 0;
}

const REQUEST_COMPRESS_SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "status", label: "status", description: "查看当前压缩状态、算法与流量节省统计" },
	{ value: "on", label: "on", description: "开启 HTTP 请求体压缩" },
	{ value: "off", label: "off", description: "关闭 HTTP 请求体压缩" },
	{ value: "reload", label: "reload", description: "从磁盘重新载入压缩配置" },
];

export function getRequestCompressArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const prefix = (argumentPrefix || "").trimStart();
	const filtered = REQUEST_COMPRESS_SUBCOMMANDS.filter((item) =>
		item.value.toLowerCase().startsWith(prefix.toLowerCase()),
	);
	return filtered.length > 0 ? filtered : null;
}

export default function requestCompressExtension(pi: ExtensionAPI): void {
	const activeConfig = loadConfig();
	const activeEnvCtx = resolvePiEnvironment();

	updateLiveContext(activeConfig, activeEnvCtx);
	pi.on("session_start", (_event, ctx) => {
		updateLiveContext(loadConfig(ctx.cwd), resolvePiEnvironment());
		if (!setupFetchHook()) ctx.ui.notify("request-compress: 旧版 fetch hook 无法安全热替换，已关闭压缩；请重启 Pi 后重新启用。", "warning");
	});
	pi.on("session_shutdown", () => teardownFetchHook());

	pi.registerCommand("request-compress", {
		description: "View or toggle HTTP request body compression status (zstd/gzip)",
		getArgumentCompletions: getRequestCompressArgumentCompletions,
		handler: async (args, ctx) => {
			const currentConfig: RequestCompressConfig = (globalThis as any)[CONFIG_REF_SYMBOL] || activeConfig;
			const sub = args?.trim().toLowerCase();

			if (sub === "on") {
				if (hasLegacyFetchHook()) {
					ctx.ui.notify("request-compress: 请先重启 Pi，清理旧版 fetch hook。", "warning");
					return;
				}
				currentConfig.enabled = true;
				ctx.ui.notify("Request compression enabled (algorithm: " + currentConfig.algorithm + ")", "info");
				return;
			}

			if (sub === "off") {
				currentConfig.enabled = false;
				ctx.ui.notify("Request compression disabled", "info");
				return;
			}

			if (sub === "reload") {
				const reloaded = loadConfig(ctx.cwd);
				const env = resolvePiEnvironment();
				if (hasLegacyFetchHook()) reloaded.enabled = false;
				updateLiveContext(reloaded, env);
				ctx.ui.notify("Request compression configuration reloaded", "info");
				return;
			}

			const s = getStats();
			const savedRatio =
				s.originalBytes > 0
					? (((s.originalBytes - s.compressedBytes) / s.originalBytes) * 100).toFixed(1) + "%"
					: "0%";

			const currentEnv: PiEnvironmentContext = (globalThis as any)[ENV_REF_SYMBOL] || activeEnvCtx;
			const lines = [
				`Request Compression: ${currentConfig.enabled ? "Enabled (ON)" : "Disabled (OFF)"}`,
				`Algorithm: ${currentConfig.algorithm}`,
				`Providers: [${currentConfig.providers.join(", ")}] (Default: ${currentEnv.defaultProvider || "none"})`,
				`Models: [${currentConfig.models.join(", ")}]`,
				`Min Threshold: ${currentConfig.minBytesThreshold} Bytes`,
				`Debug Mode: ${currentConfig.debug ? "ON" : "OFF"}`,
				`Config Path: ${getGlobalConfigPath()}`,
				"",
				`Traffic Stats:`,
				`  Compressed Requests: ${s.compressedRequests} / ${s.totalRequests}`,
				`  Original Payload:   ${formatBytes(s.originalBytes)}`,
				`  Compressed Payload: ${formatBytes(s.compressedBytes)}`,
				`  Bandwidth Saved:    ${savedRatio}`,
				"",
				`Usage: /request-compress [status | on | off | reload]`,
			];

			await showStatusModal(ctx, "Request Compression", lines);
		},
	});
}
