import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import voiceExtension, {
	DEFAULT_CONFIG, VoiceConfigManager, VoiceRuntime, TtsGatewayAdapter, UNSUPPORTED_SPEAKER, VoiceStatusModalComponent, defaultVoiceConfigDir, getVoiceArgumentCompletions,
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

await test("live off finishes pending in-flight utterance then exits gracefully; Alt+X strictly aborts", async () => {
	const h = harness();
	try {
		h.runtime.enable(); h.runtime.setLive(true); h.editor = "typed draft";
		h.runtime.enable(); assert.equal(h.recordings.length, 1);
		// 1. live off allows in-flight speech to settle and deliver
		h.runtime.setLive(false);
		h.recordings[0].resolve({ text: "final words", durationMs: 1 }); await tick();
		assert.equal(h.editor, "typed draft final words"); assert.equal(h.recordings.length, 1);
		// 2. Alt+X strictly invalidates and cancels
		h.runtime.setLive(true); assert.equal(h.recordings.length, 2);
		h.runtime.stop(); assert(h.recordings[1].signal.aborted);
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

await test("actual HTTP adapter sends synthesize request for speak and rejects bad responses", async () => {
	const original = globalThis.fetch; const requests = [];
	let response, catalogResponse = [{ voice_id: "clone", name: "Clone" }];
	globalThis.fetch = async (url, options) => { requests.push({ url, options }); return Response.json(url.endsWith("/api/voices") ? catalogResponse : response); };
	const adapter = new TtsGatewayAdapter("http://mock/");
	const signal = new AbortController().signal;
	try {
		response = { status: "completed", task_id: "t1" };
		await adapter.speak("hello world", { voiceId: "clone", speed: 1.2, signal });
		assert.equal(requests.length, 2);
		assert(requests[0].url.endsWith("/api/voices"));
		assert(requests[1].url.includes("/api/tts/synthesize"));
		const body = JSON.parse(requests[1].options.body);
		assert.equal(body.text, "hello world");
		assert.equal(body.engine, "cosyvoice");
		assert.equal(body.voice_id, "clone");
		assert.equal(body.output_mode, "speaker_playback");
		assert.equal(body.wait, true);

		response = { status: "error", error: "Synthesis failed" };
		await assert.rejects(adapter.speak("x", { voiceId: "clone", speed: 1, signal }), /Synthesis failed/);

		for (const bad of [{ code: 1, text: "", error: "ASR error" }, {}, { code: 0, text: "x", duration_ms: -1 }]) {
			response = bad; await assert.rejects(adapter.recordAndTranscribe({ maxDurationSec: 15, signal }));
		}
		response = { code: 0, text: " ok ", duration_ms: 2 };
		assert.deepEqual(await adapter.recordAndTranscribe({ maxDurationSec: 15, signal }), { text: "ok", durationMs: 2 });
		catalogResponse = {}; await assert.rejects(adapter.getVoices(signal));
		catalogResponse = [{ voice_id: "clone", name: "Clone" }];
		assert.deepEqual(await adapter.getVoices(signal), [{ id: "clone", name: "Clone", engine: "cosyvoice" }]);
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

await test("default adapter synthesizes via speak and handles abort cleanup", async () => {
	const original = globalThis.fetch; const calls = [];
	globalThis.fetch = async (url, opts) => {
		calls.push({ url, body: opts.body ? JSON.parse(opts.body) : undefined });
		if (url.endsWith("/api/voices")) return Response.json([{ voice_id: "custom", name: "Custom", engine: "cosyvoice" }]);
		if (url.includes("/api/tts/synthesize")) return Response.json({ status: "completed", task_id: "s1" });
		if (url.includes("/api/tts/playback/control")) return Response.json({ action: "stop" });
		return Response.json({});
	};
	const h = harness();
	const runtime = new VoiceRuntime({ getActiveTools: () => ["read"], setActiveTools() {} }, { config: h.store });
	try {
		runtime.start(h.ctx); runtime.enable();
		const result = await runtime.speak({ text: "hello", voice_id: "custom" });
		assert.equal(result.status, "success");
		assert(calls.some(c => c.url.includes("/api/tts/synthesize") && c.body.voice_id === "custom"));
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
	const h = harness(); const tools = new Map(), events = new Map(), commands = new Map(); let active = ["read", "voice_speak", "voice_listen", "voice_list_voices"];
	const ctx = h.ctx;
	voiceExtension({
		registerTool: t => tools.set(t.name, t), registerCommand: (name, command) => commands.set(name, command), registerShortcut() {},
		on: (name, fn) => events.set(name, fn),
		events: { on() { return () => {}; } },
		getActiveTools: () => active, setActiveTools: names => { active = names; }, sendUserMessage() {},
	}, { config: h.store, gateway: () => { throw Error("must not connect while disabled"); } });
	try {
		assert.equal(tools.size, 3);
		assert(commands.has("voice"));
		for (const name of ["status", "help", "speed", "gateway", "default"]) {
			assert(commands.get("voice").getArgumentCompletions("").some(item => item.value === name));
		}
		events.get("session_start")({}, ctx);
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
		defaultEnabled: false,
		live: false,
		activeTool: null,
		gatewayUrl: "http://127.0.0.1:5234",
		deliveryMode: "editor",
		defaultVoiceId: "default",
		speed: 1.0,
		speakerSupported: true,
	}, () => { closed = true; });

	comp.invalidate();
	const lines = comp.render(80);
	assert(lines.length >= 15, "Should render full status dialog box");
	assert(lines.some(l => l.includes("Pi Voice Extension Status")));
	assert(lines.some(l => l.includes("扩展总开关")));
	assert(lines.some(l => l.includes("ENABLED (ON)")));
	assert(lines.some(l => l.includes("扬声发音服务")));
	assert(lines.some(l => l.includes("未探测连接")));
	assert(lines.some(l => l.includes("新会话默认")));
	assert(!lines.some(l => l.includes("ONLINE")), "status must not claim unprobed connectivity");

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

await test("parameter commands validate without mutation and persist settings across restart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-voice-command-"));
	await writeFile(join(dir, "voice.json"), JSON.stringify(DEFAULT_CONFIG));
	const h = harness();
	const store = new VoiceConfigManager(dir);
	const runtime = new VoiceRuntime({ getActiveTools: () => [], setActiveTools() {} }, {
		config: store, gateway: () => ({ getVoices: async () => [] }),
	});
	runtime.start(h.ctx);
	try {
		for (const command of ["speed NaN", "speed Infinity", "speed 0.49", "speed 2.01", "speed 1 extra", "gateway file:///tmp/x", "gateway http://localhost/?q=x", "gateway http://localhost/#x", "gateway http://localhost extra", "default yes", "default on extra"]) {
			const before = store.get(), count = h.notices.length;
			await runtime.command(command, h.ctx);
			assert.deepEqual(store.get(), before, command);
			assert(h.notices.slice(count).some(([, level]) => level === "error"), command);
		}
		await runtime.command("speed 0.5", h.ctx);
		assert.equal(store.get().speed, 0.5);
		await runtime.command("speed 2", h.ctx);
		await runtime.command("gateway https://example.com/voice/", h.ctx);
		await runtime.command("default on", h.ctx);
		assert.equal(runtime.enabled, false, "default on must not enable the current session");
		const reloaded = new VoiceConfigManager(dir).get();
		assert.equal(reloaded.speed, 2);
		assert.equal(reloaded.gatewayUrl, "https://example.com/voice");
		assert.equal(reloaded.defaultEnabled, true);
		runtime.start(h.ctx);
		assert.equal(runtime.enabled, true);
		assert.equal(runtime.live, false);
		await runtime.command("default off", h.ctx);
		assert.equal(runtime.enabled, true, "default off must not disable the current session");
		runtime.start(h.ctx);
		assert.equal(runtime.enabled, false);
	} finally { runtime.stop(true); h.close(); await rm(dir, { recursive: true, force: true }); }
});

await test("gateway switch cancels old live work, isolates cache and rejects stale callbacks", async () => {
	const h = harness();
	try {
		h.runtime.enable(); h.runtime.setLive(true);
		const old = h.recordings[0];
		await h.runtime.command("gateway http://127.0.0.1:9999/", h.ctx);
		assert(old.signal.aborted);
		assert.equal(h.runtime.enabled, true);
		assert.equal(h.runtime.live, false);
		assert.equal(h.store.get().gatewayUrl, "http://127.0.0.1:9999");
		assert.deepEqual(h.store.get().voicesCacheByGateway[DEFAULT_CONFIG.gatewayUrl], []);
		assert.equal(h.voiceRequests.length, 1);
		assert.equal(h.gatewayUrls.at(-1), "http://127.0.0.1:9999");
		old.resolve({ text: "old gateway result", durationMs: 1 });
		h.voiceRequests[0].resolve([{ id: "new", name: "New voice" }]);
		await tick();
		assert.equal(h.editor, ""); assert.deepEqual(h.deliveries, []);
		assert.equal(h.store.get().voicesCacheByGateway["http://127.0.0.1:9999"][0].id, "new");
	} finally { h.close(); }
});

await test("failed gateway save leaves current audio and settings intact", async () => {
	const h = harness();
	try {
		h.runtime.enable(); h.runtime.setLive(true);
		h.store.update = async () => { throw Error("disk full"); };
		await h.runtime.command("gateway https://example.com", h.ctx);
		assert.equal(h.store.get().gatewayUrl, DEFAULT_CONFIG.gatewayUrl);
		assert.equal(h.runtime.live, true); assert.equal(h.recordings[0].signal.aborted, false);
		assert(h.notices.some(([message, level]) => level === "error" && message.includes("disk full")));
	} finally { h.close(); }
});

await test("speed affects subsequent speech only, and on does not report an unsupported adapter", async () => {
	const h = harness();
	try {
		await h.runtime.command("on", h.ctx);
		assert(!h.notices.some(([message]) => message.includes("协议不兼容")));
		const first = h.runtime.speak({ text: "first" });
		await h.runtime.command("speed 1.5", h.ctx);
		assert.equal(h.speeches[0].speed, 1); h.speeches[0].resolve(); await first;
		const next = h.runtime.speak({ text: "next" });
		assert.equal(h.speeches[1].speed, 1.5); h.speeches[1].resolve(); await next;
	} finally { h.close(); }
});

await test("help and bare parameter queries are local; voices explicitly refreshes without enabling audio", async () => {
	const h = harness(); const rendered = [];
	const ctx = { ...h.ctx, mode: "tui", ui: { ...h.ctx.ui,
		custom: async factory => {
			const component = factory({ terminal: { rows: 40 } }, { fg: (_c, text) => text }, {}, () => {});
			rendered.push(component.render(100).join("\n"));
		},
	} };
	try {
		h.runtime.enable();
		for (const command of ["", "status", "speed", "gateway", "default", "help"]) await h.runtime.command(command, ctx);
		assert.equal(h.gatewayUrls.length, 0);
		const pending = h.runtime.command("voices", ctx);
		h.voiceRequests.at(-1).resolve([]); await pending;
		assert.equal(rendered.length, 7);
		assert(rendered[5].includes("/voice speed")); assert(rendered[6].includes("Voice 音色目录"));
		assert.equal(h.notices.length, 0); assert.equal(h.gatewayUrls.length, 1);
		for (const command of ["help", "speed", "gateway", "default"]) assert(getVoiceArgumentCompletions(command).some(item => item.value === command || item.value.startsWith(command + " ")));
		assert.deepEqual(getVoiceArgumentCompletions("default o").map(item => item.value), ["default on", "default off"]);
	} finally { h.close(); }
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


