import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	resolveAspectAndSize, resolveOutputDir, getMediaOutputPath, formatLocalFileUrl,
	GenerateImageSchema, GenerateVideoSchema, loadMediaGenConfigFile, getMediaGenContext,
	resolveProviderFromModelsJson, extractImageFromChatMessage, resolveUrlOrDataUriToBuffer,
	executeImageGeneration, executeVideoGeneration, default as mediaGenExtension,
} from "../extensions/media-gen.ts";

const root = mkdtempSync(join(tmpdir(), "media-gen-test-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalKey = process.env.PI_MEDIA_TEST_KEY;
const originalFetch = globalThis.fetch;
const agent = join(root, "agent"), cwd = join(root, "workspace"), output = join(root, "output");
mkdirSync(agent); mkdirSync(cwd); mkdirSync(output);
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_MEDIA_TEST_KEY = "test-only-not-a-real-key";
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const png = Buffer.from(pngBase64, "base64");
const dataUri = `data:image/png;base64,${pngBase64}`;
// MP4 container-signature fixture (not a decoder/playback test).
const mp4 = Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex");
const provider = { providerName: "fixture", baseUrl: "https://api.example/v1", apiKey: "test-key", availableModels: ["image-primary", "image-fallback", "video-primary"] };
const config = { primaryModel: "image-primary", fallbackModels: ["image-fallback"], outputDir: output };
const modelsPath = join(agent, "models.json");
const writeModels = apiKey => writeFileSync(modelsPath, JSON.stringify({ providers: { fixture: { baseUrl: provider.baseUrl, apiKey, models: provider.availableModels.map(id => ({ id })) } } }));
const tools = new Map(); mediaGenExtension({ registerTool(tool) { tools.set(tool.name, tool); } });
const ctx = { cwd, ui: { notify() {} } };

try {
	for (const [w, h, ratio, size] of [[1920, 1080, "16:9", "1792x1024"], [1080, 1920, "9:16", "1024x1792"], [1024, 1024, "1:1", "1024x1024"], [800, 600, "4:3", "1792x1024"]]) {
		const dims = resolveAspectAndSize(w, h);
		assert.equal(dims.aspectRatio, ratio); assert.equal(dims.openAiSize, size);
		assert.equal(dims.alignedWidth % 64, 0); assert.equal(dims.alignedHeight % 64, 0);
	}
	assert.equal(resolveAspectAndSize(undefined, undefined, 512, 512).requestedWidth, 512);
	assert.equal(resolveOutputDir(undefined, cwd), join(cwd, ".pi", "media"));
	assert.equal(resolveOutputDir("custom/media", cwd), join(cwd, "custom", "media"));
	assert.equal(resolveOutputDir(output, cwd), output);
	assert.ok(isAbsolute(getMediaOutputPath("images", "png", output, cwd)));
	const linked = join(output, "space # 图片.png");
	assert.equal(formatLocalFileUrl(linked), pathToFileURL(linked).href);
	assert.ok(formatLocalFileUrl(linked).includes("%23"));
	for (const schema of [GenerateImageSchema, GenerateVideoSchema]) {
		for (const key of ["prompt", "image", "width", "height"]) assert.ok(schema.properties[key]);
		assert.equal(schema.properties.duration, undefined);
	}
	console.log("✓ dimensions, cross-platform paths, escaped URLs and schemas");

	writeModels("${PI_MEDIA_TEST_KEY}");
	assert.equal(resolveProviderFromModelsJson("fixture").apiKey, process.env.PI_MEDIA_TEST_KEY);
	writeModels("$PI_MEDIA_TEST_KEY");
	assert.equal(resolveProviderFromModelsJson("fixture").apiKey, process.env.PI_MEDIA_TEST_KEY);
	writeModels("${PI_MEDIA_TEST_MISSING_KEY}");
	assert.throws(() => resolveProviderFromModelsJson("fixture"), /not set/);
	writeModels("!echo secret");
	assert.throws(() => resolveProviderFromModelsJson("fixture"), /does not execute/);
	writeModels("$PI_MEDIA_TEST_KEY");
	writeFileSync(join(agent, "media-gen.json"), JSON.stringify({ provider: "fixture", image: { ...config, primaryModel: "global-image" }, video: { ...config, primaryModel: "video-primary" } }));
	assert.equal(getMediaGenContext(cwd).image.primaryModel, "global-image");
	writeFileSync(join(cwd, "media-gen.json"), JSON.stringify({ provider: "fixture", image: config, video: { ...config, primaryModel: "video-primary" } }));
	assert.equal(loadMediaGenConfigFile(cwd).config.provider, "fixture");
	assert.equal(getMediaGenContext(cwd).configFilePath, join(cwd, "media-gen.json"));
	assert.equal(getMediaGenContext(cwd).provider.baseUrl, provider.baseUrl);
	console.log("✓ isolated agent directory, environment interpolation and session config precedence");

	assert.deepEqual(await resolveUrlOrDataUriToBuffer(dataUri), png);
	for (const message of [
		{ images: [{ image_url: { url: dataUri } }] },
		{ content: [{ type: "image_url", image_url: { url: dataUri } }] },
		{ content: `![generated](${dataUri})` }, { content: dataUri },
	]) assert.deepEqual(await extractImageFromChatMessage(message), png);
	assert.equal(await extractImageFromChatMessage(null), null);
	assert.equal(await extractImageFromChatMessage({ content: "no image" }), null);
	let signedUrl;
	globalThis.fetch = async url => { signedUrl = url; return new Response(png); };
	assert.deepEqual(await extractImageFromChatMessage({ content: "https://cdn.example/image.png?signature=keep-me&expires=123" }), png);
	assert.equal(signedUrl, "https://cdn.example/image.png?signature=keep-me&expires=123", "URL extraction must not drop signed download queries");
	await assert.rejects(resolveUrlOrDataUriToBuffer("data:image/png;base64,YmFk"), /unsupported/);
	console.log("✓ multimodal extraction and invalid image payload rejection");

	let calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url, init });
		return Response.json({ data: [{ b64_json: pngBase64 }] });
	};
	const result = await tools.get("generate_image").execute("image", { prompt: "test" }, undefined, undefined, ctx);
	assert.equal(result.isError, undefined);
	assert.equal(result.details.model, "image-primary", "tool must use ctx.cwd project config");
	assert.deepEqual(readFileSync(result.details.filePath), png);
	assert.equal(JSON.parse(calls[0].init.body).model, "image-primary");
	assert.ok(calls[0].init.signal, "requests need cancellation and a bounded deadline");

	calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push(String(url));
		if (String(url).includes("/images/generations")) return Response.json({ data: [{ url: "https://cdn.example/expired.png" }] });
		return new Response("<html>Access denied</html>", { status: 403 });
	};
	const beforeFailure = readdirSync(output).length;
	await assert.rejects(executeImageGeneration({ prompt: "test" }, config, provider, cwd), /HTTP 403/);
	assert.equal(readdirSync(output).length, beforeFailure, "error pages must not be saved as images");
	assert.equal(calls.length, 4, "failed image download must allow model fallback");
	globalThis.fetch = async () => new Response("<html>error</html>", { status: 200 });
	await assert.rejects(resolveUrlOrDataUriToBuffer("https://cdn.example/error.png"), /unsupported/);

	let modelsTried = [];
	globalThis.fetch = async (_url, init) => {
		const body = JSON.parse(init.body); modelsTried.push(body.model);
		if (body.model === "image-primary") return new Response("unavailable", { status: 503 });
		return Response.json({ data: [{ b64_json: pngBase64 }] });
	};
	const fallback = await executeImageGeneration({ prompt: "test" }, config, provider, cwd);
	assert.equal(fallback.usedModel, "image-fallback");
	assert.deepEqual(modelsTried, ["image-primary", "image-primary", "image-fallback"]);
	console.log("✓ actual generation, HTTP/download validation and ordered fallback");

	const controller = new AbortController();
	let requestSignal, complete;
	let requests = 0;
	globalThis.fetch = (_url, init) => {
		requests++; requestSignal = init.signal;
		return new Promise(resolve => { complete = resolve; }); // deliberately ignore cancellation
	};
	const beforeAbort = readdirSync(output).length;
	const pending = tools.get("generate_image").execute("cancel", { prompt: "test" }, controller.signal, undefined, ctx);
	controller.abort();
	assert.equal(requestSignal.aborted, true);
	complete(Response.json({ data: [{ b64_json: pngBase64 }] }));
	const cancelled = await pending;
	assert.equal(cancelled.isError, true);
	assert.equal(requests, 1, "abort must not cascade into fallback API calls");
	assert.equal(readdirSync(output).length, beforeAbort, "no output may be written after cancellation");
	await assert.rejects(executeVideoGeneration({ prompt: "test" }, config, provider, cwd, controller.signal), /abort/i);
	assert.equal(requests, 1, "already cancelled video must not call API");
	console.log("✓ in-flight and preflight cancellation, no fallback or writes after abort");

	const imagePath = join(cwd, "reference.png"); writeFileSync(imagePath, png);
	let videoBody;
	globalThis.fetch = async (_url, init) => { videoBody = JSON.parse(init.body); return Response.json({ data: [{ b64_json: mp4.toString("base64") }] }); };
	const video = await executeVideoGeneration({ prompt: "animate", image: basename(imagePath) }, { ...config, primaryModel: "video-primary" }, provider, cwd);
	assert.equal(videoBody.image_url, dataUri, "local reference images must be sent as bytes, not workstation paths");
	assert.deepEqual(readFileSync(video.filePath), mp4);
	globalThis.fetch = async () => new Response("not authorized", { status: 401 });
	for (const name of ["generate_image", "generate_video"]) {
		const error = await tools.get(name).execute("failure", { prompt: "test" }, undefined, undefined, ctx);
		assert.equal(error.isError, true); assert.ok(error.details.error);
	}
	console.log("✓ video reference encoding and true tool error results");
} finally {
	globalThis.fetch = originalFetch;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalKey === undefined) delete process.env.PI_MEDIA_TEST_KEY; else process.env.PI_MEDIA_TEST_KEY = originalKey;
	rmSync(root, { recursive: true, force: true });
}
console.log("All isolated media-gen regressions passed.");
