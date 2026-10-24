import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import mediaGenExtension from "../extensions/media-gen.ts";

// Exercise production module resolution using an isolated public-export fixture.
// Never load the operator's installed pi-subagents or contact a real provider.
const root = mkdtempSync(join(tmpdir(), "media-background-test-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const cwd = join(root, "workspace"), output = join(root, "output");
mkdirSync(cwd); mkdirSync(output);
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const png = Buffer.from(pngBase64, "base64");
const response = () => Response.json({ data: [{ b64_json: pngBase64 }] });
const configPath = join(cwd, "media-gen.json");
const configure = required => writeFileSync(configPath, JSON.stringify({
	provider: "fixture", image: { primaryModel: "fixture-image", fallbackModels: ["fallback"], outputDir: output, requireBackgroundWorkProvider: required },
}));
function makeAgent(name, moduleSource) {
	const dir = join(root, name);
	mkdirSync(dir);
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: {
		fixture: { baseUrl: "https://fixture.invalid/v1", apiKey: "test-only" },
	} }));
	if (moduleSource !== undefined) {
		const pkg = join(dir, "npm", "node_modules", "pi-subagents");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({
			name: "pi-subagents", type: "module", exports: { "./background-work": "./background-work.mjs" },
		}));
		writeFileSync(join(pkg, "background-work.mjs"), moduleSource);
		return { dir, entry: join(pkg, "background-work.mjs") };
	}
	return { dir };
}
const installed = makeAgent("installed", `
export const state = { providers: new Map(), registrations: 0, disposals: 0, mode: "normal" };
export function registerBackgroundWorkProvider(provider) {
	state.registrations++;
	if (state.mode === "throw") throw new Error("fixture registration failed");
	if (state.mode === "invalid-disposer") return undefined;
	state.providers.set(provider.name, provider);
	return () => {
		if (state.providers.get(provider.name) === provider) {
			state.providers.delete(provider.name);
			state.disposals++;
		}
	};
}
`);
const missing = makeAgent("missing");
const invalid = makeAgent("invalid", "export const unrelated = true;");
const { state } = await import(pathToFileURL(installed.entry).href);
const runtimes = [];
function runtime(sessionFile = join(root, "session.jsonl"), sessionId = "session-fallback") {
	const tools = new Map(), handlers = new Map(), messages = [], order = [];
	const emitter = new EventEmitter();
	const events = {
		on(channel, listener) { emitter.on(channel, listener); return () => emitter.off(channel, listener); },
		emit(channel, payload) { order.push({ type: "wake", channel }); emitter.emit(channel, payload); },
	};
	const instance = { tools, handlers, messages, order, events, failDelivery: false };
	mediaGenExtension({
		registerTool(tool) { tools.set(tool.name, tool); },
		on(event, handler) { handlers.set(event, handler); },
		events,
		sendMessage(message, options) {
			order.push({ type: "message", message });
			if (instance.failDelivery) throw new Error("fixture delivery failed");
			messages.push({ message, options });
		},
	});
	const ctx = { cwd, ui: { notify() {} }, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => sessionId } };
	instance.start = (params = {}, signal) => tools.get("generate_image").execute("fixture-call", { prompt: "test", ...params }, signal, undefined, ctx);
	instance.query = jobId => tools.get("image_job_status").execute("query", { jobId });
	instance.cleanup = event => handlers.get(event || "session_shutdown")();
	runtimes.push(instance);
	return instance;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const active = sessionId => [...state.providers.values()].flatMap(provider => provider.listActiveWork({ sessionId, nowMs: Date.now() }));
const errors = [];
try {
	console.error = message => errors.push(message);
	process.env.PI_CODING_AGENT_DIR = installed.dir;
	configure(true);
	const main = runtime();
	assert.equal(state.registrations, 0, "factory must not register a long-lived provider");
	const pending = [];
	globalThis.fetch = (_url, init) => new Promise(resolve => pending.push({ resolve, signal: init.signal }));
	const [first, second] = await Promise.all([main.start(), main.start()]);
	assert.equal(first.details.backgroundWorkProvider, "registered");
	assert.equal(second.details.backgroundWorkProvider, "registered");
	assert.equal(state.registrations, 1, "concurrent starts register one provider per runtime");
	assert.equal(pending.length, 2);
	const provider = [...state.providers.values()][0];
	const owner = join(root, "session.jsonl");
	assert.deepEqual(active(owner).map(item => item.id).sort(), [first.details.jobId, second.details.jobId].sort());
	assert.deepEqual(active("another-session"), []);
	assert.deepEqual(active("session-fallback"), [], "session file takes precedence over session ID");
	assert.equal(provider.listActiveWork().length, 2);

	// Mimic a native waiter's public wake subscription. A wake must see stored result
	// and the follow-up attempt, with only still-running jobs in the provider snapshot.
	const wakes = [];
	const unsubscribe = main.events.on(provider.wakeChannels[0], () => {
		wakes.push({ active: active(owner).map(item => item.id), order: main.order.at(-2)?.type });
	});
	pending[1].resolve(response());
	await flush();
	assert.deepEqual(wakes, [{ active: [first.details.jobId], order: "message" }]);
	assert.equal((await main.query(second.details.jobId)).details.status, "completed");
	pending[0].resolve(response());
	await flush();
	assert.deepEqual(wakes[1], { active: [], order: "message" });
	assert.equal(main.messages.length, 2);
	assert.equal((await main.query(first.details.jobId)).details.status, "completed");
	assert.match(first.content[0].text, /bg_wait\(\{ all: true, timeoutMs: 660000 \}\)/);
	unsubscribe();
	console.log("✓ isolated public export resolution, concurrent registration, exact session ownership and follow-up-before-wake ordering");

	globalThis.fetch = async () => new Response("gateway timeout", { status: 524 });
	const failure = await main.start();
	await flush();
	assert.equal((await main.query(failure.details.jobId)).details.status, "failed");
	assert.deepEqual(active(owner), []);
	assert.equal(main.order.at(-1).type, "wake");
	const originalTimeout = AbortSignal.timeout;
	const deadline = new AbortController();
	let timeoutRequests = 0;
	try {
		AbortSignal.timeout = ms => { assert.equal(ms, 600_000); return deadline.signal; };
		globalThis.fetch = (_url, init) => {
			timeoutRequests++;
			return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
		};
		const timed = await main.start();
		assert.equal(active(owner).length, 1);
		deadline.abort(new DOMException("Image generation exceeded 10 minutes", "TimeoutError"));
		await flush();
		assert.equal((await main.query(timed.details.jobId)).details.status, "failed");
		assert.deepEqual(active(owner), []);
		assert.equal(main.order.at(-1).type, "wake");
		assert.equal(timeoutRequests, 1, "deadline must not cause model fallback");
	} finally { AbortSignal.timeout = originalTimeout; }
	main.failDelivery = true;
	globalThis.fetch = async () => response();
	const retained = await main.start();
	await flush();
	assert.equal((await main.query(retained.details.jobId)).details.status, "completed");
	assert.equal(errors.length, 1);
	assert.equal(main.order.at(-1).type, "wake", "delivery failure must still wake native waiters");
	main.failDelivery = false;

	// Explicit null models an unsaved session (undefined would select runtime's default).
	const unsaved = runtime(null, "fallback-owner");
	let late;
	globalThis.fetch = (_url, init) => new Promise(resolve => { late = { resolve, signal: init.signal }; });
	const unsavedAck = await unsaved.start();
	assert.deepEqual(active("fallback-owner"), [{ id: unsavedAck.details.jobId, sessionId: "fallback-owner" }]);
	assert.equal(state.providers.size, 2, "separate runtimes must not replace each other's provider");
	const beforeCleanup = readdirSync(output).length;
	unsaved.cleanup("session_tree");
	assert.equal(late.signal.aborted, true);
	assert.equal(state.providers.size, 1);
	assert.equal(unsaved.order.at(-1).type, "wake");
	late.resolve(response());
	await flush();
	assert.equal(readdirSync(output).length, beforeCleanup);
	assert.equal((await unsaved.query(unsavedAck.details.jobId)).details.status, "not_found");
	assert.equal(unsaved.messages.length, 0);
	main.cleanup(); main.cleanup();
	assert.equal(state.providers.size, 0);
	assert.equal(state.disposals, 2);
	console.log("✓ error/delivery-failure wakeups, session-ID fallback, per-runtime isolation and idempotent cleanup without late writes");

	// Missing package, invalid public export, thrown registration and invalid disposer.
	for (const [agent, mode, errorPattern] of [
		[missing, "normal", /Cannot find module/],
		[invalid, "normal", /does not export/],
		[installed, "throw", /fixture registration failed/],
		[installed, "invalid-disposer", /did not return a disposer/],
	]) {
		process.env.PI_CODING_AGENT_DIR = agent.dir;
		state.mode = mode;
		let requests = 0;
		globalThis.fetch = async () => { requests++; return response(); };
		configure(true);
		const required = runtime();
		const rejected = await required.start();
		assert.equal(rejected.isError, true);
		assert.match(rejected.details.error, errorPattern);
		assert.equal(rejected.details.jobId, undefined);
		assert.equal(requests, 0, "required bridge failure must precede upstream submission");
		assert.equal(required.messages.length, 0);

		configure(false);
		const optional = runtime();
		const ack = await optional.start();
		assert.equal(ack.details.backgroundWorkProvider, "unavailable");
		assert.match(ack.details.backgroundWorkError, errorPattern);
		await flush();
		const complete = await optional.query(ack.details.jobId);
		assert.equal(complete.details.status, "completed");
		assert.deepEqual(readFileSync(complete.details.filePath), png);
		assert.equal(optional.messages.length, 1);
		assert.equal(requests, 1, "optional bridge failure must not add generation attempts");

		configure(true);
		const sync = runtime();
		const syncResult = await sync.start({ async: false });
		assert.equal(syncResult.isError, undefined, "synchronous generation does not require bridge registration");
		assert.equal(requests, 2);
		assert.equal(syncResult.details.backgroundWorkProvider, undefined);
		required.cleanup(); optional.cleanup(); sync.cleanup();
	}
	console.log("✓ missing/invalid API, registration failures, strict preflight/no paid request, optional fallback and unchanged synchronous mode");

	process.env.PI_CODING_AGENT_DIR = installed.dir;
	state.mode = "normal";
	configure(true);
	let raceRequests = 0;
	globalThis.fetch = async () => { raceRequests++; return response(); };
	for (const action of ["session_tree", "session_shutdown", "abort"]) {
		const race = runtime();
		const abort = new AbortController();
		const registrationCount = state.registrations;
		const starting = race.start({}, abort.signal);
		if (action === "abort") abort.abort(); else race.cleanup(action);
		const result = await starting;
		assert.equal(result.isError, true);
		assert.equal(result.details.jobId, undefined);
		assert.equal(raceRequests, 0, "cancel during asynchronous registration must prevent submission");
		if (action !== "abort") assert.equal(state.registrations, registrationCount, "stale sessions must not register providers");
		race.cleanup();
		assert.equal(state.providers.size, 0);
	}
	console.log("✓ session/tree/abort races during registration do not leak providers or submit jobs");
} finally {
	for (const instance of runtimes) instance.cleanup();
	globalThis.fetch = originalFetch;
	console.error = originalConsoleError;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(root, { recursive: true, force: true });
}
console.log("All isolated media background-work bridge regressions passed.");
