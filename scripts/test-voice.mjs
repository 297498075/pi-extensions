import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import voiceExtension, {
	DEFAULT_CONFIG, VoiceConfigManager, VoiceRuntime, TtsGatewayAdapter, UNSUPPORTED_SPEAKER, VoiceStatusModalComponent, defaultVoiceConfigDir,
} from "../extensions/voice.ts";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => sleep(0);
function harness(config = {}) {
	let value = { ...structuredClone(DEFAULT_CONFIG), voicesCacheByGateway: { [DEFAULT_CONFIG.gatewayUrl]: [] }, ...config };
	const recordings = [], speeches = [], deliveries = [], notices = [], voiceRequests = [];
	const gatewayUrls = [];
	let editor = "", idle = true;
	const store = {
		get: () => structuredClone(value),
		update: async (fn, signal) => { if (signal?.aborted) throw Error("cancelled"); value = fn(structuredClone(value)); return value; },
	};
	const gw = {
		probe: async () => ({ online: true }),
		getVoices(signal) { const d = deferred(); voiceRequests.push({ ...d, signal }); return d.promise; },
		recordAndTranscribe(options) { const d = deferred(); recordings.push({ ...d, ...options }); return d.promise; },
		speak(text, options) { const d = deferred(); speeches.push({ ...d, text, ...options }); return d.promise; },
	};
	let activeTools = ["read", "voice_speak", "voice_listen", "voice_list_voices"];
	const pi = {
		getActiveTools: () => activeTools,
		setActiveTools: names => { activeTools = names; },
		sendUserMessage: (text, options) => deliveries.push({ text, options }),
	};
	const ctx = { hasUI: true, isIdle: () => idle, ui: {
		notify: (...args) => notices.push(args), setStatus() {},
		getEditorText: () => editor, setEditorText: text => { editor = text; },
	} };
	const runtime = new VoiceRuntime(pi, { config: store, gateway: url => { gatewayUrls.push(url); return gw; } });
	runtime.start(ctx);
	return {
		runtime, recordings, speeches, deliveries, notices, voiceRequests, store, ctx, gatewayUrls,
		get editor() { return editor; }, set editor(text) { editor = text; },
		set idle(v) { idle = v; }, get tools() { return activeTools; },
		change: change => { value = { ...value, ...change }; },
		close: () => runtime.stop(true),
	};
}

await test("disabled/start/stop/off/tool activation and no network on disabled shutdown", async () => {
	const h = harness();
	try {
		assert.deepEqual(h.tools, ["read"]);
		assert.equal((await h.runtime.listen({})).reason, "disabled");
		assert.equal((await h.runtime.speak({ text: "x" })).status, "error");
		assert.equal((await h.runtime.listVoices({})).success, false);
		h.close(); assert.equal(h.gatewayUrls.length, 0);
		h.runtime.enable(); assert(h.tools.includes("voice_listen"));
		h.runtime.stop(); assert.equal(h.runtime.enabled, true);
		const p = h.runtime.listen({}); assert.equal(h.recordings.length, 1);
		h.recordings[0].resolve({ text: "new request allowed", durationMs: 4 });
		assert.equal((await p).status, "success");
		h.runtime.stop(true); assert.equal((await h.runtime.listen({})).status, "error");
		assert.deepEqual(h.tools, ["read"]);
	} finally { h.close(); }
});

await test("live off aborts background capture and discards late result; repeated on is idempotent", async () => {
	const h = harness();
	try {
		h.runtime.enable(); h.runtime.setLive(true); h.editor = "typed draft";
		h.runtime.enable(); assert.equal(h.recordings.length, 1);
		h.runtime.setLive(false); assert(h.recordings[0].signal.aborted);
		h.recordings[0].resolve({ text: "must not arrive", durationMs: 0 }); await tick();
		assert.equal(h.editor, "typed draft"); assert.equal(h.recordings.length, 1);
		h.runtime.setLive(true); assert.equal(h.recordings.length, 2);
		h.runtime.setLive(false);
	} finally { h.close(); }
});

await test("Live/listen handoff uses new owner; live off preserves listen and does not resume Live", async () => {
	const h = harness();
	try {
		h.runtime.enable(); h.runtime.setLive(true);
		const p = h.runtime.listen({});
		assert(h.recordings[0].signal.aborted); assert.equal(h.recordings.length, 2);
		h.runtime.setLive(false); assert.equal(h.recordings[1].signal.aborted, false);
		h.recordings[0].resolve({ text: "old live speech", durationMs: 0 });
		h.recordings[1].resolve({ text: "one answer", durationMs: 10 });
		assert.equal((await p).text, "one answer"); await tick();
		assert.equal(h.editor, ""); assert.equal(h.deliveries.length, 0); assert.equal(h.recordings.length, 2);
	} finally { h.close(); }
});

await test("listen cancellation settles promptly even with an uncooperative transport, old result never reaches new listen", async () => {
	const h = harness();
	try {
		h.runtime.enable(); h.runtime.setLive(true);
		const controller = new AbortController();
		const p = h.runtime.listen({}, controller.signal); controller.abort();
		const result = await Promise.race([p, sleep(100).then(() => "still waiting")]);
		assert.equal(result.status, "cancelled"); assert.equal(result.text, "");
		assert(h.recordings[1].signal.aborted);
		const next = h.runtime.listen({});
		const current = h.recordings.at(-1);
		h.recordings[1].resolve({ text: "answer to cancelled request", durationMs: 1 }); await tick();
		current.resolve({ text: "new answer", durationMs: 2 }); assert.equal((await next).text, "new answer");
		const preAborted = new AbortController(); preAborted.abort(); const count = h.recordings.length;
		assert.equal((await h.runtime.listen({}, preAborted.signal)).status, "cancelled");
		assert.equal(h.recordings.length, count);
	} finally { h.close(); }
});

await test("listen stop followed immediately by new task preserves the new mutex", async () => {
	const h = harness();
	try {
		h.runtime.enable(); const old = h.runtime.listen({}); h.runtime.stop();
		const next = h.runtime.listen({}); assert.equal((await old).status, "cancelled");
		assert.equal((await h.runtime.speak({ text: "conflict" })).reason, "busy");
		assert.equal((await h.runtime.listen({})).reason, "busy");
		h.recordings[0].resolve({ text: "stale", durationMs: 1 }); await tick();
		h.recordings[1].resolve({ text: "new", durationMs: 1 }); assert.equal((await next).text, "new");
	} finally { h.close(); }
});

await test("signal listeners are removed and a completed listen cannot cancel its successor", async () => {
	const h = harness();
	try {
		h.runtime.enable(); const controller = new AbortController(); let listeners = 0;
		const add = controller.signal.addEventListener.bind(controller.signal);
		const remove = controller.signal.removeEventListener.bind(controller.signal);
		controller.signal.addEventListener = (...args) => { listeners++; return add(...args); };
		controller.signal.removeEventListener = (...args) => { listeners--; return remove(...args); };
		const first = h.runtime.listen({}, controller.signal); assert.equal(listeners, 1);
		h.recordings[0].resolve({ text: "first", durationMs: 1 }); await first;
		assert.equal(listeners, 0);
		const next = h.runtime.listen({}); controller.abort(); assert.equal(h.recordings[1].signal.aborted, false);
		h.recordings[1].resolve({ text: "next", durationMs: 1 }); assert.equal((await next).status, "success");
	} finally { h.close(); }
});

await test("listen deadline is neutral about speech and late answer cannot satisfy a subsequent request", async () => {
	const h = harness();
	try {
		h.runtime.enable(); const first = h.runtime.listen({ timeout_sec: 3 });
		const result = await first;
		assert.equal(result.status, "timeout"); assert.equal(result.reason, "deadline_exceeded");
		assert(!result.message.includes("未检测到用户说话")); assert(h.recordings[0].signal.aborted);
		const second = h.runtime.listen({});
		h.recordings[0].resolve({ text: "expired answer", durationMs: 1 }); await tick();
		h.recordings[1].resolve({ text: "current answer", durationMs: 1 });
		assert.equal((await second).text, "current answer");
	} finally { h.close(); }
});

await test("stop synchronously invalidates old task; its finally cannot unlock a newer speak", async () => {
	const h = harness();
	try {
		h.runtime.enable(); const a = h.runtime.speak({ text: "A" });
		h.runtime.stop(); assert(h.speeches[0].signal.aborted);
		const b = h.runtime.speak({ text: "B" });
		assert.equal((await a).status, "cancelled");
		assert.equal((await h.runtime.speak({ text: "C" })).reason, "busy");
		assert.equal((await h.runtime.listen({})).reason, "busy");
		assert.equal(h.speeches.length, 2);
		h.speeches[0].resolve(); await tick();
		assert.equal((await h.runtime.listen({})).reason, "busy");
		h.speeches[1].resolve(); assert.equal((await b).status, "success");
	} finally { h.close(); }
});

await test("speak discards whole Live request, keeps mutex throughout protection, and resumes fresh input", async () => {
	const h = harness();
	try {
		h.runtime.enable(); h.runtime.setLive(true);
		const p = h.runtime.speak({ text: "question" }); assert(h.recordings[0].signal.aborted);
		h.speeches[0].resolve(); await tick();
		assert.equal((await h.runtime.listen({})).reason, "busy");
		assert.equal(h.recordings.length, 1);
		assert.equal((await p).status, "success"); assert.equal(h.recordings.length, 2);
		h.recordings[0].resolve({ text: "late echo", durationMs: 1 }); await tick();
		assert.equal(h.editor, "");
	} finally { h.close(); }
});

await test("off cancels protection wait immediately; no old callback restarts Live", async () => {
	const h = harness();
	try {
		h.runtime.enable(); h.runtime.setLive(true);
		const p = h.runtime.speak({ text: "x" }); h.speeches[0].resolve(); await tick();
		h.runtime.stop(true); assert.equal((await p).status, "cancelled");
		await sleep(170); assert.equal(h.recordings.length, 1); assert.equal(h.runtime.live, false);
	} finally { h.close(); }
});

await test("editor preserves drafts while busy; submit follows idle/busy; request freezes mode and gateway", async () => {
	const h = harness();
	try {
		h.runtime.enable(); h.editor = "manual"; h.idle = false; h.runtime.setLive(true);
		h.change({ deliveryMode: "submit", gatewayUrl: "http://other-gateway" });
		h.recordings[0].resolve({ text: "approved later", durationMs: 1 }); await tick();
		assert.equal(h.editor, "manual approved later"); assert.equal(h.deliveries.length, 0);
		await sleep(110); assert.equal(h.gatewayUrls.at(-1), "http://other-gateway");
		h.recordings[1].resolve({ text: "queued", durationMs: 1 }); await tick();
		assert.deepEqual(h.deliveries[0], { text: "queued", options: { deliverAs: "followUp" } });
		h.idle = true; await sleep(110);
		h.recordings[2].resolve({ text: "direct", durationMs: 1 }); await tick();
		assert.deepEqual(h.deliveries[1], { text: "direct", options: undefined });
	} finally { h.close(); }
});

await test("non-UI editor and offline gateway stop Live without auto-submitting or spinning", async () => {
	const h = harness();
	try {
		h.runtime.enable(); h.ctx.hasUI = false; h.runtime.setLive(true);
		h.recordings[0].resolve({ text: "do not submit", durationMs: 1 }); await tick();
		assert.equal(h.runtime.live, false); assert.equal(h.deliveries.length, 0);
		h.ctx.hasUI = true; h.runtime.setLive(true);
		h.recordings[1].reject(Error("offline")); await tick();
		assert.equal(h.runtime.live, false); await sleep(120); assert.equal(h.recordings.length, 2);
	} finally { h.close(); }
});

await test("cache null/empty/refresh/failure and startup fetch deduplication", async () => {
	const h = harness({ voicesCacheByGateway: {} });
	try {
		h.runtime.enable(); assert.equal(h.voiceRequests.length, 1);
		const p = h.runtime.listVoices({}); assert.equal(h.voiceRequests.length, 1);
		h.voiceRequests[0].resolve([]); assert.equal((await p).success, true);
		assert.deepEqual((await h.runtime.listVoices({})).voices, []); assert.equal(h.voiceRequests.length, 1);
		const refresh = h.runtime.listVoices({ refresh: true }); h.voiceRequests[1].reject(Error("offline"));
		assert.match((await refresh).warning, /历史缓存/);
		h.change({ voicesCacheByGateway: {} });
		const noCache = h.runtime.listVoices({}); h.voiceRequests[2].reject(Error("offline"));
		assert.match((await noCache).message, /无可用音色缓存/);
		const cancelled = h.runtime.listVoices({}); h.runtime.stop(true);
		assert.equal((await cancelled).success, false); assert(h.voiceRequests[3].signal.aborted);
		h.voiceRequests[3].resolve([{ id: "late", name: "Late" }]); await tick();
		assert.deepEqual(h.store.get().voicesCacheByGateway, {});
	} finally { h.close(); }
	const cold = harness({ defaultEnabled: true, voicesCacheByGateway: {} });
	try { assert.equal(cold.voiceRequests.length, 1); cold.voiceRequests[0].resolve([]); await tick(); }
	finally { cold.close(); }
});

await test("actual HTTP adapter fails closed for speaker, rejects bad ASR/catalog responses", async () => {
	const original = globalThis.fetch; const requests = [];
	let response;
	globalThis.fetch = async (url, options) => { requests.push({ url, options }); return Response.json(response); };
	const adapter = new TtsGatewayAdapter("http://mock/");
	const signal = new AbortController().signal;
	try {
		await assert.rejects(adapter.speak("x", { voiceId: "clone", speed: 1, signal }), error => error.message === UNSUPPORTED_SPEAKER);
		assert.equal(requests.length, 0); // No synthesize/preempt or global stop, even if HTTP200 reports success.
		for (const bad of [{ code: 1, text: "", error: "ASR error" }, {}, { code: 0, text: "x", duration_ms: -1 }]) {
			response = bad; await assert.rejects(adapter.recordAndTranscribe({ maxDurationSec: 15, signal }));
		}
		response = { code: 0, text: " ok ", duration_ms: 2 };
		assert.deepEqual(await adapter.recordAndTranscribe({ maxDurationSec: 15, signal }), { text: "ok", durationMs: 2 });
		response = {}; await assert.rejects(adapter.getVoices(signal));
		response = [{ voice_id: "clone", name: "Clone" }];
		assert.deepEqual(await adapter.getVoices(signal), [{ id: "clone", name: "Clone" }]);
	} finally { globalThis.fetch = original; }
});

await test("config lock contention fails without writing or blocking event loop; corruption is preserved", async () => {
	const dir = await mkdtemp(join(tmpdir(), "voice-lock-"));
	try {
		const manager = new VoiceConfigManager(dir, 70);
		await writeFile(join(dir, "voice.json.lock"), "another live owner");
		let heartbeat = false; const timer = setTimeout(() => { heartbeat = true; }, 5);
		await assert.rejects(manager.update(c => ({ ...c, speed: 1.5 })), /锁超时/);
		clearTimeout(timer); assert(heartbeat);
		await assert.rejects(readFile(join(dir, "voice.json")), { code: "ENOENT" });
		assert.equal(await readFile(join(dir, "voice.json.lock"), "utf8"), "another live owner");
		await rm(join(dir, "voice.json.lock"));
		await writeFile(join(dir, "voice.json"), "{broken config");
		await assert.rejects(manager.update(c => ({ ...c, speed: 1.5 })), /读取/);
		assert.equal(await readFile(join(dir, "voice.json"), "utf8"), "{broken config");
		await assert.rejects(readFile(join(dir, "voice.json.lock")), { code: "ENOENT" });
	} finally { await rm(dir, { recursive: true, force: true }); }
});

await test("cross-process read-merge-write preserves concurrent updates", async () => {
	const dir = await mkdtemp(join(tmpdir(), "voice-process-"));
	const moduleUrl = new URL("../extensions/voice.ts", import.meta.url).href;
	try {
		const run = promisify(execFile);
		const script = field => `import {VoiceConfigManager} from ${JSON.stringify(moduleUrl)}; const m=new VoiceConfigManager(${JSON.stringify(dir)},10000); for(let i=0;i<12;i++) await m.update(c=>({...c,${field}:i}));`;
		await Promise.all(["counterA", "counterB"].map(field => run(process.execPath, ["--input-type=module", "-e", script(field)])));
		const saved = JSON.parse(await readFile(join(dir, "voice.json"), "utf8"));
		assert.equal(saved.counterA, 11); assert.equal(saved.counterB, 11);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

await test("default adapter reports incompatible_gateway rather than synthesizing or retrying", async () => {
	const original = globalThis.fetch; let calls = 0;
	globalThis.fetch = async () => { calls++; throw Error("unexpected network"); };
	const h = harness();
	const runtime = new VoiceRuntime({ getActiveTools: () => ["read"], setActiveTools() {} }, { config: h.store });
	try {
		runtime.start(h.ctx); runtime.enable();
		const result = await runtime.speak({ text: "hello", voice_id: "custom" });
		assert.equal(result.reason, "incompatible_gateway"); assert.equal(calls, 0);
	} finally { runtime.stop(true); h.close(); globalThis.fetch = original; }
});

await test("session start cancels in-flight input, discards late results, resets Live and rereads defaultEnabled", async () => {
	const h = harness();
	try {
		h.runtime.enable(); h.runtime.setLive(true); const listen = h.runtime.listen({});
		h.runtime.start(h.ctx); assert.equal((await listen).status, "cancelled");
		assert.equal(h.runtime.enabled, false); assert.equal(h.runtime.live, false);
		for (const record of h.recordings) record.resolve({ text: "old session", durationMs: 1 });
		await tick(); assert.equal(h.editor, ""); assert.equal(h.deliveries.length, 0);
		h.change({ defaultEnabled: true }); h.runtime.start(h.ctx);
		assert.equal(h.runtime.enabled, true); assert.equal(h.runtime.live, false);
	} finally { h.close(); }
});

await test("registration and lifecycle reset tools", async () => {
	const h = harness(); const tools = new Map(), events = new Map(); let active = ["read", "voice_speak", "voice_listen", "voice_list_voices"];
	const ctx = h.ctx;
	voiceExtension({
		registerTool: t => tools.set(t.name, t), registerCommand() {}, registerShortcut() {},
		on: (name, fn) => events.set(name, fn),
		getActiveTools: () => active, setActiveTools: names => { active = names; }, sendUserMessage() {},
	}, { config: h.store, gateway: () => { throw Error("must not connect while disabled"); } });
	try {
		assert.equal(tools.size, 3); events.get("session_start")({}, ctx);
		assert.deepEqual(active, ["read"]);
		const result = await tools.get("voice_listen").execute("call", {}, undefined, undefined, ctx);
		assert.equal(JSON.parse(result.content[0].text).reason, "disabled");
		for (const name of ["session_before_switch", "session_before_fork", "session_shutdown"]) events.get(name)();
		assert.deepEqual(active, ["read"]);
	} finally { h.close(); }
});

await test("status modal component renders nicely and handles key/click close", async () => {
	const h = harness();
	let closed = false;
	const mockTui = { terminal: { rows: 30 } };
	const mockTheme = {
		fg: (_color, text) => text,
		style: (text, _opts) => text,
	};
	const comp = new VoiceStatusModalComponent(mockTui, mockTheme, {
		enabled: true,
		live: false,
		activeTool: null,
		gatewayUrl: "http://127.0.0.1:5234",
		deliveryMode: "editor",
		defaultVoiceId: "default",
		speed: 1.0,
		speakerSupported: false,
	}, () => { closed = true; });

	comp.invalidate();
	const lines = comp.render(80);
	assert(lines.length >= 15, "Should render full status dialog box");
	assert(lines.some(l => l.includes("Pi Voice Extension Status")));
	assert(lines.some(l => l.includes("扩展总开关")));
	assert(lines.some(l => l.includes("ENABLED (ON)")));
	assert(lines.some(l => l.includes("扬声发音协议")));
	assert(lines.some(l => l.includes("INCOMPATIBLE")));

	// Keyboard input triggers close
	comp.handleInput("q");
	assert.equal(closed, true, "Keyboard input closes modal");

	// Mouse click triggers close
	closed = false;
	const mouseRes = comp.handleMouse({ type: "click" });
	assert.equal(closed, true, "Mouse click closes modal");
	assert.deepEqual(mouseRes, { handled: true });

	// Invoking /voice status triggers modal via custom() when UI is available
	let customCalled = false;
	const modalCtx = {
		hasUI: true,
		ui: {
			custom: (factory) => {
				customCalled = true;
				const c = factory(mockTui, mockTheme, {}, () => {});
				assert(c instanceof VoiceStatusModalComponent);
				return Promise.resolve();
			},
			notify: () => {},
		},
	};
	await h.runtime.command("status", modalCtx);
	assert.equal(customCalled, true, "/voice status must invoke ctx.ui.custom modal");
});

await test("defaultVoiceConfigDir points to .pi/agent and respects PI_CODING_AGENT_DIR", async () => {
	const original = process.env.PI_CODING_AGENT_DIR;
	try {
		delete process.env.PI_CODING_AGENT_DIR;
		assert(defaultVoiceConfigDir().endsWith(join(".pi", "agent")));
		process.env.PI_CODING_AGENT_DIR = "/custom/pi/agent";
		assert.equal(defaultVoiceConfigDir(), "/custom/pi/agent");
	} finally {
		if (original !== undefined) process.env.PI_CODING_AGENT_DIR = original;
		else delete process.env.PI_CODING_AGENT_DIR;
	}
});


