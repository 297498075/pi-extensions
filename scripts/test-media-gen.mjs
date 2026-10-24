import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	resolveAspectAndSize, resolveOutputDir, getMediaOutputPath, formatLocalFileUrl,
	GenerateImageSchema, GenerateVideoSchema, IMAGE_GENERATION_TIMEOUT_MS, loadMediaGenConfigFile, getMediaGenContext,
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
const tools = new Map(), handlers = new Map(), messages = [], wakeEvents = [];
const events = { emit(channel, payload) { wakeEvents.push({ channel, payload }); } };
mediaGenExtension({
	registerTool(tool) { tools.set(tool.name, tool); },
	on(event, handler) { handlers.set(event, handler); },
	events,
	sendMessage(message, options) { messages.push({ message, options }); },
});
const flushBackground = () => new Promise(resolve => setImmediate(resolve));
const ctx = {
	cwd, ui: { notify() {} },
	sessionManager: { getSessionFile: () => join(root, "session.jsonl"), getSessionId: () => "fixture-session" },
};

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
	const result = await tools.get("generate_image").execute("image", { prompt: "test", async: false }, undefined, undefined, ctx);
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
		if (body.model === "image-primary") return Response.json({ error: { code: "model_not_found" } }, { status: 404 });
		return Response.json({ data: [{ b64_json: pngBase64 }] });
	};
	const fallback = await executeImageGeneration({ prompt: "test" }, config, provider, cwd);
	assert.equal(fallback.usedModel, "image-fallback");
	assert.deepEqual(modelsTried, ["image-primary", "image-fallback"]);
	console.log("✓ actual generation, HTTP/download validation and ordered fallback");

	// Fixed images endpoints never probe chat, including failures with configured model fallbacks.
	const editPath = join(cwd, "edit-reference.png"); writeFileSync(editPath, png);
	const failures = [
		[200, "content_policy_violation"], [400, "content_policy_violation"],
		[400, "invalid_request"], [401, "unauthorized"], [403, "forbidden"],
		[404, "content_policy_violation"], [429, "rate_limit"], [503, "unavailable"], [524, "timeout"],
	];
	for (const apiMode of ["images", "chat"]) for (const image of [undefined, editPath]) {
		for (const [status, code] of failures) {
			const seen = [];
			const body = JSON.stringify({ error: { code, message: "x".repeat(256) + " diagnostic_tail " + provider.apiKey + " Bearer fixture-token" } });
			globalThis.fetch = async (url, init) => {
				seen.push(String(url));
				return new Response(body, { status, headers: { "x-request-id": "fixture-" + status } });
			};
			let failure;
			const before = readdirSync(output).length;
			await assert.rejects(executeImageGeneration({ prompt: "test", image }, { ...config, apiMode }, provider, cwd), error => {
				failure = error; return true;
			});
			const endpoint = apiMode === "chat" ? "/chat/completions" : image ? "/images/edits" : "/images/generations";
			assert.deepEqual(seen, [provider.baseUrl + endpoint], "refusal/auth/transient/invalid requests must not probe another endpoint or model");
			assert.equal(readdirSync(output).length, before);
			assert.equal(failure.attempts.length, 1);
			const http = failure.attempts[0].http;
			assert.equal(http.endpoint, endpoint); assert.equal(http.status, status);
			assert.equal(http.requestId, "fixture-" + status);
			assert.equal(http.policyRejected, code === "content_policy_violation");
			assert.equal(http.retryable, status === 429 || status >= 500);
			assert.equal(http.modelFallbackAllowed, false);
			assert.ok(http.responseBody.includes("diagnostic_tail"), "diagnostics must not be clipped at 100 characters");
			assert.ok(!JSON.stringify(failure.attempts).includes(provider.apiKey));
			assert.ok(!JSON.stringify(failure.attempts).includes("fixture-token"));
		}
	}
	globalThis.fetch = async () => new Response("gateway timeout", { status: 524, headers: { "cf-ray": "fixture-ray" } });
	const failedTool = await tools.get("generate_image").execute("http-failure", { prompt: "test", async: false }, undefined, undefined, ctx);
	assert.equal(failedTool.isError, true);
	assert.equal(failedTool.details.attempts[0].http.status, 524);
	assert.equal(failedTool.details.attempts[0].http.requestId, "fixture-ray");

	let networkRequests = 0;
	globalThis.fetch = async () => { networkRequests++; throw new TypeError("network failure " + provider.apiKey); };
	await assert.rejects(executeImageGeneration({ prompt: "test" }, config, provider, cwd), error => {
		assert.equal(error.attempts.length, 1); assert.ok(!error.message.includes(provider.apiKey)); return true;
	});
	assert.equal(networkRequests, 1, "network errors belong to the caller retry policy, not extra model attempts");
	const quotedKey = 'fixture-"quoted key';
	globalThis.fetch = async () => Response.json({ error: { message: quotedKey + " " + encodeURIComponent(quotedKey) } }, { status: 400 });
	await assert.rejects(executeImageGeneration({ prompt: "test" }, config, { ...provider, apiKey: quotedKey }, cwd), error => {
		for (const form of [quotedKey, JSON.stringify(quotedKey).slice(1, -1), encodeURIComponent(quotedKey)]) assert.ok(!error.message.includes(form));
		return true;
	});

	// Explicit chat mode supports both text and real image bytes, without probing images endpoints.
	for (const image of [undefined, editPath]) {
		let requests = 0;
		globalThis.fetch = async (url, init) => {
			requests++; assert.equal(String(url), provider.baseUrl + "/chat/completions");
			const content = JSON.parse(init.body).messages[0].content;
			if (image) assert.equal(content.find(part => part.type === "image_url").image_url.url, dataUri);
			else assert.equal(content, "test");
			return Response.json({ choices: [{ message: { content: dataUri } }] });
		};
		const result = await executeImageGeneration({ prompt: "test", image }, { ...config, apiMode: "chat" }, provider, cwd);
		assert.equal(requests, 1); assert.deepEqual(readFileSync(result.filePath), png);
	}
	let editRequests = 0;
	globalThis.fetch = async (url, init) => {
		editRequests++; assert.equal(String(url), provider.baseUrl + "/images/edits");
		assert.deepEqual(Buffer.from(await init.body.get("image").arrayBuffer()), png);
		return Response.json({ data: [{ b64_json: pngBase64 }] });
	};
	await executeImageGeneration({ prompt: "test", image: editPath }, config, provider, cwd);
	assert.equal(editRequests, 1, "default mode must use the images editing endpoint exactly once");
	await assert.rejects(executeImageGeneration({ prompt: "test" }, { ...config, apiMode: "automatic" }, provider, cwd), /apiMode/);
	assert.equal(editRequests, 1, "invalid mode must fail before sending a request");
	console.log("✓ explicit images/chat routing, no endpoint/refusal/transient fallback, full redacted HTTP diagnostics");

	const controller = new AbortController();
	let requestSignal, complete;
	let requests = 0;
	globalThis.fetch = (_url, init) => {
		requests++; requestSignal = init.signal;
		return new Promise(resolve => { complete = resolve; }); // deliberately ignore cancellation
	};
	const beforeAbort = readdirSync(output).length;
	const pending = tools.get("generate_image").execute("cancel", { prompt: "test", async: false }, controller.signal, undefined, ctx);
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
		const error = await tools.get(name).execute("failure", { prompt: "test", async: false }, undefined, undefined, ctx);
		assert.equal(error.isError, true); assert.ok(error.details.error);
	}
	console.log("✓ video reference encoding and true tool error results");

	const imageTool = tools.get("generate_image");
	const statusTool = tools.get("image_job_status");
	assert.ok(statusTool);
	assert.deepEqual(statusTool.parameters.required, ["jobId"]);
	assert.equal(statusTool.parameters.properties.jobId.minLength, 1);
	assert.equal(tools.has("image_job_cancel"), false, "no cancellation tool was requested");
	const query = jobId => statusTool.execute("query", { jobId }, undefined, undefined, ctx);
	for (const jobId of ["unknown-job", "   "]) {
		const missing = await query(jobId);
		assert.equal(missing.isError, true);
		assert.equal(missing.details.status, "not_found");
		assert.match(missing.content[0].text, /does not prove that upstream generation failed/);
	}
	assert.equal(GenerateImageSchema.properties.async.type, "boolean");
	assert.equal(GenerateVideoSchema.properties.async, undefined, "video contract is unchanged");
	assert.equal(IMAGE_GENERATION_TIMEOUT_MS, 600_000);
	// A pending HTTP request must not keep execute() pending. Complete two jobs out of order.
	const pendingRequests = [];
	globalThis.fetch = (_url, init) => new Promise(resolve => pendingRequests.push({ init, resolve }));
	const caller = new AbortController();
	const started = await imageTool.execute("async-one", { prompt: "one" }, caller.signal, undefined, ctx);
	const startedTwo = await imageTool.execute("async-two", { prompt: "two", async: true }, undefined, undefined, ctx);
	assert.equal(started.details.status, "started");
	assert.equal(started.details.timeoutMs, 600_000);
	assert.equal(started.details.filePath, undefined);
	assert.notEqual(started.details.jobId, startedTwo.details.jobId);
	assert.equal(messages.length, 0, "ack must arrive before the deferred result");
	const running = await query(started.details.jobId);
	assert.equal(running.isError, undefined);
	assert.equal(running.details.status, "running");
	assert.equal(running.details.toolCallId, "async-one");
	assert.equal(running.details.timeoutMs, 600_000);
	assert.ok(Number.isFinite(Date.parse(running.details.startedAt)));
	assert.equal(running.details.finishedAt, undefined);
	assert.equal(running.details.filePath, undefined);
	assert.equal((await query(startedTwo.details.jobId)).details.status, "running");
	assert.equal(pendingRequests.length, 2, "query must not start an HTTP request");
	assert.equal(messages.length, 0, "query must not send a follow-up or wait for completion");
	caller.abort();
	assert.equal(pendingRequests[0].init.signal.aborted, false, "accepted job outlives caller's tool signal");
	pendingRequests[1].resolve(Response.json({ data: [{ b64_json: pngBase64 }] }));
	await flushBackground();
	pendingRequests[0].resolve(Response.json({ data: [{ b64_json: pngBase64 }] }));
	await flushBackground();
	assert.equal(messages.length, 2);
	for (const [index, ack, callId] of [[0, startedTwo, "async-two"], [1, started, "async-one"]]) {
		const { message, options } = messages[index];
		assert.equal(message.customType, "media-gen-image-result");
		assert.equal(message.display, true);
		assert.equal(message.details.jobId, ack.details.jobId);
		assert.equal(message.details.toolCallId, callId);
		assert.equal(message.details.status, "completed");
		assert.deepEqual(readFileSync(message.details.filePath), png);
		assert.ok(message.content.includes(message.details.filePath));
		assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
		const completed = await query(ack.details.jobId);
		assert.equal(completed.isError, undefined);
		assert.deepEqual(completed.details, message.details);
		assert.ok(Date.parse(completed.details.finishedAt) >= Date.parse(completed.details.startedAt));
		assert.ok(completed.content[0].text.includes(message.details.filePath));
		assert.deepEqual(await query(ack.details.jobId), completed, "final results are repeatable and not consumed");
		completed.details.dimensions.requestedWidth = -1;
		assert.notEqual((await query(ack.details.jobId)).details.dimensions.requestedWidth, -1, "queries must return independent snapshots");
		message.details.dimensions.requestedWidth = -2;
		assert.notEqual((await query(ack.details.jobId)).details.dimensions.requestedWidth, -2, "notification details must not alias the cache");
	}
	assert.equal(pendingRequests.length, 2);
	assert.equal(messages.length, 2, "repeated queries must not repeat delivery");
	assert.equal(running.details.status, "running", "earlier snapshots must not mutate when jobs finish");

	globalThis.fetch = async () => new Response("gateway timeout", { status: 524 });
	const asyncFailure = await imageTool.execute("async-failure", { prompt: "test" }, undefined, undefined, ctx);
	assert.equal(asyncFailure.details.status, "started");
	await flushBackground();
	assert.equal(messages.length, 3);
	assert.equal(messages[2].message.details.status, "failed");
	assert.equal(messages[2].message.details.jobId, asyncFailure.details.jobId);
	assert.equal(messages[2].message.details.attempts[0].http.status, 524);
	const failedStatus = await query(asyncFailure.details.jobId);
	assert.equal(failedStatus.isError, undefined, "querying a failed job is a successful lookup");
	assert.deepEqual(failedStatus.details, messages[2].message.details);
	assert.match(failedStatus.content[0].text, /HTTP 524/);
	assert.deepEqual(await query(asyncFailure.details.jobId), failedStatus);
	assert.equal(messages.length, 3);
	console.log("✓ default/explicit async ack, detached caller signal, concurrent job correlation and follow-up success/failure");

	// Fake only the deadline signal: exercise timeout delivery without waiting ten minutes.
	const originalTimeout = AbortSignal.timeout;
	const deadline = new AbortController();
	const timeoutValues = [];
	try {
		AbortSignal.timeout = ms => { timeoutValues.push(ms); return deadline.signal; };
		let timeoutRequests = 0;
		globalThis.fetch = (_url, init) => {
			timeoutRequests++;
			return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
		};
		const timed = await imageTool.execute("async-timeout", { prompt: "test" }, undefined, undefined, ctx);
		deadline.abort(new DOMException("Image generation exceeded 10 minutes", "TimeoutError"));
		await flushBackground();
		assert.deepEqual(timeoutValues, [600_000]);
		assert.equal(timeoutRequests, 1, "timeout must not trigger fallback");
		assert.equal(messages.length, 4);
		assert.equal(messages[3].message.details.jobId, timed.details.jobId);
		assert.equal(messages[3].message.details.status, "failed");
		assert.match(messages[3].message.details.error, /10 minutes/);
		assert.deepEqual((await query(timed.details.jobId)).details, messages[3].message.details);
		assert.equal(timeoutRequests, 1, "status lookup must not retry a timed out job");
	} finally { AbortSignal.timeout = originalTimeout; }

	// A failed automatic notification must not lose a completed result or trigger retries.
	const deliveryTools = new Map(), deliveryHandlers = new Map(), deliveryErrors = [];
	mediaGenExtension({
		registerTool(tool) { deliveryTools.set(tool.name, tool); },
		on(event, handler) { deliveryHandlers.set(event, handler); },
		events,
		sendMessage() { throw new Error("simulated delivery failure"); },
	});
	const originalConsoleError = console.error;
	let deliveryRequests = 0;
	try {
		console.error = message => deliveryErrors.push(message);
		globalThis.fetch = async () => { deliveryRequests++; return Response.json({ data: [{ b64_json: pngBase64 }] }); };
		const ack = await deliveryTools.get("generate_image").execute("delivery-failure", { prompt: "test" }, undefined, undefined, ctx);
		await flushBackground();
		const retained = await deliveryTools.get("image_job_status").execute("lookup", { jobId: ack.details.jobId });
		assert.equal(retained.details.status, "completed");
		assert.deepEqual(readFileSync(retained.details.filePath), png);
		assert.equal(deliveryRequests, 1);
		assert.equal(deliveryErrors.length, 1);
	} finally {
		console.error = originalConsoleError;
		deliveryHandlers.get("session_shutdown")();
	}
	console.log("✓ status schema, running/completed/failed/unknown lookups, immutable repeatable results and delivery failure retention");

	for (const event of ["session_shutdown", "session_tree"]) {
		let late, backgroundSignal;
		globalThis.fetch = (_url, init) => {
			backgroundSignal = init.signal;
			return new Promise(resolve => { late = resolve; }); // ignore cancellation to simulate a late server
		};
		const fileCount = readdirSync(output).length;
		const ack = await imageTool.execute(event, { prompt: "test" }, undefined, undefined, ctx);
		assert.equal((await query(ack.details.jobId)).details.status, "running");
		handlers.get(event)(); handlers.get(event)(); // cleanup is idempotent
		assert.equal(backgroundSignal.aborted, true);
		assert.equal((await query(ack.details.jobId)).details.status, "not_found");
		assert.equal((await query(started.details.jobId)).details.status, "not_found", "completed cache is scoped to the old session/branch");
		late(Response.json({ data: [{ b64_json: pngBase64 }] }));
		await flushBackground();
		assert.equal(messages.length, 4, "old session/branch must not receive late messages");
		assert.equal(readdirSync(output).length, fileCount, "cancelled jobs must not write late files");
		assert.equal((await query(ack.details.jobId)).details.status, "not_found", "late results must not recreate cleared records");
	}
	let preflightRequests = 0;
	globalThis.fetch = async () => { preflightRequests++; throw new Error("unexpected request"); };
	for (const params of [{ prompt: "" }, { prompt: "test" }]) {
		const rejected = await imageTool.execute("preflight", params, controller.signal, undefined, ctx);
		assert.equal(rejected.isError, true);
		assert.equal(rejected.details.jobId, undefined);
	}
	writeFileSync(join(cwd, "media-gen.json"), JSON.stringify({ provider: "fixture" }));
	assert.equal((await imageTool.execute("missing-model", { prompt: "test" }, undefined, undefined, ctx)).isError, true);
	writeFileSync(join(cwd, "media-gen.json"), "invalid json");
	assert.equal((await imageTool.execute("bad-config", { prompt: "test" }, undefined, undefined, ctx)).isError, true);
	assert.equal(preflightRequests, 0);
	assert.equal(messages.length, 4);
	console.log("✓ 10-minute deadline, automatic timeout failure, lifecycle cancellation and preflight errors");
} finally {
	globalThis.fetch = originalFetch;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalKey === undefined) delete process.env.PI_MEDIA_TEST_KEY; else process.env.PI_MEDIA_TEST_KEY = originalKey;
	rmSync(root, { recursive: true, force: true });
}
console.log("All isolated media-gen regressions passed.");
