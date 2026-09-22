import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import zlib from "node:zlib";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

const stats: CompressionStats = {
	totalRequests: 0,
	compressedRequests: 0,
	originalBytes: 0,
	compressedBytes: 0,
};

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
	providerBaseUrls: Map<string, string>; // baseUrl -> providerId
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
						const normalizedUrl = new URL(providerObj.baseUrl).host.toLowerCase();
						ctx.providerBaseUrls.set(normalizedUrl, providerId);
					} catch {
						ctx.providerBaseUrls.set(providerObj.baseUrl.toLowerCase(), providerId);
					}
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
	config: RequestCompressConfig,
	envCtx: PiEnvironmentContext,
): { shouldCompress: boolean; reason?: string; modelId?: string; providerId?: string } {
	if (!config.enabled) {
		return { shouldCompress: false, reason: "Extension is disabled in config" };
	}

	if (method !== "POST" || !bodyRaw) {
		return { shouldCompress: false, reason: "Not a POST request or body is empty" };
	}

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
		const preview = bodyRaw.subarray(0, 4096).toString("utf-8");
		const match = preview.match(/"model"\s*:\s*"([^"]+)"/);
		if (match) {
			modelId = match[1];
		} else {
			const parsed = JSON.parse(bodyRaw.toString("utf-8"));
			if (parsed && typeof parsed.model === "string") {
				modelId = parsed.model;
			}
		}
	} catch {}

	let providerId: string | undefined;
	if (modelId) {
		providerId = envCtx.modelToProvider.get(modelId.toLowerCase());
	}
	if (!providerId && urlObj) {
		providerId = envCtx.providerBaseUrls.get(urlObj.host.toLowerCase());
	}
	if (!providerId) {
		providerId = envCtx.defaultProvider;
	}

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

let isFetchHooked = false;
let activeConfig: RequestCompressConfig = { ...DEFAULT_CONFIG };
let activeEnvCtx: PiEnvironmentContext = {
	defaultProvider: undefined,
	providerBaseUrls: new Map(),
	modelToProvider: new Map(),
};

export function setupFetchHook(): void {
	if (isFetchHooked) return;
	isFetchHooked = true;

	const originalFetch = globalThis.fetch;

	globalThis.fetch = async function (input: any, init: RequestInit = {}) {
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
		const reqBody = init.body ?? (input && "body" in input ? input.body : undefined);

		if (typeof reqBody === "string") {
			rawBuf = Buffer.from(reqBody, "utf-8");
		} else if (Buffer.isBuffer(reqBody) || reqBody instanceof Uint8Array) {
			rawBuf = Buffer.from(reqBody);
		}

		const check = shouldCompressRequest(urlStr, method, rawBuf, activeConfig, activeEnvCtx);

		if (!check.shouldCompress || !rawBuf) {
			if (activeConfig.debug && rawBuf && rawBuf.length > 200) {
				console.log(`[request-compress] Skipped: ${check.reason} (${urlStr})`);
			}
			return originalFetch(input, init);
		}

		const compressedRes = compressPayload(rawBuf, activeConfig.algorithm, activeConfig);
		if (!compressedRes) {
			if (activeConfig.debug) {
				console.warn(`[request-compress] Compression with ${activeConfig.algorithm} failed, fallback to plain.`);
			}
			return originalFetch(input, init);
		}

		stats.compressedRequests++;
		stats.originalBytes += rawBuf.length;
		stats.compressedBytes += compressedRes.compressed.length;

		if (activeConfig.debug) {
			const saved = (((rawBuf.length - compressedRes.compressed.length) / rawBuf.length) * 100).toFixed(1);
			console.log(
				`[request-compress] [${compressedRes.encoding}] Compressed ${check.providerId || "api"}/${check.modelId || "model"}: ${rawBuf.length}B -> ${compressedRes.compressed.length}B (saved ${saved}%)`,
			);
		}

		const headers = new Headers(init.headers || (input instanceof Request ? input.headers : {}));
		headers.set("Content-Encoding", compressedRes.encoding);
		headers.delete("Content-Length");

		return (originalFetch as any)(input, {
			...init,
			headers,
			body: new Uint8Array(compressedRes.compressed),
		});
	};
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

export default function requestCompressExtension(pi: ExtensionAPI): void {
	activeConfig = loadConfig();
	activeEnvCtx = resolvePiEnvironment();

	setupFetchHook();

	pi.registerCommand("request-compress", {
		description: "View or toggle HTTP request body compression status (zstd/gzip)",
		handler: async (args, ctx) => {
			const sub = args?.trim().toLowerCase();

			if (sub === "on") {
				activeConfig.enabled = true;
				ctx.ui.notify("Request compression enabled (algorithm: " + activeConfig.algorithm + ")", "info");
				return;
			}

			if (sub === "off") {
				activeConfig.enabled = false;
				ctx.ui.notify("Request compression disabled", "info");
				return;
			}

			if (sub === "reload") {
				activeConfig = loadConfig();
				activeEnvCtx = resolvePiEnvironment();
				ctx.ui.notify("Request compression configuration reloaded", "info");
				return;
			}

			const s = getStats();
			const savedRatio =
				s.originalBytes > 0
					? (((s.originalBytes - s.compressedBytes) / s.originalBytes) * 100).toFixed(1) + "%"
					: "0%";

			const lines = [
				`Request Compression: ${activeConfig.enabled ? "Enabled (ON)" : "Disabled (OFF)"}`,
				`Algorithm: ${activeConfig.algorithm}`,
				`Providers: [${activeConfig.providers.join(", ")}] (Default: ${activeEnvCtx.defaultProvider || "none"})`,
				`Models: [${activeConfig.models.join(", ")}]`,
				`Min Threshold: ${activeConfig.minBytesThreshold} Bytes`,
				`Debug Mode: ${activeConfig.debug ? "ON" : "OFF"}`,
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

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
