import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

// ============================================================================
// Schemas (Strictly English descriptions, width/height driven, no duration)
// ============================================================================

export const GenerateImageSchema = Type.Object({
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
			description: "Desired image width in pixels. If omitted, uses defaultWidth from media-gen.json or 1024.",
		}),
	),
	height: Type.Optional(
		Type.Number({
			description: "Desired image height in pixels. If omitted, uses defaultHeight from media-gen.json or 1024.",
		}),
	),
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
			description: "Desired video width in pixels. If omitted, uses defaultWidth from media-gen.json or 1280.",
		}),
	),
	height: Type.Optional(
		Type.Number({
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
export function findConfigFile(cwd: string = process.cwd()): string | null {
	const candidates = [
		resolve(cwd, "media-gen.json"),
		resolve(cwd, ".pi", "media-gen.json"),
		join(homedir(), ".pi", "agent", "media-gen.json"),
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
	const modelsPath = join(homedir(), ".pi", "agent", "models.json");
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

	let baseUrl = (provider.baseUrl || "").trim().replace(/\/+$/, "");
	let apiKey = String(provider.apiKey || "");

	// Extract all configured model ids from provider
	const availableModels: string[] = Array.isArray(provider.models)
		? provider.models.map((m: any) => String(m.id || m.name || "")).filter(Boolean)
		: [];

	// Expand $ENV_VAR if defined in models.json
	if (apiKey.startsWith("$")) {
		const envVar = apiKey.slice(1);
		apiKey = process.env[envVar] || "";
	}

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
		const expectedPath = join(homedir(), ".pi", "agent", "media-gen.json");
		throw new Error(
			`Configuration file not found. Please create standalone configuration at: ${expectedPath}`,
		);
	}

	const { config, filePath } = loaded;

	if (!config.provider || typeof config.provider !== "string") {
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
	const normalized = filePath.replace(/\\/g, "/");
	if (/^[a-zA-Z]:/.test(normalized)) {
		return `file:///${normalized}`;
	}
	return `file://${normalized}`;
}

/**
 * Resolves local file paths or downloads remote image URLs to buffer.
 */
async function loadInputImage(input: string, cwd: string = process.cwd()): Promise<{ buffer: Buffer; mimeType: string }> {
	if (input.startsWith("http://") || input.startsWith("https://")) {
		const res = await fetch(input);
		if (!res.ok) {
			throw new Error(`Failed to download input image from URL (${res.status} ${res.statusText})`);
		}
		const arrayBuf = await res.arrayBuffer();
		const mime = res.headers.get("content-type") || "image/png";
		return { buffer: Buffer.from(arrayBuf), mimeType: mime };
	}

	const resolvedPath = isAbsolute(input) ? input : resolve(cwd, input);
	if (!existsSync(resolvedPath)) {
		throw new Error(`Input image file not found at path: ${resolvedPath}`);
	}

	const buffer = readFileSync(resolvedPath);
	const ext = extname(resolvedPath).toLowerCase();
	let mimeType = "image/png";
	if (ext === ".jpg" || ext === ".jpeg") mimeType = "image/jpeg";
	else if (ext === ".webp") mimeType = "image/webp";
	else if (ext === ".gif") mimeType = "image/gif";

	return { buffer, mimeType };
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

export async function executeImageGeneration(
	params: GenerateImageParams,
	mediaConfig: MediaToolConfig,
	provider: ResolvedProviderInfo,
	cwd: string = process.cwd(),
): Promise<ImageExecutionResult> {
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

	const attemptErrors: Array<{ model: string; error: string }> = [];

	for (const model of modelsToTry) {
		try {
			const imageBuffer = await callImageApi({
				provider,
				model,
				prompt: params.prompt,
				imageInput: params.image,
				dimensions: dims,
				isEdit,
				cwd,
			});

			const outPath = getMediaOutputPath("images", "png", mediaConfig.outputDir, cwd);
			writeFileSync(outPath, imageBuffer);

			return {
				filePath: outPath,
				usedModel: model,
				mode: isEdit ? "Image-to-Image (Edit)" : "Text-to-Image",
				dimensions: dims,
				fileSize: imageBuffer.length,
			};
		} catch (err: any) {
			attemptErrors.push({ model, error: err?.message || String(err) });
			// Waterfall fallback: automatically advance to next model in sequence
		}
	}

	const errorSummary = attemptErrors.map((e) => `[${e.model}]: ${e.error}`).join(" | ");
	throw new Error(`All configured image models failed: ${errorSummary}`);
}

async function callImageApi(options: {
	provider: ResolvedProviderInfo;
	model: string;
	prompt: string;
	imageInput?: string;
	dimensions: ResolvedDimensions;
	isEdit: boolean;
	cwd: string;
}): Promise<Buffer> {
	const { provider, model, prompt, imageInput, dimensions, isEdit, cwd } = options;

	// Branch 1: Image editing / Image-to-Image
	if (isEdit && imageInput) {
		const { buffer, mimeType } = await loadInputImage(imageInput, cwd);

		// Try OpenAI standard /images/edits endpoint
		const formData = new FormData();
		const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
		formData.append("image", blob, "image.png");
		formData.append("model", model);
		formData.append("prompt", prompt);
		formData.append("size", dimensions.openAiSize);
		formData.append("response_format", "b64_json");

		const editUrl = `${provider.baseUrl}/images/edits`;
		const response = await fetch(editUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${provider.apiKey}`,
			},
			body: formData,
		});

		if (response.ok) {
			const data = (await response.json()) as any;
			const b64 = data?.data?.[0]?.b64_json;
			if (b64) return Buffer.from(b64, "base64");
			const url = data?.data?.[0]?.url;
			if (url) {
				const imgRes = await fetch(url);
				return Buffer.from(await imgRes.arrayBuffer());
			}
		}

		// Fallback: Multimodal chat generation
		const chatUrl = `${provider.baseUrl}/chat/completions`;
		const base64DataUri = `data:${mimeType};base64,${buffer.toString("base64")}`;
		const chatRes = await fetch(chatUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${provider.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model,
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: `Edit this image according to instructions: ${prompt}` },
							{ type: "image_url", image_url: { url: base64DataUri } },
						],
					},
				],
			}),
		});

		if (chatRes.ok) {
			const chatData = (await chatRes.json()) as any;
			const msg = chatData?.choices?.[0]?.message;
			const extracted = await extractImageFromChatMessage(msg);
			if (extracted) {
				return extracted;
			}
		}

		const editError = await response.text().catch(() => "");
		const chatError = chatRes ? await chatRes.text().catch(() => "") : "";
		const errorMsg = chatError
			? `/images/edits: ${response.status} ${editError.slice(0, 100)} | /chat/completions: ${chatRes.status} ${chatError.slice(0, 100)}`
			: `${response.status} ${response.statusText} ${editError.slice(0, 150)}`;
		throw new Error(`Failed to edit image with model ${model} (${errorMsg})`);
	}

	// Branch 2: Text-to-Image via /images/generations
	const genUrl = `${provider.baseUrl}/images/generations`;
	const res = await fetch(genUrl, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${provider.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model,
			prompt,
			n: 1,
			size: dimensions.openAiSize,
			response_format: "b64_json",
		}),
	});

	if (res.ok) {
		const data = (await res.json()) as any;
		const b64 = data?.data?.[0]?.b64_json;
		if (b64) return Buffer.from(b64, "base64");
		const url = data?.data?.[0]?.url;
		if (url) {
			const imgRes = await fetch(url);
			return Buffer.from(await imgRes.arrayBuffer());
		}
	}

	// Fallback: Multimodal chat/completions (for Gemini, Claude, Qwen, or proxy aggregators)
	const chatUrl = `${provider.baseUrl}/chat/completions`;
	const chatRes = await fetch(chatUrl, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${provider.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: prompt }],
		}),
	});

	if (chatRes.ok) {
		const chatData = (await chatRes.json()) as any;
		const msg = chatData?.choices?.[0]?.message;
		const extracted = await extractImageFromChatMessage(msg);
		if (extracted) {
			return extracted;
		}
	}

	const genError = await res.text().catch(() => "");
	const chatError = chatRes ? await chatRes.text().catch(() => "") : "";
	const errorMsg = chatError
		? `/images/generations: ${res.status} ${genError.slice(0, 100)} | /chat/completions: ${chatRes.status} ${chatError.slice(0, 100)}`
		: `${res.status} ${res.statusText} ${genError.slice(0, 150)}`;
	throw new Error(`API call failed for ${model}: ${errorMsg}`);
}

/**
 * Resolves a direct image URL or base64 data URI into a Buffer.
 */
export async function resolveUrlOrDataUriToBuffer(urlOrDataUri: string): Promise<Buffer | null> {
	if (!urlOrDataUri || typeof urlOrDataUri !== "string") return null;
	const match = urlOrDataUri.match(/^data:image\/[a-zA-Z0-9+.-]+;base64,(.+)$/);
	if (match) {
		return Buffer.from(match[1], "base64");
	}
	if (urlOrDataUri.startsWith("http://") || urlOrDataUri.startsWith("https://")) {
		const res = await fetch(urlOrDataUri);
		if (res.ok) {
			const arr = await res.arrayBuffer();
			return Buffer.from(arr);
		}
	}
	return null;
}

/**
 * Extracts image buffer from various OpenAI-compatible /chat/completions multimodal responses
 * (such as Gemini, Claude, Qwen, or proxy aggregators that return images in message.images or message.content).
 */
export async function extractImageFromChatMessage(msg: any): Promise<Buffer | null> {
	if (!msg) return null;

	// Format 1: Direct images field (e.g., OneAPI/NewAPI/yqdcc OpenAI-compatible Gemini or Claude image format)
	if (Array.isArray(msg.images) && msg.images.length > 0) {
		for (const imgItem of msg.images) {
			const rawUrl = typeof imgItem === "string" ? imgItem : imgItem?.image_url?.url || imgItem?.url || "";
			if (rawUrl) {
				const buf = await resolveUrlOrDataUriToBuffer(rawUrl);
				if (buf) return buf;
			}
		}
	}

	// Format 2: Multimodal array inside message.content
	if (Array.isArray(msg.content)) {
		for (const part of msg.content) {
			const rawUrl = part?.image_url?.url || part?.url;
			if (rawUrl) {
				const buf = await resolveUrlOrDataUriToBuffer(rawUrl);
				if (buf) return buf;
			}
			if (typeof part?.text === "string") {
				const buf = await extractImageFromString(part.text);
				if (buf) return buf;
			}
		}
	}

	// Format 3: String message.content
	if (typeof msg.content === "string") {
		return await extractImageFromString(msg.content);
	}

	return null;
}

async function extractImageFromString(content: string): Promise<Buffer | null> {
	if (!content) return null;

	// Markdown image syntax: ![...](url or data URI)
	const mdMatch = content.match(/!\[.*?\]\((https?:\/\/[^\s)]+|data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+)\)/);
	if (mdMatch?.[1]) {
		const buf = await resolveUrlOrDataUriToBuffer(mdMatch[1]);
		if (buf) return buf;
	}

	// Direct base64 data URI in text
	const b64Match = content.match(/data:image\/[a-zA-Z0-9+.-]+;base64,([A-Za-z0-9+/=]+)/);
	if (b64Match?.[1]) {
		return Buffer.from(b64Match[1], "base64");
	}

	// Standalone image URL
	const urlMatch = content.match(/(https?:\/\/[^\s)]+\.(?:png|jpe?g|webp|gif))/i);
	if (urlMatch?.[1]) {
		const buf = await resolveUrlOrDataUriToBuffer(urlMatch[1]);
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
): Promise<VideoExecutionResult> {
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
			});

			const outPath = getMediaOutputPath("videos", "mp4", mediaConfig.outputDir, cwd);
			if (Buffer.isBuffer(videoUrlOrBuffer)) {
				writeFileSync(outPath, videoUrlOrBuffer);
			} else {
				const dlRes = await fetch(videoUrlOrBuffer);
				if (!dlRes.ok) {
					throw new Error(`Failed to download video from ${videoUrlOrBuffer}: ${dlRes.status}`);
				}
				writeFileSync(outPath, Buffer.from(await dlRes.arrayBuffer()));
			}

			return {
				filePath: outPath,
				usedModel: model,
				dimensions: dims,
			};
		} catch (err: any) {
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
}): Promise<string | Buffer> {
	const { provider, model, prompt, imageInput, dimensions } = options;

	// Standard video dispatch endpoint on CPA / Gateway
	const endpoint = `${provider.baseUrl}/videos/generations`;
	const res = await fetch(endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${provider.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model,
			prompt,
			image_url: imageInput,
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

	const globalConfigPath = join(homedir(), ".pi", "agent", "media-gen.json");
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

export default function mediaGenExtension(pi: ExtensionAPI): void {
	// --------------------------------------------------------------------------
	// Tool 1: generate_image
	// --------------------------------------------------------------------------
	pi.registerTool({
		name: "generate_image",
		label: "Generate Image",
		description:
			"Generate a new image from a text description, or edit/modify an existing image (Image-to-Image / Inpainting / Style Transfer). Automatically computes optimal aspect ratio and handles configured fallback models.",
		parameters: GenerateImageSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typedParams = params as GenerateImageParams;
			if (!typedParams.prompt || typedParams.prompt.trim().length === 0) {
				return {
					content: [{ type: "text", text: "Error: Prompt cannot be empty." }],
					details: { error: "Empty prompt" },
				};
			}

			let context: ResolvedMediaGenContext | null = null;
			try {
				context = getMediaGenContext();
			} catch (err: any) {
				const report = formatMissingModelReport("image", null, err?.message || String(err));
				ctx.ui?.notify?.("media-gen: Configuration missing or invalid", "warning");
				return {
					content: [{ type: "text", text: report }],
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
					details: { error: "Missing image.primaryModel" },
				};
			}

			try {
				const result = await executeImageGeneration(typedParams, context.image, context.provider);
				const fileUrl = formatLocalFileUrl(result.filePath);
				const filename = basename(result.filePath);

				const report = [
					"### Image Generation Complete",
					"",
					`![${filename}](${fileUrl})`,
					"",
					`- **File Path**: \`${result.filePath}\``,
					`- **Mode**: ${result.mode}`,
					`- **Model Used**: \`${result.usedModel}\` (Provider: \`${context.provider.providerName}\`)`,
					`- **Resolution**: ${result.dimensions.requestedWidth}x${result.dimensions.requestedHeight} (Aspect Ratio: \`${result.dimensions.aspectRatio}\`)`,
					`- **File Size**: ${(result.fileSize / 1024).toFixed(1)} KB`,
				].join("\n");

				return {
					content: [{ type: "text", text: report }],
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
							text: `Image generation failed: ${err?.message || String(err)}`,
						},
					],
					details: { error: err?.message || String(err) },
				};
			}
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
					details: { error: "Empty prompt" },
				};
			}

			let context: ResolvedMediaGenContext | null = null;
			try {
				context = getMediaGenContext();
			} catch (err: any) {
				const report = formatMissingModelReport("video", null, err?.message || String(err));
				ctx.ui?.notify?.("media-gen: Configuration missing or invalid", "warning");
				return {
					content: [{ type: "text", text: report }],
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
					details: { error: "Missing video.primaryModel" },
				};
			}

			try {
				const result = await executeVideoGeneration(typedParams, context.video, context.provider);
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
					details: { error: err?.message || String(err) },
				};
			}
		},
	});
}
