import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentSession, AssistantMessageComponent, SessionManager, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import todoTree, { SNAPSHOT_ENTRY_TYPE } from "../extensions/todo-tree.ts";
import todoLoop from "../extensions/todo-loop.ts";
import streamRetry from "../extensions/stream-read-retry.ts";
import rollingTools from "../extensions/rolling-tools.ts";
import requestCompress, { DEFAULT_CONFIG, shouldCompressRequest, setupFetchHook, teardownFetchHook, updateLiveContext } from "../extensions/request-compress.ts";
import { normalizeDisplayPath } from "../extensions/image-pager.ts";
import { TimerManager, handleTimerCommand } from "../extensions/timer.ts";
import { TtsGatewayAdapter } from "../extensions/voice.ts";

const root = mkdtempSync(join(tmpdir(), "extension-regressions-"));
const originalAgent = process.env.PI_CODING_AGENT_DIR, originalHome = process.env.USERPROFILE, originalUnixHome = process.env.HOME;
const originalFetch = globalThis.fetch;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.USERPROFILE = root; process.env.HOME = root;
mkdirSync(process.env.PI_CODING_AGENT_DIR); mkdirSync(join(root, ".pi"));
initTheme();
const theme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: s => s, style: s => s };
const tui = { requestRender() {}, terminal: { rows: 45 } };
const handlersFor = () => {
	const handlers = new Map(), commands = new Map(), tools = new Map();
	return { handlers, commands, tools, pi: {
		on(e, h) { handlers.set(e, [...(handlers.get(e) || []), h]); },
		registerCommand(n, c) { commands.set(n, c); }, registerTool(t) { tools.set(t.name, t); },
		registerShortcut() {}, registerFlag() {}, getFlag: () => "20", getActiveTools: () => [], setActiveTools() {}, appendEntry() {},
	} };
};
const emit = async (h, event, payload, ctx) => { for (const fn of h.get(event) || []) await fn(payload, ctx); };

try {
	// Real session manager deliberately retains data references; extension snapshots must not.
	const env = handlersFor(), sm = SessionManager.inMemory(root);
	env.pi.appendEntry = (type, data) => sm.appendCustomEntry(type, data);
	todoTree(env.pi);
	const ctx = { cwd: root, hasUI: false, ui: { notify() {} }, sessionManager: sm };
	const tool = env.tools.get("todo");
	const beforeTodos = sm.appendCustomEntry("test-before-todos", {});
	await tool.execute("create", { action: "create", id: "1", subject: "first", status: "pending" });
	const earliest = sm.getBranch().find(e => e.type === "custom" && e.customType === SNAPSHOT_ENTRY_TYPE);
	await tool.execute("update", { action: "update", id: "1", status: "completed", note: "later note" });
	assert.equal(earliest.data.tasks[0].status, "pending");
	assert.deepEqual(earliest.data.tasks[0].notes, []);
	sm.branch(earliest.id); await emit(env.handlers, "session_tree", {}, ctx);
	assert.equal((await tool.execute("list", { action: "list" })).details.tasks[0].status, "pending");
	sm.branch(beforeTodos); await emit(env.handlers, "session_tree", {}, ctx);
	assert.equal((await tool.execute("list", { action: "list" })).details.tasks.length, 0);
	await tool.execute("finished", { action: "create", id: "old", subject: "old plan", status: "completed" });
	const beforeBatch = sm.getBranch().length;
	const badBatch = await tool.execute("batch", { action: "batch_create", tasks: [{ id: "new", subject: "new plan" }, { id: "new", subject: "duplicate" }] });
	assert.equal(badBatch.isError, true);
	assert.deepEqual(badBatch.details.tasks.map(t => t.id), ["old"], "failed replacement batch must preserve the finished tree");
	assert.equal(sm.getBranch().length, beforeBatch, "failed batch must not persist a partial snapshot");
	await emit(env.handlers, "session_tree", {}, ctx);
	assert.deepEqual((await tool.execute("list", { action: "list" })).details.tasks.map(t => t.id), ["old"]);
	console.log("✓ independent todo snapshots, empty branches and atomic replacement batches");

	const loop = handlersFor(), sent = [], warnings = [];
	todoLoop(loop.pi);
	assert.equal(loop.handlers.has("agent_end"), false, "must not race core retry in agent_end");
	let branch = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [{ status: "pending" }] } } }];
	const loopCtx = { hasPendingMessages: () => false, ui: { notify(m) { warnings.push(m); } }, sessionManager: { getBranch: () => branch } };
	const assistant = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Working." }] };
	const boundary = { entries: [], outcome: "completed", context: { canContinue: false, contextMessages: [assistant] } };
	const runBoundary = async event => {
		const result = await loop.handlers.get("agent_before_settle")[0](event, loopCtx);
		if (result?.continue) sent.push(result.entries.at(-1));
		return result;
	};
	await runBoundary({ ...boundary, outcome: "error" });
	await runBoundary({ ...boundary, outcome: "aborted" });
	assert.equal(sent.length, 0);
	const continued = await runBoundary(boundary);
	assert.equal(sent.length, 1);
	assert.equal(continued.continue, true);
	assert.equal(sent[0].customType, "todo-loop-followup");
	const boundaryManager = SessionManager.inMemory(root);
	boundaryManager.appendMessage({ role: "user", content: "task", timestamp: 0 });
	boundaryManager.appendMessage({ ...assistant, timestamp: 1 });
	const sessionPreview = { sessionManager: boundaryManager, _cwd: root, _pendingCustomMessages: [], agent: { peekQueuedMessages: () => [], hasQueuedMessages: () => false } };
	for (const method of ["_createBoundaryPreviewManager", "_getPendingBoundaryMessages", "_applyBoundaryDrafts"]) sessionPreview[method] = AgentSession.prototype[method];
	assert.equal(AgentSession.prototype._buildBoundaryContext.call(sessionPreview, [], "agent_before_settle").canContinue, false);
	assert.equal(AgentSession.prototype._buildBoundaryContext.call(sessionPreview, continued.entries, "agent_before_settle").canContinue, true);
	const continuation = sent[0].content;
	for (const snapshot of [{ enabled: true, tasks: [] }, { enabled: true, tasks: [{ status: "completed" }] }, { enabled: true, tasks: [{ status: "cancelled" }] }, { enabled: false, tasks: [{ status: "pending" }] }]) {
		branch = [branch[0], { type: "custom", customType: SNAPSHOT_ENTRY_TYPE, data: snapshot }];
		await runBoundary(boundary);
	}
	assert.equal(sent.length, 1, "authoritative UI snapshots must override stale tool state");
	branch = [branch[0], ...Array.from({ length: 20 }, () => ({ type: "message", message: { role: "user", content: continuation } }))];
	await runBoundary(boundary);
	assert.equal(sent.length, 1); assert.equal(warnings.length, 1);
	branch = [branch[0], ...Array.from({ length: 20 }, () => ({ type: "custom_message", customType: "todo-loop-followup", content: continuation }))];
	await runBoundary(boundary); assert.equal(sent.length, 1);
	console.log("✓ todo continuation waits for settlement, obeys UI state and preserves budget");

	const retry = handlersFor(); streamRetry(retry.pi);
	const retryHandler = retry.handlers.get("message_end")[0];
	for (const error of ["stream error: invalid_request_error: unsupported parameter temperature", "stream disconnected: quota exceeded", "stream closed before completion: unauthorized 401"]) {
		assert.equal(retryHandler({ message: { role: "assistant", stopReason: "error", errorMessage: error } }), undefined);
	}
	const rewritten = retryHandler({ message: { role: "assistant", stopReason: "error", errorMessage: "stream disconnected before completion: stream closed before response.completed" } });
	assert.ok(rewritten.message.errorMessage.startsWith("Network error:"));
	assert.equal(isRetryableAssistantError(rewritten.message), true);
	assert.equal(retryHandler({ message: rewritten.message }), undefined);
	console.log("✓ transport retry remains specific and deterministic errors are not rewritten");

	const rolling = handlersFor();
	let widget, statusLines = [], branchEntries = [];
	const notifications = [];
	const originalNotify = (m, t) => notifications.push({ m, t });
	const ui = { notify: originalNotify, setStatus() {}, setToolsExpanded() {},
		setWidget(_key, factory) { if (typeof factory === "function") widget = factory; },
		custom(factory, options) { assert.equal(options.overlay, true); const c = factory(tui, theme, {}, () => {}); statusLines = c.render(80); c.handleInput("\r"); return Promise.resolve(); },
	};
	const rollingCtx = { cwd: root, hasUI: true, mode: "tui", ui, sessionManager: {
		getEntries: () => [{ type: "custom", customType: "rolling-tools-history", data: { total: 1, items: [{ id: "abandoned", name: "bash", summaryDisplay: "ABANDONED-BRANCH", status: "done" }] } }],
		getBranch: () => branchEntries,
	} };
	rollingTools(rolling.pi);
	await emit(rolling.handlers, "session_start", { reason: "startup" }, rollingCtx);
	assert.ok(!widget(tui, theme).render(100).join("\n").includes("ABANDONED-BRANCH"));
	await rolling.commands.get("rolling-tools").handler("status", rollingCtx);
	assert.ok(statusLines.join("\n").includes("Rolling Tools"));
	for (const line of statusLines) assert.ok(visibleWidth(line) <= 80);
	ui.notify("normal notice", "info"); assert.equal(notifications.length, 0);
	await rolling.commands.get("rolling-tools").handler("off", rollingCtx);
	ui.notify("notice after off", "info"); assert.ok(notifications.some(n => n.m === "notice after off"));
	const message = { role: "assistant", content: [{ type: "thinking", thinking: "reasoning", thinkingSignature: "signature" }, { type: "text", text: "answer" }] };
	await emit(rolling.handlers, "message_end", { message }, rollingCtx);
	assert.equal(message.content[0].thinkingSignature, "signature");
	const streamMessage = structuredClone(message);
	await emit(rolling.handlers, "message_update", { message: streamMessage, assistantMessageEvent: { type: "text_delta", delta: "answer" } }, rollingCtx);
	assert.equal(streamMessage.content[0].type, "thinking");
	await rolling.commands.get("rolling-tools").handler("on", rollingCtx);
	const reasoningComponent = new AssistantMessageComponent(message);
	assert.ok(!reasoningComponent.render(80).join("\n").includes("reasoning"), "thinking stays hidden at the visual layer");
	assert.equal(message.content[0].thinkingSignature, "signature");
	await rolling.commands.get("rolling-tools").handler("off", rollingCtx);
	assert.ok(reasoningComponent.render(80).join("\n").includes("reasoning"), "off restores the original component view");
	branchEntries = [{ type: "custom", customType: "rolling-tools-history", data: { total: 3, items: [{ id: "in-branch", index: 3, name: "read", summaryDisplay: "BRANCH-A", status: "running", startTime: Date.now() }] } }];
	await rolling.commands.get("rolling-tools").handler("on", rollingCtx);
	await emit(rolling.handlers, "session_tree", {}, rollingCtx);
	const restoredLines = widget(tui, theme).render(100);
	assert.ok(restoredLines.some(l => l.includes("BRANCH-A") && l.includes("✗")), "orphan running entries must be marked interrupted");
	branchEntries = [];
	await emit(rolling.handlers, "session_tree", {}, rollingCtx);
	assert.ok(!widget(tui, theme).render(100).some(l => l.includes("BRANCH-A")));
	assert.ok(!reasoningComponent.render(80).join("\n").includes("reasoning"));
	await emit(rolling.handlers, "session_shutdown", { reason: "reload" }, rollingCtx);
	assert.ok(reasoningComponent.render(80).join("\n").includes("reasoning"), "unload restores an existing assistant component");
	assert.equal(ui.notify, originalNotify, "shutdown must restore wrapped UI functions");
	const component = new ToolExecutionComponent("read", "c", { path: "x" }, {}, undefined, tui, root);
	assert.ok(component.render(80).length > 0, "unloaded extension must not silence global tool rendering");
	console.log("✓ visible status, working off switch, intact reasoning, branch-local history and unload cleanup");

	const envCtx = { defaultProvider: "fixture", providerBaseUrls: new Map([["api.example", "fixture"]]), modelToProvider: new Map([["fixture-model", "fixture"]]) };
	const raw = Buffer.from(JSON.stringify({ model: "fixture-model", text: "x".repeat(2048) }));
	assert.equal(shouldCompressRequest("https://unknown.example/v1", "POST", raw, null, DEFAULT_CONFIG, envCtx).shouldCompress, false);
	assert.equal(shouldCompressRequest("https://api.example/tts", "POST", Buffer.from(JSON.stringify({ text: "x".repeat(2048) })), null, DEFAULT_CONFIG, envCtx).shouldCompress, false);
	assert.equal(shouldCompressRequest("https://api.example/v1/responses", "POST", raw, null, DEFAULT_CONFIG, envCtx).shouldCompress, true);
	assert.equal(shouldCompressRequest("https://explicit.example/v1", "POST", raw, null, { ...DEFAULT_CONFIG, targetHosts: ["explicit.example"] }, envCtx).shouldCompress, true);
	assert.equal(shouldCompressRequest("https://api.example/v1", "POST", Buffer.from('{"model":"fixture-model","broken":' + "x".repeat(2048)), null, DEFAULT_CONFIG, envCtx).shouldCompress, false);
	let compressedRequest;
	globalThis.fetch = async (_url, init) => { compressedRequest = init; return new Response("ok"); };
	updateLiveContext({ ...DEFAULT_CONFIG, algorithm: "gzip" }, envCtx); setupFetchHook();
	await fetch("https://api.example/v1/responses", { method: "POST", body: raw });
	assert.equal(new Headers(compressedRequest.headers).get("content-encoding"), "gzip");
	const wrapper = globalThis.fetch;
	teardownFetchHook();
	assert.notEqual(globalThis.fetch, wrapper);
	setupFetchHook();
	const inner = globalThis.fetch, outer = (...args) => inner(...args); globalThis.fetch = outer;
	teardownFetchHook();
	assert.equal(globalThis.fetch, outer, "teardown must not overwrite another extension's wrapper");
	await fetch("https://api.example/v1/responses", { method: "POST", body: raw });
	assert.equal(compressedRequest.body, raw, "nested uninstalled compression hook must pass through");
	globalThis.fetch = inner; teardownFetchHook(); globalThis.fetch = originalFetch;
	const legacyHook = Symbol.for("__pi_request_compress_fetch_hooked__");
	const legacyConfig = { ...DEFAULT_CONFIG };
	updateLiveContext(legacyConfig, envCtx);
	globalThis[legacyHook] = true;
	assert.equal(setupFetchHook(), false, "unknown legacy wrapper chains require restart");
	assert.equal(legacyConfig.enabled, false);
	delete globalThis[legacyHook];
	const compressEnv = handlersFor(); requestCompress(compressEnv.pi);
	await compressEnv.commands.get("request-compress").handler("status", rollingCtx);
	assert.ok(statusLines.join("\n").includes("Request Compression"));
	console.log("✓ compression host isolation, valid JSON, modal status and composable fetch teardown");

	const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout, realNow = Date.now;
	const waits = [], sentTimers = [];
	let now = 1_000_000;
	Date.now = () => now;
	globalThis.setTimeout = (fn, delay) => { const handle = { fn, delay }; waits.push(handle); return handle; };
	globalThis.clearTimeout = () => {};
	const manager = new TimerManager({ appendEntry() {}, sendUserMessage(m) { sentTimers.push(m); } });
	await handleTimerCommand("list", rollingCtx, manager);
	assert.ok(statusLines.length > 0, "timer list must use visible status UI");
	manager.attach({ isIdle: () => true, ui: { notify() {}, setWidget() {} } });
	try {
		const task = manager.createTask(30 * 86400, "execute in 30 days");
		assert.equal(waits[0].delay, 2_147_483_647);
		now += waits[0].delay; waits[0].fn();
		assert.equal(sentTimers.length, 0); assert.equal(task.status, "pending");
		assert.ok(waits[1].delay > 0 && waits[1].delay <= 2_147_483_647);
		now = task.targetTime; waits[1].fn();
		assert.deepEqual(sentTimers, ["execute in 30 days"]);
		for (const duration of [NaN, Infinity, -1, Number.MAX_VALUE]) assert.throws(() => manager.createTask(duration, "bad"), /无效/);
	} finally { manager.dispose(); Date.now = realNow; globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; }
	assert.equal(normalizeDisplayPath("~/reference.png", root), join(homedir(), "reference.png").replace(/\\/g, "/"));
	assert.equal(normalizeDisplayPath("@~/reference.png", root), join(homedir(), "reference.png").replace(/\\/g, "/"));
	assert.equal(normalizeDisplayPath(pathToFileURL(join(root, "space image.png")).href, root), join(root, "space image.png").replace(/\\/g, "/"));
	if (process.platform === "win32") assert.equal(normalizeDisplayPath("/d/work/image.png", root), "D:/work/image.png");
	console.log("✓ bounded long-timer chaining and read-compatible home pointer paths");

	const adapter = new TtsGatewayAdapter("http://mock");
	for (const bad of [{}, { code: 1, error: "speaker offline" }, { status: "completed", error: "failure" }]) {
		globalThis.fetch = async () => Response.json(bad);
		await assert.rejects(adapter.speak("test", { voiceId: "default", speed: 1, signal: new AbortController().signal }));
	}
	console.log("✓ strict voice response validation (gateway isolation redesign intentionally deferred)");
} finally {
	teardownFetchHook(); globalThis.fetch = originalFetch;
	for (const [key, value] of [["PI_CODING_AGENT_DIR", originalAgent], ["USERPROFILE", originalHome], ["HOME", originalUnixHome]]) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
}
console.log("All extension integration regressions passed.");
