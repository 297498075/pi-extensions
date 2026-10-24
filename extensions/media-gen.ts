import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

// ============================================================================
// Schemas (Strictly English descriptions, width/height driven, no duration)
// ============================================================================

export const IMAGE_GENERATION_TIMEOUT_MS = 600_000;

export const GenerateImageSchema = Type.Object({
	async: Type.Optional(Type.Boolean({
		description: "Defaults to true: return a job ID immediately and deliver completion/failure to the Agent automatically. Use false to wait for the final result (e.g. dependent image-to-video calls or one-shot scripts). Do not poll or resubmit a started job.",
	})),
	prompt: Type.String({
		description: "Detailed prompt describing the image to generate, or explicit instructions for editing the input image.",
	}),
	image: Type.Optional(
		Type.String({
			description: "Optional local file path or public URL of an existing image to edit/modify, or use as visual reference.",
		}),
	),
	width: Type.Optional(
		Type.Number({
			minimum: 1,
			description: "Desired image width in pixels. If omitted, uses defaultWidth from media-gen.json or 1024.",
		}),
	),
	height: Type.Optional(
		Type.Number({
			minimum: 1,
			description: "Desired image height in pixels. If omitted, uses defaultHeight from media-gen.json or 1024.",
		}),
	),
});

export const ImageJobStatusSchema = Type.Object({
	jobId: Type.String({
		minLength: 1,
		description: "Job ID returned by an asynchronous generate_image call in the current session/branch. Returns the current status or retained final result immediately; does not wait, retry or generate an image.",
	}),
});

export const GenerateVideoSchema = Type.Object({
	prompt: Type.String({
		description: "Motion and scene prompt describing dynamic movements, camera transformations, and cinematic changes.",
	}),
	image: Type.Optional(
		Type.String({
			description: "Optional local file path or public URL of the first frame / reference image (Image-to-Video). Highly recommended for subject consistency.",
		}),
	),
	width: Type.Optional(
		Type.Number({
			minimum: 1,
			description: "Desired video width in pixels. If omitted, uses defaultWidth from media-gen.json or 1280.",
		}),
	),
	height: Type.Optional(
		Type.Number({
			minimum: 1,
			description: "Desired video height in pixels. If omitted, uses defaultHeight from media-gen.json or 720.",
		}),
	),
});

export type GenerateImageParams = Static<typeof GenerateImageSchema>;
export type GenerateVideoParams = Static<typeof GenerateVideoSchema>;

// ============================================================================
// Dimension & Aspect Ratio Resolver
// ============================================================================

export type StandardAspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "21:9";

export interface ResolvedDimensions {
	requestedWidth: number;
	requestedHeight: number;
	aspectRatio: StandardAspectRatio;
	openAiSize: "1024x1024" | "1792x1024" | "1024x1792" | "512x512";
	alignedWidth: number;
	alignedHeight: number;
}

const STANDARD_RATIOS: Array<{ ratio: number; label: StandardAspectRatio }> = [
	{ ratio: 1.0, label: "1:1" },
	{ ratio: 16 / 9, label: "16:9" },
	{ ratio: 9 / 16, label: "9:16" },
	{ ratio: 4 / 3, label: "4:3" },
	{ ratio: 3 / 4, label: "3:4" },
	{ ratio: 21 / 9, label: "21:9" },
];

/**
 * Automatically computes standard aspect ratio and normalized dimensions from width & height.
 */
export function resolveAspectAndSize(w?: number, h?: number, fallbackW = 1024, fallbackH = 1024): ResolvedDimensions {
	const rawW = typeof w === "number" && w > 0 ? Math.round(w) : fallbackW;
	const rawH = typeof h === "number" && h > 0 ? Math.round(h) : fallbackH;

	const targetRatio = rawW / rawH;

	let bestMatch = STANDARD_RATIOS[0];
	let minDiff = Number.POSITIVE_INFINITY;

	for (const candidate of STANDARD_RATIOS) {
		const diff = Math.abs(candidate.ratio - targetRatio);
		if (diff < minDiff) {
			minDiff = diff;
			bestMatch = candidate;
		}
	}

	let openAiSize: ResolvedDimensions["openAiSize"] = "1024x1024";
	if (bestMatch.label === "16:9" || bestMatch.label === "21:9" || bestMatch.label === "4:3") {
		openAiSize = "1792x1024";
	} else if (bestMatch.label === "9:16" || bestMatch.label === "3:4") {
		openAiSize = "1024x1792";
	} else {
		openAiSize = "1024x1024";
	}

	const alignedWidth = Math.max(64, Math.round(rawW / 64) * 64);
	const alignedHeight = Math.max(64, Math.round(rawH / 64) * 64);

	return {
		requestedWidth: rawW,
		requestedHeight: rawH,
		aspectRatio: bestMatch.label,
		openAiSize,
		alignedWidth,
		alignedHeight,
	};
}

// ============================================================================
// Standalone Configuration (~/.pi/agent/media-gen.json) & models.json Linking
// ============================================================================

export interface MediaToolConfig {
	primaryModel: string;
	/** Image endpoint family. Defaults to images; chat requires explicit opt-in. */
	apiMode?: "images" | "chat";
	/** Fail before async submission if the optional bg_wait bridge is unavailable. */
	requireBackgroundWorkProvider?: boolean;
	fallbackModels?: string[];
	defaultWidth?: number;
	defaultHeight?: number;
	outputDir?: string;
}

export interface MediaGenConfigFile {
	provider: string;
	image?: MediaToolConfig;
	video?: MediaToolConfig;
}

export interface ResolvedProviderInfo {
	providerName: string;
	baseUrl: string;
	apiKey: string;
	availableModels: string[];
}

export interface ResolvedMediaGenContext {
	provider: ResolvedProviderInfo;
	image?: MediaToolConfig;
	video?: MediaToolConfig;
	configFilePath: string;
}

/**
 * Searches for the standalone media-gen.json configuration file.
 * Order of discovery:
 * 1. Current workspace: ./media-gen.json or ./.pi/media-gen.json
 * 2. User agent home: ~/.pi/agent/media-gen.json
 */
function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function resolveEnvValue(value: string): string {
	if (value.startsWith("!")) throw new Error("media-gen does not execute credential commands; use a literal or an environment reference.");
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, plain) => {
		const name = braced || plain;
		const resolved = process.env[name];
		if (resolved === undefined) throw new Error(`Environment variable ${name} is not set.`);
		return resolved;
	});
}

export function findConfigFile(cwd: string = process.cwd()): string | null {
	const candidates = [
		resolve(cwd, "media-gen.json"),
		resolve(cwd, ".pi", "media-gen.json"),
		join(agentDir(), "media-gen.json"),
	];

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	return null;
}

/**
 * Loads the standalone media-gen.json configuration file.
 */
export function loadMediaGenConfigFile(cwd: string = process.cwd()): { config: MediaGenConfigFile; filePath: string } | null {
	const filePath = findConfigFile(cwd);
	if (!filePath) {
		return null;
	}

	try {
		const raw = readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		return { config: parsed, filePath };
	} catch (err: any) {
		throw new Error(`Failed to parse media-gen configuration at ${filePath}: ${err?.message || String(err)}`);
	}
}

/**
 * Reads provider details (baseUrl, apiKey) directly from ~/.pi/agent/models.json
 */
export function resolveProviderFromModelsJson(providerName: string): ResolvedProviderInfo {
	const modelsPath = join(agentDir(), "models.json");
	if (!existsSync(modelsPath)) {
		throw new Error(
			`models.json not found at ${modelsPath}. Cannot resolve provider "${providerName}".`,
		);
	}

	let modelsData: any;
	try {
		const raw = readFileSync(modelsPath, "utf8");
		modelsData = JSON.parse(raw);
	} catch (err: any) {
		throw new Error(`Failed to parse models.json: ${err?.message || String(err)}`);
	}

	const providers = modelsData.providers || {};
	const provider = providers[providerName];

	if (!provider) {
		const available = Object.keys(providers).join(", ") || "none";
		throw new Error(
			`Provider "${providerName}" was not found in models.json. Available providers: ${available}`,
		);
	}

	const baseUrl = resolveEnvValue(String(provider.baseUrl || "")).trim().replace(/\/+$/, "");
	const apiKey = resolveEnvValue(String(provider.apiKey || ""));

	// Extract all configured model ids from provider
	const availableModels: string[] = Array.isArray(provider.models)
		? provider.models.map((m: any) => String(m.id || m.name || "")).filter(Boolean)
		: [];

	if (!baseUrl) {
		throw new Error(`Provider "${providerName}" in models.json is missing a valid baseUrl.`);
	}

	return {
		providerName,
		baseUrl,
		apiKey,
		availableModels,
	};
}

/**
 * Resolves the complete media-gen context without any hardcoded fallback models or environment hacks.
 */
export function getMediaGenContext(cwd: string = process.cwd()): ResolvedMediaGenContext {
	const loaded = loadMediaGenConfigFile(cwd);
	if (!loaded) {
		const expectedPath = join(agentDir(), "media-gen.json");
		throw new Error(
			`Configuration file not found. Please create standalone configuration at: ${expectedPath}`,
		);
	}

	const { config, filePath } = loaded;

	if (!config || typeof config.provider !== "string" || !config.provider.trim()) {
		throw new Error(
			`Invalid media-gen.json at ${filePath}: "provider" field is required and must reference a provider in models.json.`,
		);
	}

	const providerInfo = resolveProviderFromModelsJson(config.provider);

	return {
		provider: providerInfo,
		image: config.image,
		video: config.video,
		configFilePath: filePath,
	};
}

// ============================================================================
// Storage Utilities (Safe Local Output)
// ============================================================================

/**
 * Resolves output directory:
 * - If absolute path: uses absolute path directly
 * - If relative path: resolves against current session launch directory (cwd)
 * - Default: .pi/media
 */
export function resolveOutputDir(outputDir?: string, cwd: string = process.cwd()): string {
	const target = outputDir && outputDir.trim().length > 0 ? outputDir.trim() : ".pi/media";
	return isAbsolute(target) ? target : resolve(cwd, target);
}

/**
 * Generates an asset output path inside the resolved output directory.
 */
export function getMediaOutputPath(type: "images" | "videos", extension: string, outputDir?: string, cwd: string = process.cwd()): string {
	const dir = resolveOutputDir(outputDir, cwd);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
	const rand = randomBytes(4).toString("hex");
	const filename = `${type === "images" ? "img" : "vid"}_${timestamp}_${rand}.${extension.replace(/^\./, "")}`;

	return join(dir, filename);
}

/**
 * Formats a local path into a valid Markdown link URL compatible with Windows and Unix.
 */
export function formatLocalFileUrl(filePath: string): string {
	return pathToFileURL(filePath).href;
}

/**
 * Resolves local file paths or downloads remote image URLs to buffer.
 */
async function loadInputImage(input: string, cwd: string = process.cwd(), signal?: AbortSignal): Promise<{ buffer: Buffer; mimeType: string }> {
	signal?.throwIfAborted();
	let buffer: Buffer;
	if (input.startsWith("http://") || input.startsWith("https://")) {
		const res = await fetch(input, { signal });
		if (!res.ok) {
			throw new Error(`Failed to download input image from URL (${res.status} ${res.statusText})`);
		}
		buffer = Buffer.from(await res.arrayBuffer());
	} else {
		const resolvedPath = isAbsolute(input) ? input : resolve(cwd, input);
		if (!existsSync(resolvedPath)) {
			throw new Error(`Input image file not found at path: ${resolvedPath}`);
		}
		buffer = readFileSync(resolvedPath);
	}

	// Validated bytes, not an object-store header or a misleading file suffix,
	// determine both multipart and data-URI MIME types.
	const extension = imageExtension(buffer);
	return { buffer, mimeType: extension === "jpg" ? "image/jpeg" : `image/${extension}` };
}

/** Reject error pages/empty payloads, and keep file extensions consistent with the bytes. */
function imageExtension(buffer: Buffer): string {
	if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
	if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
	if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("ascii"))) return "gif";
	if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
	throw new Error("API returned an empty or unsupported image payload (expected PNG/JPEG/GIF/WebP).");
}

/** Container-signature validation, not a claim that a decoder has verified playback. */
function videoExtension(buffer: Buffer): "mp4" | "webm" {
	if (buffer.length >= 16 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
		const boxSize = buffer.readUInt32BE(0);
		if (boxSize >= 16 && boxSize <= buffer.length) return "mp4";
	}
	if (buffer.length >= 8 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "webm";
	throw new Error("API returned an empty or unsupported video payload (expected MP4/WebM).");
}

async function downloadImage(url: string, signal?: AbortSignal): Promise<Buffer> {
	const response = await fetch(url, { signal });
	if (!response.ok) throw new Error(`Image download returned HTTP ${response.status}`);
	const buffer = Buffer.from(await response.arrayBuffer());
	imageExtension(buffer);
	return buffer;
}

// ============================================================================
// Image Generation Pipeline with Waterfall Model Fallback
// ============================================================================

export interface ImageExecutionResult {
	filePath: string;
	usedModel: string;
	mode: "Text-to-Image" | "Image-to-Image (Edit)";
	dimensions: ResolvedDimensions;
	fileSize: number;
}

export interface ImageApiFailure {
	endpoint: string;
	status: number;
	requestId: string | null;
	responseBody: string;
	policyRejected: boolean;
	retryable: boolean;
	modelFallbackAllowed: boolean;
}

interface ImageAttemptFailure {
	model: string;
	error: string;
	http?: ImageApiFailure;
}

function redactApiError(text: string, apiKey: string): string {
	let safe = text;
	if (apiKey) {
		const forms = new Set([apiKey, JSON.stringify(apiKey).slice(1, -1), encodeURIComponent(apiKey)]);
		for (const value of [...forms].sort((a, b) => b.length - a.length)) safe = safe.split(value).join("[REDACTED]");
	}
	return safe.replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]");
}

class ImageApiError extends Error {
	readonly failure: ImageApiFailure;

	constructor(endpoint: string, response: Response, body: string, apiKey: string) {
		const responseBody = redactApiError(body, apiKey);
		const requestId = response.headers.get("x-request-id") || response.headers.get("request-id") || response.headers.get("cf-ray");
		const safeRequestId = requestId ? redactApiError(requestId, apiKey) : null;
		const policyRejected = /content[_ -]?policy|policy[_ -]?violation|safety|moderation|content[_ -]?filter/i.test(body);
		const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
		const modelFallbackAllowed = !policyRejected && (response.status === 404 ||
			([400, 422].includes(response.status) && /model[_ -](?:not[_ -]found|unsupported|not[_ -]supported)/i.test(body)));
		super(`${endpoint}: HTTP ${response.status}${safeRequestId ? ` (request ID: ${safeRequestId})` : ""}\n${responseBody}`);
		this.name = "ImageApiError";
		this.failure = { endpoint, status: response.status, requestId: safeRequestId, responseBody, policyRejected, retryable, modelFallbackAllowed };
	}
}

class ImageGenerationError extends Error {
	readonly attempts: ImageAttemptFailure[];

	constructor(attempts: ImageAttemptFailure[]) {
		super(`Image generation failed: ${attempts.map(attempt => `[${attempt.model}]: ${attempt.error}`).join(" | ")}`);
		this.name = "ImageGenerationError";
		this.attempts = attempts;
	}
}

export async function executeImageGeneration(
	params: GenerateImageParams,
	mediaConfig: MediaToolConfig,
	provider: ResolvedProviderInfo,
	cwd: string = process.cwd(),
	signal?: AbortSignal,
): Promise<ImageExecutionResult> {
	signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS)]);
	signal.throwIfAborted();
	if (!mediaConfig.primaryModel || mediaConfig.primaryModel.trim().length === 0) {
		throw new Error(`image.primaryModel is not configured in media-gen.json.`);
	}

	// Prepare waterfall model list: primaryModel first, followed by fallbackModels in exact order
	const candidateModels = [
		mediaConfig.primaryModel.trim(),
		...(mediaConfig.fallbackModels || []).map((m) => m.trim()).filter(Boolean),
	];

	// Remove duplicate consecutive entries
	const modelsToTry = candidateModels.filter((model, idx) => candidateModels.indexOf(model) === idx);

	const defaultW = mediaConfig.defaultWidth || 1024;
	const defaultH = mediaConfig.defaultHeight || 1024;
	const dims = resolveAspectAndSize(params.width, params.height, defaultW, defaultH);
	const isEdit = Boolean(params.image && params.image.trim().length > 0);
	const apiMode = mediaConfig.apiMode ?? "images";
	if (apiMode !== "images" && apiMode !== "chat") throw new Error("image.apiMode must be images or chat.");

	const attemptErrors: ImageAttemptFailure[] = [];

	for (const model of modelsToTry) {
		try {
			const imageBuffer = await callImageApi({
				provider,
				model,
				prompt: params.prompt,
				imageInput: params.image,
				dimensions: dims,
				isEdit,
				apiMode,
				cwd,
				signal,
			});

			signal.throwIfAborted();
			const extension = imageExtension(imageBuffer);
			const outPath = getMediaOutputPath("images", extension, mediaConfig.outputDir, cwd);
			writeFileSync(outPath, imageBuffer);

			return {
				filePath: outPath,
				usedModel: model,
				mode: isEdit ? "Image-to-Image (Edit)" : "Text-to-Image",
				dimensions: dims,
				fileSize: imageBuffer.length,
			};
		} catch (err: any) {
			signal.throwIfAborted();
			attemptErrors.push({ model, error: redactApiError(err?.message || String(err), provider.apiKey), ...(err instanceof ImageApiError ? { http: err.failure } : {}) });
			// Never turn a transient failure, refusal, auth error or invalid request into extra attempts.
			if (err instanceof TypeError || (err instanceof ImageApiError && !err.failure.modelFallbackAllowed)) break;
		}
	}

	throw new ImageGenerationError(attemptErrors);
}

async function readImageApiResponse(
	response: Response, endpoint: string, apiKey: string, signal?: AbortSignal, chat = false,
): Promise<Buffer> {
	const body = await response.text();
	if (!response.ok) throw new ImageApiError(endpoint, response, body, apiKey);
	let data: any;
	try {
		data = JSON.parse(body);
	} catch {
		throw new ImageApiError(endpoint, response, body, apiKey);
	}
	if (data?.error) throw new ImageApiError(endpoint, response, body, apiKey);
	if (chat) {
		const extracted = await extractImageFromChatMessage(data?.choices?.[0]?.message, signal);
		if (extracted) return extracted;
	} else {
		const b64 = data?.data?.[0]?.b64_json;
		if (b64) return Buffer.from(b64, "base64");
		const url = data?.data?.[0]?.url;
		if (url) return downloadImage(url, signal);
	}
	throw new ImageApiError(endpoint, response, body, apiKey);
}

async function callImageApi(options: {
	provider: ResolvedProviderInfo;
	model: string;
	prompt: string;
	imageInput?: string;
	dimensions: ResolvedDimensions;
	isEdit: boolean;
	apiMode: "images" | "chat";
	cwd: string;
	signal?: AbortSignal;
}): Promise<Buffer> {
	const { provider, model, prompt, imageInput, dimensions, isEdit, apiMode, cwd, signal } = options;

	// Chat-capable models must opt in. Never change endpoints after a failed request.
	if (apiMode === "chat") {
		let content: string | Array<Record<string, unknown>> = prompt;
		if (isEdit && imageInput) {
			const { buffer, mimeType } = await loadInputImage(imageInput, cwd, signal);
			content = [
				{ type: "text", text: `Edit this image according to instructions: ${prompt}` },
				{ type: "image_url", image_url: { url: `data:${mimeType};base64,${buffer.toString("base64")}` } },
			];
		}
		const endpoint = "/chat/completions";
		const response = await fetch(`${provider.baseUrl}${endpoint}`, {
			signal, method: "POST",
			headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({ model, messages: [{ role: "user", content }] }),
		});
		return readImageApiResponse(response, endpoint, provider.apiKey, signal, true);
	}

	if (isEdit && imageInput) {
		const { buffer, mimeType } = await loadInputImage(imageInput, cwd, signal);
		const formData = new FormData();
		const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
		formData.append("image", blob, `image.${imageExtension(buffer)}`);
		formData.append("model", model);
		formData.append("prompt", prompt);
		formData.append("size", dimensions.openAiSize);
		formData.append("response_format", "b64_json");
		const endpoint = "/images/edits";
		const response = await fetch(`${provider.baseUrl}${endpoint}`, {
			signal, method: "POST",
			headers: { Authorization: `Bearer ${provider.apiKey}` },
			body: formData,
		});
		return readImageApiResponse(response, endpoint, provider.apiKey, signal);
	}

	const endpoint = "/images/generations";
	const response = await fetch(`${provider.baseUrl}${endpoint}`, {
		signal, method: "POST",
		headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model, prompt, n: 1, size: dimensions.openAiSize, response_format: "b64_json" }),
	});
	return readImageApiResponse(response, endpoint, provider.apiKey, signal);
}

/**
 * Resolves a direct image URL or base64 data URI into a Buffer.
 */
export async function resolveUrlOrDataUriToBuffer(urlOrDataUri: string, signal?: AbortSignal): Promise<Buffer | null> {
	signal?.throwIfAborted();
	if (!urlOrDataUri || typeof urlOrDataUri !== "string") return null;
	const match = urlOrDataUri.match(/^data:image\/[a-zA-Z0-9+.-]+;base64,(.+)$/);
	if (match) {
		const buffer = Buffer.from(match[1], "base64");
		imageExtension(buffer);
		return buffer;
	}
	if (urlOrDataUri.startsWith("http://") || urlOrDataUri.startsWith("https://")) {
		return downloadImage(urlOrDataUri, signal);
	}
	return null;
}

/**
 * Extracts image buffer from various OpenAI-compatible /chat/completions multimodal responses
 * (such as Gemini, Claude, Qwen, or proxy aggregators that return images in message.images or message.content).
 */
export async function extractImageFromChatMessage(msg: any, signal?: AbortSignal): Promise<Buffer | null> {
	if (!msg) return null;

	// Format 1: Direct images field (e.g., OneAPI/NewAPI/yqdcc OpenAI-compatible Gemini or Claude image format)
	if (Array.isArray(msg.images) && msg.images.length > 0) {
		for (const imgItem of msg.images) {
			const rawUrl = typeof imgItem === "string" ? imgItem : imgItem?.image_url?.url || imgItem?.url || "";
			if (rawUrl) {
				const buf = await resolveUrlOrDataUriToBuffer(rawUrl, signal);
				if (buf) return buf;
			}
		}
	}

	// Format 2: Multimodal array inside message.content
	if (Array.isArray(msg.content)) {
		for (const part of msg.content) {
			const rawUrl = part?.image_url?.url || part?.url;
			if (rawUrl) {
				const buf = await resolveUrlOrDataUriToBuffer(rawUrl, signal);
				if (buf) return buf;
			}
			if (typeof part?.text === "string") {
				const buf = await extractImageFromString(part.text, signal);
				if (buf) return buf;
			}
		}
	}

	// Format 3: String message.content
	if (typeof msg.content === "string") {
		return await extractImageFromString(msg.content, signal);
	}

	return null;
}

async function extractImageFromString(content: string, signal?: AbortSignal): Promise<Buffer | null> {
	if (!content) return null;

	// Markdown image syntax: ![...](url or data URI)
	const mdMatch = content.match(/!\[.*?\]\((https?:\/\/[^\s)]+|data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+)\)/);
	if (mdMatch?.[1]) {
		const buf = await resolveUrlOrDataUriToBuffer(mdMatch[1], signal);
		if (buf) return buf;
	}

	// Direct base64 data URI in text
	const b64Match = content.match(/data:image\/[a-zA-Z0-9+.-]+;base64,([A-Za-z0-9+/=]+)/);
	if (b64Match?.[1]) {
		return resolveUrlOrDataUriToBuffer(b64Match[0], signal);
	}

	// Standalone image URL
	const urlMatch = content.match(/(https?:\/\/[^\s)]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s)]*)?)/i);
	if (urlMatch?.[1]) {
		const buf = await resolveUrlOrDataUriToBuffer(urlMatch[1], signal);
		if (buf) return buf;
	}

	return null;
}

// ============================================================================
// Video Generation Pipeline with Waterfall Model Fallback
// ============================================================================

export interface VideoExecutionResult {
	filePath: string;
	usedModel: string;
	dimensions: ResolvedDimensions;
}

export async function executeVideoGeneration(
	params: GenerateVideoParams,
	mediaConfig: MediaToolConfig,
	provider: ResolvedProviderInfo,
	cwd: string = process.cwd(),
	signal?: AbortSignal,
): Promise<VideoExecutionResult> {
	signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(300_000)]);
	signal.throwIfAborted();
	if (!mediaConfig.primaryModel || mediaConfig.primaryModel.trim().length === 0) {
		throw new Error(`video.primaryModel is not configured in media-gen.json.`);
	}

	const candidateModels = [
		mediaConfig.primaryModel.trim(),
		...(mediaConfig.fallbackModels || []).map((m) => m.trim()).filter(Boolean),
	];
	const modelsToTry = candidateModels.filter((model, idx) => candidateModels.indexOf(model) === idx);

	const defaultW = mediaConfig.defaultWidth || 1280;
	const defaultH = mediaConfig.defaultHeight || 720;
	const dims = resolveAspectAndSize(params.width, params.height, defaultW, defaultH);

	const attemptErrors: Array<{ model: string; error: string }> = [];

	for (const model of modelsToTry) {
		try {
			const videoUrlOrBuffer = await callVideoApi({
				provider,
				model,
				prompt: params.prompt,
				imageInput: params.image,
				dimensions: dims,
				cwd,
				signal,
			});

			signal.throwIfAborted();
			let buffer: Buffer;
			if (Buffer.isBuffer(videoUrlOrBuffer)) {
				buffer = videoUrlOrBuffer;
			} else {
				const dlRes = await fetch(videoUrlOrBuffer, { signal });
				if (!dlRes.ok) {
					throw new Error(`Failed to download video from ${videoUrlOrBuffer}: ${dlRes.status}`);
				}
				buffer = Buffer.from(await dlRes.arrayBuffer());
			}
			signal.throwIfAborted();
			const extension = videoExtension(buffer);
			const outPath = getMediaOutputPath("videos", extension, mediaConfig.outputDir, cwd);
			writeFileSync(outPath, buffer);

			return {
				filePath: outPath,
				usedModel: model,
				dimensions: dims,
			};
		} catch (err: any) {
			signal.throwIfAborted();
			attemptErrors.push({ model, error: err?.message || String(err) });
		}
	}

	const errorSummary = attemptErrors.map((e) => `[${e.model}]: ${e.error}`).join(" | ");
	throw new Error(`All configured video models failed: ${errorSummary}`);
}

async function callVideoApi(options: {
	provider: ResolvedProviderInfo;
	model: string;
	prompt: string;
	imageInput?: string;
	dimensions: ResolvedDimensions;
	cwd: string;
	signal?: AbortSignal;
}): Promise<string | Buffer> {
	const { provider, model, prompt, imageInput, dimensions, cwd, signal } = options;
	let imageUrl = imageInput;
	if (imageInput && !/^https?:\/\//i.test(imageInput)) {
		const { buffer, mimeType } = await loadInputImage(imageInput, cwd, signal);
		imageUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
	}

	// Standard video dispatch endpoint on CPA / Gateway
	const endpoint = `${provider.baseUrl}/videos/generations`;
	const res = await fetch(endpoint, {
		signal,
		method: "POST",
		headers: {
			Authorization: `Bearer ${provider.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model,
			prompt,
			image_url: imageUrl,
			aspect_ratio: dimensions.aspectRatio,
			width: dimensions.alignedWidth,
			height: dimensions.alignedHeight,
		}),
	});

	if (res.ok) {
		const data = (await res.json()) as any;
		const videoUrl = data?.data?.[0]?.url || data?.url;
		if (videoUrl) {
			return videoUrl;
		}
		const b64 = data?.data?.[0]?.b64_json;
		if (b64) {
			return Buffer.from(b64, "base64");
		}
	}

	const errText = await res.text().catch(() => "");
	throw new Error(`Video generation API returned HTTP ${res.status}: ${errText.slice(0, 200)}`);
}

// ============================================================================
// Model Guidance & Error Reporting Utilities
// ============================================================================

/**
 * Formats a comprehensive, actionable error report when media-gen.json or primaryModel is missing.
 */
export function formatMissingModelReport(
	toolType: "image" | "video",
	context: ResolvedMediaGenContext | null,
	errorMessage?: string,
): string {
	const lines: string[] = [];
	lines.push(`### ⚠️ Media-Gen Configuration Required: Missing ${toolType.toUpperCase()} Model`);
	lines.push("");

	if (errorMessage) {
		lines.push(`**Issue**: ${errorMessage}`);
		lines.push("");
	}

	const globalConfigPath = join(agentDir(), "media-gen.json");
	lines.push(`**Configuration Path**: \`${context?.configFilePath || globalConfigPath}\``);
	lines.push("");

	if (context?.provider) {
		const prov = context.provider;
		lines.push(`**Active Provider**: \`${prov.providerName}\` (Base URL: \`${prov.baseUrl}\`)`);
		lines.push("");

		if (prov.availableModels.length > 0) {
			lines.push(`**Models declared in models.json under \`${prov.providerName}\`**:`);
			for (const id of prov.availableModels) {
				const isSuggested =
					toolType === "image"
						? id.toLowerCase().includes("image") || id.toLowerCase().includes("flash")
						: id.toLowerCase().includes("video") || id.toLowerCase().includes("wanx");
				lines.push(`- \`${id}\`${isSuggested ? " *(Recommended)*" : ""}`);
			}
			lines.push("");
		} else {
			lines.push(`*(Note: No explicit models listed under "${prov.providerName}" in models.json)*`);
			lines.push("");
		}

		const sampleModel =
			(toolType === "image"
				? prov.availableModels.find((m) => m.includes("image"))
				: prov.availableModels.find((m) => m.includes("video"))) ||
			prov.availableModels[0] ||
			(toolType === "image" ? "gpt-image-2.5-flare" : "cogvideox-5b");

		lines.push("**How to resolve**: Add the configuration below to your `media-gen.json`:");
		lines.push("```json");
		lines.push(
			JSON.stringify(
				{
					provider: prov.providerName,
					[toolType]: {
						primaryModel: sampleModel,
						fallbackModels: prov.availableModels.filter((m) => m !== sampleModel).slice(0, 2),
						defaultWidth: toolType === "image" ? 1024 : 1280,
						defaultHeight: toolType === "image" ? 1024 : 720,
						outputDir: ".pi/media",
					},
				},
				null,
				2,
			),
		);
		lines.push("```");
	} else {
		// No provider resolved yet
		lines.push("**How to resolve**: Create `media-gen.json` pointing to a valid provider from `models.json`:");
		lines.push("```json");
		lines.push(
			JSON.stringify(
				{
					provider: "yqdcc",
					[toolType]: {
						primaryModel: toolType === "image" ? "gemini-3.1-flash-image" : "cogvideox-5b",
						fallbackModels: toolType === "image" ? ["gpt-image-2.5-flare"] : [],
						outputDir: ".pi/media",
					},
				},
				null,
				2,
			),
		);
		lines.push("```");
	}

	return lines.join("\n");
}

interface ImageJobDetails {
	jobId: string;
	toolCallId: string;
	status: "running" | "completed" | "failed";
	startedAt: string;
	finishedAt?: string;
	timeoutMs: number;
	filePath?: string;
	model?: string;
	dimensions?: ResolvedDimensions;
	error?: string;
	attempts?: ImageAttemptFailure[];
}

interface ImageJob {
	ownerSessionId: string;
	controller?: AbortController;
	details: ImageJobDetails;
	report: string;
}

interface ImageBackgroundWorkProvider {
	name: string;
	wakeChannels: string[];
	listActiveWork(context?: { sessionId: string; nowMs: number }): { id: string; sessionId: string }[];
}

// Use only pi-subagents' public export; do not reproduce its process-local registry.
async function loadBackgroundWorkRegistration(): Promise<(provider: ImageBackgroundWorkProvider) => () => void> {
	const specifier = "pi-subagents/background-work";
	let entry: string;
	try {
		entry = createRequire(import.meta.url).resolve(specifier);
	} catch {
		entry = createRequire(join(getAgentDir(), "npm", "package.json")).resolve(specifier);
	}
	const api = await import(pathToFileURL(entry).href);
	if (typeof api.registerBackgroundWorkProvider !== "function") {
		throw new Error("pi-subagents/background-work does not export registerBackgroundWorkProvider");
	}
	return api.registerBackgroundWorkProvider;
}

export default function mediaGenExtension(pi: ExtensionAPI): void {
	// Retain final results for read-only queries within this session/branch only.
	const imageJobs = new Map<string, ImageJob>();
	const providerName = `media-gen-${randomUUID()}`;
	const wakeChannel = `${providerName}:finished`;
	let disposeProvider: (() => void) | undefined;
	let sessionEpoch = 0;
	const ensureBackgroundWorkProvider = async (epoch: number) => {
		if (disposeProvider) return;
		const register = await loadBackgroundWorkRegistration();
		if (epoch !== sessionEpoch) throw new Error("Session/branch changed before background-work registration");
		if (disposeProvider) return;
		const dispose = register({
			name: providerName,
			wakeChannels: [wakeChannel],
			listActiveWork: (context) => [...imageJobs.values()]
				.filter(job => job.details.status === "running" && (!context || job.ownerSessionId === context.sessionId))
				.map(job => ({ id: job.details.jobId, sessionId: job.ownerSessionId })),
		});
		if (typeof dispose !== "function") throw new Error("Background-work registration did not return a disposer");
		disposeProvider = dispose;
	};
	const cancelImageJobs = () => {
		sessionEpoch++;
		for (const job of imageJobs.values()) job.controller?.abort();
		imageJobs.clear();
		try { disposeProvider?.(); } finally {
			disposeProvider = undefined;
			pi.events.emit(wakeChannel, {});
		}
	};
	pi.on("session_shutdown", cancelImageJobs);
	pi.on("session_tree", cancelImageJobs);

	pi.registerTool<typeof ImageJobStatusSchema, ImageJobDetails | { jobId: string; status: "not_found"; error: string }>({
		name: "image_job_status",
		label: "Image Job Status",
		description: "Query an asynchronous image job without waiting. Returns running, completed (with image path) or failed (with error). Final results can be read repeatedly in the current session/branch; reload, session replacement or tree navigation clears the cache. Unknown IDs return not_found. Completion is still delivered automatically; do not busy-poll. Does not cancel, retry or start generation.",
		parameters: ImageJobStatusSchema,
		async execute(_toolCallId, params) {
			const jobId = params.jobId.trim();
			const job = imageJobs.get(jobId);
			if (!job) {
				return {
					content: [{ type: "text", text: `Image job ${jobId || "(empty ID)"}: not_found. No record in the current session/branch. The ID may be invalid or the cache may have been cleared by reload/session replacement/tree navigation. This does not prove that upstream generation failed; do not automatically resubmit.` }],
					isError: true,
					details: { jobId, status: "not_found", error: "No image job record in the current session/branch" },
				};
			}
			return {
				content: [{ type: "text", text: [
					`Image generation job ${jobId}: ${job.details.status}`,
					`Started: ${job.details.startedAt}`,
					...(job.details.finishedAt ? [`Finished: ${job.details.finishedAt}`] : []),
					"", job.report,
				].join("\n") }],
				details: structuredClone(job.details),
			};
		},
	});

	// --------------------------------------------------------------------------
	// Tool 1: generate_image
	// --------------------------------------------------------------------------
	pi.registerTool({
		name: "generate_image",
		label: "Generate Image",
		description:
			"Generate or edit an image. By default starts a background job and returns its ID immediately, not an image path. Completion or failure is delivered automatically to the Agent; use image_job_status for an on-demand status/result lookup, not busy-polling or resubmission. Use async:false to wait for the final result. Uses a 10-minute total deadline, automatic aspect ratio and configured fallback models.",
		parameters: GenerateImageSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typedParams = params as GenerateImageParams;
			if (!typedParams.prompt || typedParams.prompt.trim().length === 0) {
				return {
					content: [{ type: "text", text: "Error: Prompt cannot be empty." }],
					isError: true,
					details: { error: "Empty prompt" },
				};
			}

			let context: ResolvedMediaGenContext | null = null;
			try {
				context = getMediaGenContext(ctx.cwd);
			} catch (err: any) {
				const report = formatMissingModelReport("image", null, err?.message || String(err));
				ctx.ui?.notify?.("media-gen: Configuration missing or invalid", "warning");
				return {
					content: [{ type: "text", text: report }],
					isError: true,
					details: { error: err?.message || String(err) },
				};
			}

			if (!context.image || !context.image.primaryModel) {
				const report = formatMissingModelReport(
					"image",
					context,
					`"image.primaryModel" is not configured in ${context.configFilePath}`,
				);
				ctx.ui?.notify?.("media-gen: image.primaryModel not configured", "warning");
				return {
					content: [{ type: "text", text: report }],
					isError: true,
					details: { error: "Missing image.primaryModel" },
				};
			}

			if (_signal?.aborted) {
				return {
					content: [{ type: "text", text: "Image generation cancelled before starting." }],
					isError: true,
					details: { error: "Cancelled before starting" },
				};
			}

			const imageConfig = context.image;
			const provider = context.provider;
			const cwd = ctx.cwd;
			const generate = async (signal?: AbortSignal) => {
				try {
					const result = await executeImageGeneration(typedParams, imageConfig, provider, cwd, signal);
					const fileUrl = formatLocalFileUrl(result.filePath);
					const filename = basename(result.filePath);

					const report = [
						"### Image Generation Complete",
						"",
						`![${filename}](${fileUrl})`,
						"",
						`- **File Path**: \`${result.filePath}\``,
						`- **Mode**: ${result.mode}`,
						`- **Model Used**: \`${result.usedModel}\` (Provider: \`${provider.providerName}\`)`,
						`- **Resolution**: ${result.dimensions.requestedWidth}x${result.dimensions.requestedHeight} (Aspect Ratio: \`${result.dimensions.aspectRatio}\`)`,
						`- **File Size**: ${(result.fileSize / 1024).toFixed(1)} KB`,
					].join("\n");

					return {
						content: [{ type: "text" as const, text: report }],
						details: {
							filePath: result.filePath,
							model: result.usedModel,
							dimensions: result.dimensions,
						},
					};
				} catch (err: any) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Image generation failed: ${err?.message || String(err)}`,
							},
						],
						isError: true,
						details: { error: err?.message || String(err), ...(err instanceof ImageGenerationError ? { attempts: err.attempts } : {}) },
					};
				}
			};

			if (typedParams.async === false) return generate(_signal);

			const epoch = sessionEpoch;
			let backgroundWorkError: string | undefined;
			try {
				await ensureBackgroundWorkProvider(epoch);
			} catch (error) {
				backgroundWorkError = error instanceof Error ? error.message : String(error);
			}
			if (epoch !== sessionEpoch || _signal?.aborted || (imageConfig.requireBackgroundWorkProvider && backgroundWorkError)) {
				const error = epoch !== sessionEpoch || _signal?.aborted
					? "Cancelled before starting: session/branch changed or tool aborted"
					: `Required background-work provider unavailable: ${backgroundWorkError}`;
				return { content: [{ type: "text", text: error }], isError: true, details: { error } };
			}
			const ownerSessionId = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
			const jobId = randomUUID();
			const controller = new AbortController();
			const job: ImageJob = {
				ownerSessionId,
				controller,
				details: { jobId, toolCallId: _toolCallId, status: "running", startedAt: new Date().toISOString(), timeoutMs: IMAGE_GENERATION_TIMEOUT_MS },
				report: "Local image generation is in progress; upstream acceptance/progress is not known. Completion or failure will be delivered automatically. Do not busy-poll or resubmit.",
			};
			imageJobs.set(jobId, job);
			void generate(controller.signal).then((result) => {
				if (imageJobs.get(jobId) !== job) return; // Session/branch was replaced or shut down.
				// Store before notification so delivery failures do not lose the queryable result.
				job.details = { ...job.details, ...result.details, status: result.isError ? "failed" : "completed", finishedAt: new Date().toISOString() };
				job.report = result.content.map(part => part.text).join("\n");
				job.controller = undefined;
				pi.sendMessage({
					customType: "media-gen-image-result",
					content: `Image generation job ${jobId}: ${job.details.status}\n\n${job.report}`,
					display: true,
					details: structuredClone(job.details),
				}, { deliverAs: "followUp", triggerTurn: true });
			}).finally(() => {
				// Wake after storing the result and attempting the single follow-up delivery.
				if (imageJobs.get(jobId) === job) pi.events.emit(wakeChannel, {});
			}).catch(() => {
				// Delivery errors must not become unhandled rejections or trigger duplicate paid requests.
				if (imageJobs.has(jobId)) console.error(`media-gen: Could not deliver image job ${jobId} result.`);
			});

			return {
				content: [{ type: "text", text: `Image generation started in the background. Job ID: ${jobId}. Local execution has started; upstream acceptance is not yet confirmed. Completion or failure will be delivered automatically to the Agent. Use image_job_status with this job ID for an on-demand lookup; do not busy-poll or resubmit. ${disposeProvider ? "Background-work provider registered: use bg_wait({ all: true, timeoutMs: 660000 }) without an id in this same session to stay alive until current work finishes." : `Background-work provider unavailable (${backgroundWorkError}); automatic delivery requires this session to remain alive.`} Total timeout: 10 minutes.` }],
				details: { jobId, toolCallId: _toolCallId, status: "started", timeoutMs: IMAGE_GENERATION_TIMEOUT_MS, backgroundWorkProvider: disposeProvider ? "registered" : "unavailable", ...(backgroundWorkError ? { backgroundWorkError } : {}) },
			};
		},
	});

	// --------------------------------------------------------------------------
	// Tool 2: generate_video
	// --------------------------------------------------------------------------
	pi.registerTool({
		name: "generate_video",
		label: "Generate Video",
		description:
			"Generate dynamic video clips from text descriptions (Text-to-Video) or animate a reference image / first frame (Image-to-Video). Automatically computes aspect ratio and handles configured fallback models.",
		parameters: GenerateVideoSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typedParams = params as GenerateVideoParams;
			if (!typedParams.prompt || typedParams.prompt.trim().length === 0) {
				return {
					content: [{ type: "text", text: "Error: Video prompt cannot be empty." }],
					isError: true,
					details: { error: "Empty prompt" },
				};
			}

			let context: ResolvedMediaGenContext | null = null;
			try {
				context = getMediaGenContext(ctx.cwd);
			} catch (err: any) {
				const report = formatMissingModelReport("video", null, err?.message || String(err));
				ctx.ui?.notify?.("media-gen: Configuration missing or invalid", "warning");
				return {
					content: [{ type: "text", text: report }],
					isError: true,
					details: { error: err?.message || String(err) },
				};
			}

			if (!context.video || !context.video.primaryModel) {
				const report = formatMissingModelReport(
					"video",
					context,
					`"video.primaryModel" is not configured in ${context.configFilePath}`,
				);
				ctx.ui?.notify?.("media-gen: video.primaryModel not configured", "warning");
				return {
					content: [{ type: "text", text: report }],
					isError: true,
					details: { error: "Missing video.primaryModel" },
				};
			}

			try {
				const result = await executeVideoGeneration(typedParams, context.video, context.provider, ctx.cwd, _signal);
				const fileUrl = formatLocalFileUrl(result.filePath);

				return {
					content: [
						{
							type: "text",
							text: [
								"### Video Generation Complete",
								"",
								`- **Local File**: \`${result.filePath}\``,
								`- **Model Used**: \`${result.usedModel}\` (Provider: \`${context.provider.providerName}\`)`,
								`- **Resolution**: ${result.dimensions.alignedWidth}x${result.dimensions.alignedHeight} (\`${result.dimensions.aspectRatio}\`)`,
								`- **Link**: [Play Video](${fileUrl})`,
							].join("\n"),
						},
					],
					details: {
						filePath: result.filePath,
						model: result.usedModel,
						dimensions: result.dimensions,
					},
				};
			} catch (err: any) {
				return {
					content: [
						{
							type: "text",
							text: `Video generation failed: ${err?.message || String(err)}`,
						},
					],
					isError: true,
					details: { error: err?.message || String(err) },
				};
			}
		},
	});
}
