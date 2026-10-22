import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// No user configuration, sessions, network, clipboard, GUI or audio devices.
const root = mkdtempSync(join(tmpdir(), "extension-edge-cases-"));
const original = { cwd: process.cwd(), fetch: globalThis.fetch, now: Date.now,
	setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
	env: Object.fromEntries(["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR"].map(key => [key, process.env[key]])) };
process.env.HOME = join(root, "home"); process.env.USERPROFILE = process.env.HOME;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
for (const path of [process.env.HOME, process.env.PI_CODING_AGENT_DIR, join(root, ".pi")]) mkdirSync(path, { recursive: true });
process.chdir(root);
const { SessionManager, InteractiveMode, ToolExecutionComponent, createReadToolDefinition, initTheme } = await import("@earendil-works/pi-coding-agent");
const { Text, visibleWidth } = await import("@earendil-works/pi-tui");
const keys = { home: "\x1b[H", down: "\x1b[B", pageDown: "\x1b[6~", escape: "\x1b" };
const { default: rollingTools } = await import("../extensions/rolling-tools.ts");
const media = await import("../extensions/media-gen.ts");
const todo = await import("../extensions/todo-tree.ts");
const { default: todoLoop } = await import("../extensions/todo-loop.ts");
const timer = await import("../extensions/timer.ts");
const voice = await import("../extensions/voice.ts");
const { StatusModalComponent } = await import("../extensions/lib/status-modal.ts");
const hostUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const { resolveToCwd } = await import(new URL("./core/tools/path-utils.js", hostUrl).href);
initTheme();
const theme = { fg: (_c, s) => s, bg: (_c, s) => s, style: s => s, bold: s => s };
const liveRuntimes = new Set();
function harness({ hasUI = false, sm = SessionManager.inMemory(root) } = {}) {
	const handlers = new Map(), commands = new Map(), tools = new Map(), renderers = [];
	let active = [], overlay;
	const tui = { terminal: { rows: 40 }, requestRender() {} };
	const ctx = { cwd: root, mode: hasUI ? "tui" : "json", hasUI, isIdle: () => true, hasPendingMessages: () => false, sessionManager: sm,
		ui: { notify() {}, setStatus() {}, setToolsExpanded() {}, setWidget() {},
			custom(factory) { return new Promise(done => { overlay = factory(tui, theme, {}, done); }); } } };
	const h = { handlers, commands, tools, renderers, ctx, sm, tui, overlay: () => overlay,
		pi: { on(e, fn) { handlers.set(e, [...(handlers.get(e) || []), fn]); }, registerCommand(n, c) { commands.set(n, c); },
			registerTool(t) { tools.set(t.name, t); }, registerToolRenderer(r) { renderers.push(r); }, registerEntryRenderer() {}, registerShortcut() {},
			registerFlag() {}, getFlag: () => "20", getActiveTools: () => active, setActiveTools(next) { active = next; },
			appendEntry(type, data) { sm.appendCustomEntry(type, data); }, sendUserMessage() {} },
		async emit(e, event = {}) { let result; for (const fn of handlers.get(e) || []) result = await fn(event, ctx); return result; },
		async command(text) { await commands.get("rolling-tools").handler(text, ctx); },
		async shutdown() { await h.emit("session_shutdown"); liveRuntimes.delete(h); },
		history: () => sm.getBranch().filter(e => e.type === "custom" && e.customType === "rolling-tools-history"),
	};
	return h;
}
async function rolling(config = {}, sm) {
	writeFileSync(join(root, ".pi", "rolling-tools.json"), JSON.stringify({ configVersion: 3, ...config }));
	const h = harness({ hasUI: true, sm }); rollingTools(h.pi); liveRuntimes.add(h);
	await h.emit("session_start"); return h;
}
const textResult = text => ({ content: [{ type: "text", text }], details: undefined });
async function toolStart(h, id, name, args) { await h.emit("tool_execution_start", { toolCallId: id, toolName: name, args }); }
async function toolEnd(h, id, name, text = "ok") {
	await h.emit("tool_execution_end", { toolCallId: id, toolName: name, isError: false, durationMs: 1, result: textResult(text) });
}

try {
	// Renderers must see their own previous component for BOTH call and result slots.
	{
		const h = await rolling();
		const wrapped = h.renderers[0]("read", () => createReadToolDefinition(root));
		const row = new ToolExecutionComponent("read", "renderer", { path: "fixture.txt" }, {}, wrapped, { requestRender() {} }, root);
		const call = row.callRendererComponent, callInner = call.inner;
		row.markExecutionStarted(); row.setArgsComplete(); row.updateArgs({ path: "next.txt" });
		assert.equal(row.callRendererComponent, call); assert.equal(call.inner, callInner);
		row.updateResult({ ...textResult("first"), isError: false });
		const result = row.resultRendererComponent, resultInner = result.inner;
		row.updateResult({ ...textResult("second"), isError: false }); row.setExpanded(true);
		assert.equal(row.resultRendererComponent, result); assert.equal(result.inner, resultInner);
		assert.match(result.render(80).join("\n"), /second/);
		const base = { renderResult(_r, _o, _t, ctx) { const text = ctx.lastComponent ?? new Text("", 0, 0); text.setText("Money saved · header\nactual output"); return text; } };
		const filtered = h.renderers[0]("fixture", () => base);
		const context = { lastComponent: undefined, state: {} };
		const component = filtered.renderResult({}, {}, theme, context);
		const nextContext = { ...context, lastComponent: component };
		assert.equal(filtered.renderResult({}, {}, theme, nextContext), component);
		assert.equal(nextContext.lastComponent, component, "do not mutate the host's render context");
		assert.doesNotMatch(component.render(80).join("\n"), /Money saved/);
		await h.command("off"); assert.match(component.render(80).join("\n"), /Money saved/);
		const createdWhileOff = h.renderers[0]("fixture", () => base).renderResult({}, {}, theme, context);
		assert.match(createdWhileOff.render(80).join("\n"), /Money saved/);
		await h.command("on"); assert.doesNotMatch(component.render(80).join("\n"), /Money saved/);
		assert.doesNotMatch(createdWhileOff.render(80).join("\n"), /Money saved/);
		const inputs = [], mouse = [], inner = { wantsKeyRelease: true, render: () => ["content"], invalidate() {}, handleInput: data => inputs.push(data), handleMouse: event => { mouse.push(event); return { handled: true }; } };
		const delegated = h.renderers[0]("input-fixture", () => ({ renderCall: () => inner })).renderCall({}, theme, {});
		delegated.handleInput("key"); assert.deepEqual(inputs, ["key"]); assert.equal(delegated.wantsKeyRelease, true);
		const click = { type: "click", x: 0, y: 0 }; assert.deepEqual(delegated.handleMouse(click), { handled: true }); assert.equal(mouse[0], click);
		inner.render = () => ["Money saved · header", "button"];
		assert.deepEqual(delegated.render(80), ["button"]);
		delegated.handleMouse(click); assert.equal(mouse.at(-1).y, 1, "hidden headers must not shift mouse hit targets");
		await h.command("off"); delegated.render(80); delegated.handleMouse(click); assert.equal(mouse.at(-1), click);
		await h.shutdown(); assert.match(component.render(80).join("\n"), /Money saved/);
		console.log("✓ native call/result renderer reuse, unchanged context and live off/unload behavior");
	}

	// Each status key owns its timer/deadline. Fake time is finite and manually advanced.
	{
		const h = await rolling({ statusEnhancements: [{ keyPattern: "*", durationMs: 3000, showRelativeTime: true, colorize: false }] });
		let now = 0; const intervals = new Map(), statuses = new Map();
		const im = Object.create(InteractiveMode.prototype);
		im.footerDataProvider = { setExtensionStatus(key, text) { if (text === undefined) statuses.delete(key); else statuses.set(key, text); } };
		im.ui = { requestRender() {} };
		try {
			Date.now = () => now;
			globalThis.setInterval = fn => { const handle = { unref() {} }; intervals.set(handle, fn); return handle; };
			globalThis.clearInterval = handle => intervals.delete(handle);
			const tick = time => { now = time; for (const fn of [...intervals.values()]) fn(); };
			im.setExtensionStatus("A", "first"); now = 1000; im.setExtensionStatus("B", "second");
			assert.equal(intervals.size, 2);
			im.setExtensionStatus("unrelated", undefined); assert.equal(statuses.has("unrelated"), false);
			im.setExtensionStatus("mcp", "persistent"); im.setExtensionStatus("blackhole", "persistent");
			assert.equal(intervals.size, 2); assert.equal(statuses.get("mcp"), "persistent");
			tick(3100); assert.equal(statuses.has("A"), false); assert.match(statuses.get("B"), /second/);
			im.setExtensionStatus("A", undefined); assert.equal(statuses.has("A"), false, "B must not suppress A's clear");
			tick(4100); assert.equal(statuses.has("B"), false); assert.equal(intervals.size, 0);
			im.setExtensionStatus("A", "old"); const staleTick = [...intervals.values()][0];
			now = 4500; im.setExtensionStatus("A", "replacement"); staleTick();
			assert.match(statuses.get("A"), /replacement/); assert.equal(intervals.size, 1);
			im.setExtensionStatus("A", undefined); assert.equal(statuses.has("A"), true, "preserve the explicit minimum display window");
			await h.command("off"); assert.equal(intervals.size, 0); assert.equal(statuses.has("A"), false);
			assert.equal(statuses.get("mcp"), "persistent", "do not erase another extension's persistent status");
			await h.command("on"); im.setExtensionStatus("B", "pending");
			await h.command(""); assert.equal(intervals.size, 0, "default toggle must clean up too");
			await h.command("on"); im.setExtensionStatus("B", "pending");
			await h.command("reload"); assert.equal(intervals.size, 0);
			writeFileSync(join(root, ".pi", "rolling-tools.json"), JSON.stringify({ configVersion: 3, statusEnhancements: [{ keyPattern: "*", durationMs: 250 }] }));
			await h.command("reload"); im.setExtensionStatus("short", "quarter second");
			tick(now + 250); assert.equal(statuses.has("short"), false); assert.equal(intervals.size, 0);
			im.setExtensionStatus("B", "pending"); await h.shutdown(); assert.equal(intervals.size, 0);
		} finally { Date.now = original.now; globalThis.setInterval = original.setInterval; globalThis.clearInterval = original.clearInterval; }
		console.log("✓ independent status-key expiry/replacement, persistent keys and off/reload/shutdown cleanup");
	}

	// Real in-memory session snapshots retain references, so serialization must copy AND bound inputs.
	{
		const sm = SessionManager.inMemory(root), h = await rolling({}, sm);
		const args = { path: "large.txt", content: "中".repeat(64000) };
		sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "large", name: "write", arguments: args }], stopReason: "toolUse", timestamp: 0 });
		await toolStart(h, "large", "write", args); await toolEnd(h, "large", "write");
		await toolStart(h, "parent/1", "write", { path: "nested.txt", content: "x".repeat(64000) }); await toolEnd(h, "parent/1", "write");
		const small = { path: "small.txt", options: { value: "original" } };
		await toolStart(h, "small", "read", small); await toolEnd(h, "small", "read");
		for (let n = 0; n < 3; n++) await h.emit("agent_end", { messages: [] });
		for (const snapshot of h.history()) for (const item of snapshot.data.items) {
			assert.equal(item.detailVersion, undefined);
			if (item.id === "small") assert.equal(item.rawInput.options.value, "original");
			else { assert.equal(item.rawInputTruncated, true); assert.ok(item.rawInput.length <= 20000); assert.match(item.rawInput, /History input truncated/); }
		}
		small.options.value = "mutated later";
		assert.equal(h.history()[0].data.items.find(i => i.id === "small").rawInput.options.value, "original");
		const nestedPreview = h.history()[0].data.items.find(i => i.id === "parent/1").rawInput;
		await h.shutdown();
		for (let reload = 0; reload < 2; reload++) {
			const restored = await rolling({}, sm); await restored.command("history");
			const items = restored.overlay().allItems;
			assert.deepEqual(items.find(i => i.id === "large").rawInput, args, "restore complete arguments from the canonical call");
			assert.equal(items.find(i => i.id === "large").rawInputTruncated, undefined);
			assert.equal(items.find(i => i.id === "parent/1").rawInput, nestedPreview, "nested calls keep a stable, explicit bounded preview");
			await restored.shutdown();
		}
		console.log("✓ bounded/deep-copied raw inputs, full session backfill and stable nested previews across reloads");
	}

	// Match Pi's actual path resolver; no clipboard or OS-open operations are invoked.
	{
		const h = await rolling();
		const paths = ["~/fixture.txt", "~", "@~/fixture.txt", "relative.txt", "some\u202fspace.txt", pathToFileURL(join(root, "file # 中文.txt")).href];
		if (process.platform === "win32") paths.push("~\\fixture.txt", "/d/work/file.txt", "/mnt/c/work/file.txt", "/cygdrive/d/work/file.txt");
		for (const [index, path] of paths.entries()) for (const name of ["read", "edit", "write", "grep", "ls", "mcp__fixture__read"]) {
			const id = `${index}-${name}`;
			await toolStart(h, id, name, { path }); await toolEnd(h, id, name);
		}
		await h.emit("agent_end", { messages: [] });
		for (const item of h.history().at(-1).data.items) assert.equal(item.fullPath, resolveToCwd(item.rawInput.path, root));
		assert.equal(homedir(), process.env.USERPROFILE);
		await h.shutdown();
		const legacy = SessionManager.inMemory(root);
		legacy.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "legacy", name: "read", arguments: { path: "~/fixture.txt" } }], timestamp: 0, stopReason: "toolUse" });
		const oldPath = resolve(root, "~/fixture.txt");
		const legacyData = { total: 1, items: [{ id: "legacy", index: 1, name: "read", fullPath: oldPath, status: "done", startTime: 0 }] };
		legacy.appendCustomEntry("rolling-tools-history", legacyData);
		const restored = await rolling({}, legacy); await restored.command("history");
		assert.equal(restored.overlay().allItems[0].fullPath, resolveToCwd("~/fixture.txt", root));
		assert.equal(legacyData.items[0].fullPath, oldPath, "do not mutate historical snapshot entries");
		await restored.shutdown(); console.log("✓ Pi-compatible home/@/file URL/Unicode-space/Windows-shell paths and legacy in-memory repair");
	}

	// Bounded performance fixture: 16K CJK chars, not an unbounded synthetic stream/agent loop.
	{
		const h = await rolling();
		await toolStart(h, "perf", "read", { path: "fixture.txt" });
		await toolEnd(h, "perf", "read", "中".repeat(16384)); await h.emit("agent_end", { messages: [] });
		await h.command("history"); const overlay = h.overlay();
		const styled = "\x1b[32m" + "中👨‍👩‍👧‍👦".repeat(20) + "\x1b[0m";
		const styledLines = overlay.wrapLine(styled, 12, line => line);
		for (const line of styledLines) assert.ok(visibleWidth(line) <= 12);
		const stripColors = text => text.replace(/\x1b\[[0-9;]*m/g, "");
		assert.equal(styledLines.map(stripColors).join(""), stripColors(styled));
		const wrap = overlay.wrapLine.bind(overlay); let wraps = 0;
		overlay.wrapLine = (...args) => { wraps++; return wrap(...args); };
		const start = performance.now(); overlay.render(80); const firstMs = performance.now() - start;
		const afterFirst = wraps, firstLines = overlay.buildDetailLines(35);
		const cachedStart = performance.now(); overlay.render(80); const cachedMs = performance.now() - cachedStart;
		assert.equal(wraps, afterFirst, "unchanged redraws must not rewrap all history text");
		assert.equal(overlay.buildDetailLines(35), firstLines);
		overlay.render(100); assert.ok(wraps > afterFirst, "resize must reflow");
		const beforeTheme = wraps; overlay.invalidate(); overlay.render(100); assert.ok(wraps > beforeTheme);
		await toolEnd(h, "perf", "read", "updated output");
		assert.match(overlay.buildDetailLines(35).join("\n"), /updated output/);
		const args = { query: "fixed", extra: "before" };
		await toolStart(h, "stream", "fixture", args); overlay.selectIndex(overlay.allItems.length - 1);
		assert.match(overlay.buildDetailLines(35).join("\n"), /before/);
		args.extra = "after";
		await h.emit("message_update", { assistantMessageEvent: { type: "toolcall_delta" }, message: { role: "assistant", content: [{ type: "toolCall", id: "stream", name: "fixture", arguments: args }] } });
		assert.match(overlay.buildDetailLines(35).join("\n"), /after/, "same-object streaming mutations must invalidate the cache");
		await h.command("clear"); overlay.render(80); assert.equal(overlay.detailCache, undefined, "release cached content when history is cleared");
		await h.shutdown();
		console.log(`✓ linear/cached detail layout, resize/theme/result/stream invalidation (16K CJK: ${firstMs.toFixed(1)}ms first, ${cachedMs.toFixed(1)}ms cached)`);
	}

	// Video fixtures certify container signatures only, not decoder/physical playback completion.
	{
		const mp4 = Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex");
		const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);
		const html = "<!DOCTYPE html><h1>upstream error</h1>";
		const provider = { providerName: "fixture", baseUrl: "https://provider.invalid/v1", apiKey: "fixture-not-a-key", availableModels: [] };
		for (const [name, binary, status] of [["url-html", html, 200], ["url-empty", "", 200], ["url-error", html, 403], ["b64-html", html, 200], ["b64-invalid", "", 200]]) {
			const output = join(root, name), tried = [];
			globalThis.fetch = async (url, init) => {
				if (String(url).endsWith("/videos/generations")) {
					const { model } = JSON.parse(init.body); tried.push(model);
					return Response.json({ data: [model === "good" ? { b64_json: mp4.toString("base64") } : name.startsWith("url") ? { url: "https://cdn.invalid/bad.mp4" } : { b64_json: Buffer.from(binary).toString("base64") || "###" }] });
				}
				return new Response(binary, { status, headers: { "content-type": "text/html" } });
			};
			const config = { primaryModel: "bad", fallbackModels: ["good"], outputDir: output };
			const result = await media.executeVideoGeneration({ prompt: "fixture" }, config, provider, root);
			assert.equal(result.usedModel, "good"); assert.deepEqual(tried, ["bad", "good"]);
			assert.deepEqual(readFileSync(result.filePath), mp4); assert.equal(readdirSync(output).length, 1);
			const rejectedDir = join(root, `${name}-rejected`);
			await assert.rejects(media.executeVideoGeneration({ prompt: "fixture" }, { ...config, fallbackModels: [], outputDir: rejectedDir }, provider, root));
			assert.equal(existsSync(rejectedDir), false, "reject invalid bytes before creating any output path");
		}
		globalThis.fetch = async () => Response.json({ data: [{ b64_json: webm.toString("base64") }] });
		const result = await media.executeVideoGeneration({ prompt: "fixture" }, { primaryModel: "webm", outputDir: join(root, "webm") }, provider, root);
		assert.ok(result.filePath.endsWith(".webm")); assert.deepEqual(readFileSync(result.filePath), webm);
		const controller = new AbortController(), cancelledOutput = join(root, "cancelled-video"); let requests = 0;
		globalThis.fetch = async (_url, init) => {
			requests++;
			if (init?.method === "POST") return Response.json({ data: [{ url: "https://cdn.invalid/video.mp4" }] });
			return { ok: true, async arrayBuffer() { controller.abort(); return mp4.buffer.slice(mp4.byteOffset, mp4.byteOffset + mp4.byteLength); } };
		};
		await assert.rejects(media.executeVideoGeneration({ prompt: "fixture" }, { primaryModel: "bad", fallbackModels: ["good"], outputDir: cancelledOutput }, provider, root, controller.signal), /abort/i);
		assert.equal(requests, 2); assert.equal(existsSync(cancelledOutput), false);
		writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: provider.baseUrl, apiKey: provider.apiKey } } }));
		writeFileSync(join(root, "media-gen.json"), JSON.stringify({ provider: "fixture", video: { primaryModel: "bad", outputDir: join(root, "failed-video-tool") } }));
		globalThis.fetch = async () => Response.json({ data: [{ b64_json: Buffer.from(html).toString("base64") }] });
		const env = harness(); media.default(env.pi);
		assert.equal((await env.tools.get("generate_video").execute("bad", { prompt: "fixture" }, undefined, undefined, env.ctx)).isError, true);
		globalThis.fetch = original.fetch;
		console.log("✓ MP4/WebM validation, URL/base64 failures and fallback, no invalid/cancelled writes, true video tool errors");
	}

	{
		for (const finished of ["cancelled", "completed"]) {
			const h = harness(); todo.default(h.pi); const tool = h.tools.get("todo");
			await tool.execute("old", { action: "batch_create", tasks: [{ id: "1", subject: "old", status: finished }] });
			const before = h.sm.getBranch().length;
			const invalid = await tool.execute("invalid", { action: "batch_create", tasks: [{ id: "1", subject: "new" }, { id: "1", subject: "duplicate" }] });
			assert.equal(invalid.isError, true); assert.equal(invalid.details.tasks[0].subject, "old"); assert.equal(h.sm.getBranch().length, before);
			const next = await tool.execute("new", { action: "batch_create", tasks: [{ id: "1", subject: "new" }] });
			assert.notEqual(next.isError, true); assert.deepEqual(next.details.tasks.map(t => t.subject), ["new"]);
		}
		const h = harness(); todo.default(h.pi); const tool = h.tools.get("todo");
		await tool.execute("old", { action: "batch_create", tasks: [{ id: "1", subject: "parent" }, { id: "1.1", parentId: "1", subject: "child", status: "completed" }] });
		await tool.execute("reopen", { action: "update", id: "1", status: "pending" });
		assert.equal((await tool.execute("new", { action: "batch_create", tasks: [{ id: "1", subject: "must not erase unfinished parent" }] })).isError, true);
		console.log("✓ all-cancelled/completed tree replacement, atomic failures and unfinished-parent preservation");
	}

	{
		const h = harness(); todoLoop(h.pi);
		const pending = { type: "custom", customType: "plan-mode", data: { executing: true, todos: [{ text: "old", completed: false }] } };
		let branch = [pending]; h.ctx.sessionManager = { getBranch: () => branch };
		const boundary = { outcome: "completed", entries: [], context: { contextMessages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Ready." }] }] } };
		assert.equal((await h.emit("agent_before_settle", boundary)).continue, true);
		for (const data of [{ executing: false, todos: [] }, { executing: false }, { executing: false, todos: [{ completed: false }] }]) {
			branch = [pending, { type: "custom", customType: "plan-mode", data }];
			const stopped = await h.emit("agent_before_settle", boundary);
			assert.notEqual(stopped?.continue, true);
			assert.equal(stopped.entries.at(-1).data.reason, "no_unfinished_tasks");
		}
		branch.push(pending); assert.equal((await h.emit("agent_before_settle", boundary)).continue, true, "a genuinely restarted plan still runs");
		console.log("✓ stopped/reset plan snapshots suppress stale todo follow-ups without blocking a restart");
	}

	{
		const h = harness(); let config = structuredClone(voice.DEFAULT_CONFIG); config.voicesCacheByGateway[config.gatewayUrl] = [];
		const store = { get: () => structuredClone(config), async update(fn) { config = fn(structuredClone(config)); return config; } };
		const gateway = { async getVoices() { throw Error("fixture HTTP 503"); }, async speak() { throw Error("fixture HTTP 503"); }, async recordAndTranscribe() { throw Error("fixture HTTP 503"); } };
		voice.default(h.pi, { config: store, gateway: () => gateway }); await h.emit("session_start");
		await h.commands.get("voice").handler("on", h.ctx);
		for (const [name, params] of [["voice_listen", { timeout_sec: 3 }], ["voice_speak", { text: "fixture" }]]) {
			const result = await h.tools.get(name).execute("failed", params, undefined, undefined, h.ctx);
			assert.equal(result.details.status, "error"); assert.equal(result.isError, true);
		}
		const catalogue = h.tools.get("voice_list_voices");
		const cached = await catalogue.execute("cached", { refresh: true }, undefined, undefined, h.ctx);
		assert.equal(cached.details.success, true); assert.ok(cached.details.warning); assert.notEqual(cached.isError, true);
		config.voicesCacheByGateway[config.gatewayUrl] = null;
		assert.equal((await catalogue.execute("failed", { refresh: true }, undefined, undefined, h.ctx)).isError, true);
		const abort = new AbortController(); abort.abort();
		const cancelled = await h.tools.get("voice_listen").execute("cancelled", {}, abort.signal, undefined, h.ctx);
		assert.equal(cancelled.details.status, "cancelled"); assert.notEqual(cancelled.isError, true);
		await h.emit("session_shutdown");
		console.log("✓ real voice failures are errors; usable cached refreshes and user cancellation remain distinct (VOICE-001 unchanged)");
	}

	{
		const tui = { terminal: { rows: 24 }, requestRender() {} }, manager = new timer.TimerManager({ appendEntry() {}, sendUserMessage() {} });
		try {
			manager.createTask(3600, "中文任务 ".repeat(40) + "TIMER-LAST");
			const components = [
				[new timer.TimerStatusModalComponent(tui, theme, manager, () => {}), "TIMER-LAST"],
				[new voice.VoiceStatusModalComponent(tui, theme, { enabled: true, live: false, activeTool: null, gatewayUrl: "https://fixture.invalid/" + "x".repeat(400), deliveryMode: "editor", defaultVoiceId: "VOICE-LAST", speed: 1, speakerSupported: true }, () => {}), "VOICE-LAST"],
				[new todo.TodoTreeStatusModalComponent(tui, theme, { enabled: false, isToolActive: false, shortcut: "ctrl+".repeat(60) + " TODO-LAST", stats: new todo.TodoTreeStore().getProgressStats() }, () => {}), "TODO-LAST"],
			];
			for (const [component, marker] of components) {
				for (const rows of [1, 2, 5, 24]) for (let width = 1; width <= 140; width++) {
					tui.terminal.rows = rows;
					const lines = component.render(width); assert.ok(lines.length <= rows);
					for (const line of lines) { assert.ok(visibleWidth(line) <= width); assert.ok(!/[\r\n]/.test(line)); }
				}
				tui.terminal.rows = 5; component.handleInput(keys.home);
				let seen = false;
				for (let page = 0; page < 200; page++) { // fixed cap, never an unbounded UI loop
					seen ||= component.render(40).some(line => line.includes(marker)); component.handleInput(keys.pageDown);
				}
				assert.ok(seen, `${marker} must remain reachable rather than being silently cut off`);
			}
			let closed = 0; const modal = new StatusModalComponent(tui, theme, "title", ["中 ".repeat(100)], () => { closed++; });
			modal.render(20); modal.handleInput(keys.down); assert.equal(closed, 0);
			modal.handleMouse({ type: "wheel", wheelDelta: 1 }); assert.equal(closed, 0);
			modal.handleInput(keys.escape); assert.equal(closed, 1);
			assert.deepEqual(modal.handleMouse({ type: "click" }), { handled: true }); assert.equal(closed, 2);
			assert.deepEqual(modal.render(0), []);
			const colored = new StatusModalComponent(tui, { fg: (_color, text) => `\x1b[34m${text}\x1b[39m` }, "中文标题", ["\x1b[32m中👨‍👩‍👧‍👦".repeat(20) + "\x1b[0m"], () => {});
			for (const width of [1, 4, 5, 10, 40, 80]) for (const line of colored.render(width)) assert.ok(visibleWidth(line) <= width);
		} finally { manager.dispose(); }
		console.log("✓ timer/voice/todo status modals fit 1–140 columns and short screens, retain full scrollable values and close correctly");
	}
	console.log("All ten extension edge-case fixes passed.");
} finally {
	globalThis.fetch = original.fetch; Date.now = original.now;
	for (const h of liveRuntimes) await h.shutdown().catch(() => {});
	globalThis.setInterval = original.setInterval; globalThis.clearInterval = original.clearInterval;
	process.chdir(original.cwd);
	for (const [key, value] of Object.entries(original.env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	rmSync(root, { recursive: true, force: true });
}
