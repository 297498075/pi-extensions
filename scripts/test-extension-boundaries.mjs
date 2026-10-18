import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

// No personal configuration/sessions, remote services, clipboard, GUI or audio devices.
const root = mkdtempSync(join(tmpdir(), "extension-boundaries-"));
const original = { cwd: process.cwd(), fetch: globalThis.fetch,
	env: Object.fromEntries(["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR"].map(key => [key, process.env[key]])) };
process.env.HOME = process.env.USERPROFILE = join(root, "home");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
for (const path of [process.env.HOME, process.env.PI_CODING_AGENT_DIR, join(root, ".pi")]) mkdirSync(path, { recursive: true });
process.chdir(root);
const { SessionManager, initTheme } = await import("@earendil-works/pi-coding-agent");
const { Input, Text, TuiMainScreen, CURSOR_MARKER, isFocusable, visibleWidth } = await import("@earendil-works/pi-tui");
const { isRetryableAssistantError } = await import("@earendil-works/pi-ai");
const { ExtensionRunner } = await import(new URL("./core/extensions/runner.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const { default: rollingTools } = await import("../extensions/rolling-tools.ts");
const timer = await import("../extensions/timer.ts");
const pager = await import("../extensions/image-pager.ts");
const { default: streamRetry } = await import("../extensions/stream-read-retry.ts");
const compression = await import("../extensions/request-compress.ts");
initTheme();
const theme = { fg: (_c, s) => s, bg: (_c, s) => s, style: s => s, bold: s => s };
const live = new Set();
function harness() {
	const handlers = new Map(), commands = new Map(), tools = new Map(), renderers = [];
	const sm = SessionManager.inMemory(root);
	let active = [], overlay, closed = 0;
	const tui = { terminal: { rows: 30 }, requestRender() {} };
	const ctx = { cwd: root, mode: "tui", hasUI: true, model: { id: "fixture" }, isIdle: () => true,
		hasPendingMessages: () => false, sessionManager: sm, ui: { notify() {}, setStatus() {}, setWidget() {}, setToolsExpanded() {},
			custom(factory) { return new Promise(done => { overlay = factory(tui, theme, {}, result => { closed++; done(result); }); }); } } };
	const h = { handlers, commands, tools, renderers, sm, tui, ctx, overlay: () => overlay, closed: () => closed,
		pi: { on(e, fn) { handlers.set(e, [...(handlers.get(e) || []), fn]); }, registerCommand(n, c) { commands.set(n, c); },
			registerTool(t) { tools.set(t.name, t); }, registerToolRenderer(r) { renderers.push(r); }, registerEntryRenderer() {}, registerShortcut() {},
			registerFlag() {}, getFlag: () => "20", getActiveTools: () => active, setActiveTools(next) { active = next; },
			appendEntry(type, data) { sm.appendCustomEntry(type, data); }, sendUserMessage() {} },
		async emit(e, event = {}) { let result; for (const fn of handlers.get(e) || []) result = await fn(event, ctx); return result; },
		async command(text) { return commands.get("rolling-tools").handler(text, ctx); },
		async shutdown() { await h.emit("session_shutdown"); live.delete(h); } };
	live.add(h); return h;
}
function runnerFor(h) {
	const runner = Object.create(ExtensionRunner.prototype);
	runner.extensions = [{ path: "boundary-fixture", handlers: h.handlers }];
	runner.createContext = () => h.ctx;
	runner.errors = [];
	runner.emitError = error => runner.errors.push(error);
	return runner;
}
async function rolling() {
	writeFileSync(join(root, ".pi", "rolling-tools.json"), JSON.stringify({ configVersion: 3 }));
	const h = harness(); rollingTools(h.pi); await h.emit("session_start"); return h;
}
async function start(h, id, name, args) {
	await h.emit("tool_execution_start", { toolCallId: id, toolName: name, args });
}
async function complete(h, id, name, text = "ok") {
	await h.emit("tool_execution_end", { toolCallId: id, toolName: name, isError: false, durationMs: 1,
		result: { content: [{ type: "text", text }], details: {} } });
}
const mouse = (type, x, y, extra = {}) => ({ type, button: "left", x, y, screenX: x, screenY: y,
	width: 100, height: 30, shift: false, alt: false, ctrl: false, ...extra });

try {
	// Natural units may abut other units/Chinese prompts, never prefixes of English words.
	for (const prompt of ["help me", "merge branches", "send a reminder", "HOURS_report", "minutehand check", "secondsRemaining check"]) {
		const result = timer.parseTimerArgs(`5 ${prompt}`);
		assert.equal(result.success, true); assert.equal(result.data.seconds, 5); assert.equal(result.data.prompt, prompt);
	}
	for (const [input, seconds, prompt] of [
		["5m check", 300, "check"], ["5 minutes check", 300, "check"], ["5 h check", 18000, "check"],
		["1h30m check", 5400, "check"], ["5分钟检查", 300, "检查"], ["5m检查", 300, "检查"],
		["1小时30分钟 检查", 5400, "检查"], ["5s send a reminder", 5, "send a reminder"],
	]) {
		const result = timer.parseTimerArgs(input);
		assert.equal(result.success, true); assert.equal(result.data.seconds, seconds); assert.equal(result.data.prompt, prompt);
	}
	{
		const h = harness(); timer.default(h.pi); await h.emit("session_start");
		for (const prompt of ["help me inspect", "merge branches", "30 2 items to inspect"]) {
			const result = await h.tools.get("timer_schedule").execute("timer", { timeExpression: "5", prompt }, undefined, undefined, h.ctx);
			assert.equal(result.details.delaySeconds, 5); assert.equal(result.details.prompt, prompt);
		}
		for (const prompt of ["help me inspect", "30 2 items to inspect"]) {
			const inputs = ["5", prompt]; let reads = 0;
			h.ctx.ui.input = async () => { assert.ok(reads < 2, "only two bounded input steps"); return inputs[reads++]; };
			await h.commands.get("timer").handler("", h.ctx);
			const result = await h.tools.get("timer_list").execute("list", {}, undefined, undefined, h.ctx);
			assert.equal(result.details.tasks.at(-1).delaySeconds, 5); assert.equal(result.details.tasks.at(-1).prompt, prompt);
		}
		await h.shutdown();
	}
	console.log("✓ timer unit boundaries and independently parsed tool/dialog time/prompt fields");

	// Permanent client failures stay non-retryable; numeric ports/counts aren't HTTP codes.
	{
		const h = harness(); streamRetry(h.pi); const handle = h.handlers.get("message_end")[0];
		const rejection = text => ({ role: "assistant", stopReason: "error", errorMessage: text, content: [] });
		for (const prefix of ["HTTP 413: Request Entity Too Large", "HTTP 422: Unprocessable Entity", "HTTP/1.1 415", "HTTP status code: 405",
			'\"status_code\":422', 'statusCode="413"', "413 Request Entity Too Large", "Error: 422 Unprocessable Entity", "HTTP 451"]) {
			const message = rejection(`${prefix}; stream disconnected before completion`);
			assert.equal(handle({ message }), undefined, prefix);
			assert.equal(isRetryableAssistantError(message), false, prefix);
		}
		for (const prefix of ["HTTP 408", "HTTP 409", "HTTP 425", "HTTP 429", "HTTP 503", "port 422", "received 413 bytes"]) {
			const result = handle({ message: rejection(`${prefix}; stream disconnected before completion`) });
			assert.ok(result?.message.errorMessage.startsWith("Network error:"), prefix);
			assert.equal(isRetryableAssistantError(result.message), true, prefix);
			assert.equal(handle({ message: result.message }), undefined, "don't stack prefixes");
		}
		await h.shutdown();
	}
	console.log("✓ permanent HTTP rejection filtering without suppressing genuine transport retries");

	// Malformed/incomplete metadata never blocks a native tool_call dispatch.
	{
		const h = await rolling(), runner = runnerFor(h);
		const paths = ["file://", "file:///C:/bad%ZZ.png", "file:///C:/%E4", "file:///C:/bad%2Fname.png"];
		for (const [i, path] of paths.entries()) {
			const args = { path }, originalArgs = structuredClone(args);
			const id = `bad-${i}`;
			await h.emit("message_update", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: args }] }, assistantMessageEvent: { type: "toolcall_delta" } });
			assert.equal(await runner.emitToolCall({ type: "tool_call", toolCallId: id, toolName: "read", input: args }), undefined);
			await start(h, id, "read", args); await complete(h, id, "read");
			assert.deepEqual(args, originalArgs);
		}
		await h.command("history");
		assert.equal(h.overlay().allItems.length, paths.length);
		assert.ok(h.overlay().allItems.every(item => item.status === "done" && item.fullPath === undefined));
		await h.shutdown();
	}
	{
		const h = harness(); pager.default(h.pi); await h.emit("session_start"); const runner = runnerFor(h);
		const messages = [
			{ role: "user", content: "old turn", timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", id: "good", name: "read", arguments: { path: "valid.png" } },
				{ type: "toolCall", id: "bad", name: "read", arguments: { path: "file:///C:/bad%ZZ.png" } }], timestamp: 2 },
			{ role: "toolResult", toolCallId: "good", toolName: "read", content: [{ type: "image", data: "A".repeat(1024), mimeType: "image/png" }], isError: false, timestamp: 3 },
			{ role: "toolResult", toolCallId: "bad", toolName: "read", details: { path: "file:///C:/%E4" }, content: [{ type: "image", data: "B".repeat(1024), mimeType: "image/png" }], isError: false, timestamp: 4 },
			{ role: "user", content: "new turn", timestamp: 5 },
		];
		const snapshot = structuredClone(messages), result = await runner.emitContext(messages);
		assert.equal(runner.errors.length, 0); assert.equal(result[2].content[0].type, "text"); assert.equal(result[3].content[0].type, "text");
		assert.match(result[2].content[0].text, /valid\.png/); assert.doesNotMatch(result[3].content[0].text, /bad%|%E4/);
		assert.deepEqual(messages, snapshot, "never mutate stored history");
		assert.throws(() => pager.normalizeDisplayPath("file:///C:/bad%ZZ.png", root), URIError, "public strict normalizer keeps its contract");
		await h.shutdown();
	}
	console.log("✓ malformed/partial file URLs are isolated per metadata field, not per tool/request");

	// Only leading known header rows are stripped; code, quoted text and later body rows survive.
	{
		const h = await rolling(), calls = [], clicks = [];
		const content = ["\x1b[33m⚡ SoL-Pi · Action Fusion\x1b[0m", " Money saved · 1 trip", 'const example = "Money saved · demo";',
			'const other = "SoL-Pi · demo";', "Money saved · legitimate body", "ordinary last line"];
		const inner = { render: () => content, invalidate() {}, handleInput: s => calls.push(s), wantsKeyRelease: true,
			handleMouse: e => { clicks.push(e); return { handled: true }; } };
		const wrapper = h.renderers[0]("fixture", () => ({ renderCall: () => inner })).renderCall({}, theme, {});
		assert.deepEqual(wrapper.render(120), content.slice(2));
		wrapper.handleMouse(mouse("click", 0, 0)); assert.equal(clicks.at(-1).y, 2);
		wrapper.handleInput("key"); assert.deepEqual(calls, ["key"]); assert.equal(wrapper.wantsKeyRelease, true);
		assert.equal(isFocusable(wrapper), false, "don't make plain components focusable");
		await h.command("off"); assert.deepEqual(wrapper.render(120), content);
		const event = mouse("click", 0, 0); wrapper.handleMouse(event); assert.equal(clicks.at(-1), event);
		await h.command("on"); assert.deepEqual(wrapper.render(120), content.slice(2));
		await h.shutdown(); assert.deepEqual(wrapper.render(120), content);
	}
	console.log("✓ header filtering preserves source/body text, ANSI headers, mouse mapping and off/unload");

	{
		const h = await rolling();
		const input = new Input(), replacement = new Input();
		const wrapper = h.renderers[0]("editable", () => ({ renderCall: () => input })).renderCall({}, theme, {});
		const ui = new TuiMainScreen({ rows: 30, columns: 100 }); // never start a terminal
		assert.equal(isFocusable(wrapper), true);
		ui.setFocus(wrapper); assert.equal(input.focused, true);
		assert.ok(wrapper.render(70).join("\n").includes(CURSOR_MARKER));
		ui.setFocus(replacement); assert.equal(input.focused, false);
		assert.ok(!wrapper.render(70).join("\n").includes(CURSOR_MARKER));
		await h.shutdown();
	}
	console.log("✓ wrapped native Input receives focus/blur and emits the IME cursor marker");

	{
		const h = await rolling();
		await start(h, "first", "bash", { command: "first" }); await complete(h, "first", "bash");
		await start(h, "live", "bash", { command: Array.from({ length: 80 }, (_v, i) => `line_${i}`).join("\n") });
		await h.command("history"); const overlay = h.overlay(); overlay.render(100);
		overlay.handleInput("\x1b[6~"); const offset = overlay.detailScrollTop; assert.ok(offset > 0);
		overlay.refresh(); overlay.render(100); assert.equal(overlay.detailScrollTop, offset);
		await new Promise(resolve => setTimeout(resolve, 120)); // exercise the actual 100ms widget refresh
		overlay.render(100); assert.equal(overlay.detailScrollTop, offset);
		await start(h, "new", "bash", { command: "new" });
		assert.equal(overlay.allItems[overlay.selectedIndex].id, "live", "manual scrolling suspends tail following");
		const x = overlay.boxLeft + overlay.boxWidth - 3, y = overlay.boxTop + 2;
		overlay.handleMouse(mouse("wheel", x, y, { wheelDelta: 1 }));
		const wheelOffset = overlay.detailScrollTop; overlay.refresh(); assert.equal(overlay.detailScrollTop, wheelOffset);
		await h.shutdown();
	}
	console.log("✓ keyboard/wheel detail scrolling survives timer refreshes and new tool arrivals");

	{
		const h = await rolling();
		for (let i = 0; i < 4; i++) { await start(h, `row-${i}`, "bash", { command: `row_${i}` }); await complete(h, `row-${i}`, "bash"); }
		await h.command("history"); const overlay = h.overlay(); overlay.render(100);
		overlay.actionSignal = AbortSignal.abort(); // even intentional left-list clicks must not spawn a clipboard process
		const before = overlay.selectedIndex, y = overlay.boxTop + 2, listX = overlay.boxLeft + 2;
		for (const x of [overlay.boxLeft, overlay.boxLeft + 1 + overlay.listColumnWidth, overlay.boxLeft + overlay.boxWidth - 3]) {
			overlay.handleMouse(mouse("click", x, y)); assert.equal(overlay.selectedIndex, before);
		}
		for (const button of ["middle", "right"]) {
			overlay.handleMouse(mouse("click", listX, y, { button })); assert.equal(overlay.selectedIndex, before);
		}
		overlay.handleMouse(mouse("click", listX, y)); assert.equal(overlay.selectedIndex, 0);
		overlay.handleMouse(mouse("click", listX, y + 3)); assert.equal(overlay.followTail, true);
		await start(h, "tail", "bash", { command: "tail" }); assert.equal(overlay.selectedIndex, 4);
		await h.shutdown();
	}
	console.log("✓ only primary clicks in the visible list select/copy; tail following can be restored");

	{
		const h = await rolling();
		await start(h, "narrow", "read", { path: join(root, "目录".repeat(35), "END_OF_PATH.png") }); await complete(h, "narrow", "read", "中👩‍💻e\u0301".repeat(20));
		await h.command("history"); const overlay = h.overlay();
		assert.deepEqual(overlay.render(0), []);
		for (const rows of [1, 2, 3, 5, 8, 16, 30]) for (const width of [1, 2, 3, 4, 5, 10, 20, 30, 40, 50, 80, 120, 140]) {
			h.tui.terminal.rows = rows;
			const lines = overlay.render(width);
			assert.ok(lines.length <= rows, `${width}x${rows}: height`);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}x${rows}: width ${visibleWidth(line)}`);
		}
		h.tui.terminal.rows = 30; overlay.render(30);
		assert.equal(overlay.listColumnWidth, 0, "narrow screens expose a full-width detail column");
		assert.match(overlay.detailCache.lines.map(stripVTControlCharacters).join(""), /END_OF_PATH\.png/);
		assert.ok(overlay.detailCache.lines.every(line => visibleWidth(line) <= overlay.detailCache.width));
		await start(h, "navigate", "bash", { command: "next" });
		overlay.render(30); overlay.handleInput("\x1b[A"); assert.equal(overlay.selectedIndex, 0, "compact mode still navigates history");
		overlay.render(100); assert.ok(overlay.listColumnWidth > 0, "wide screens retain the two-pane list");
		overlay.handleMouse(mouse("click", 0, 0)); assert.equal(h.closed(), 1);
		await h.shutdown();
	}
	console.log("✓ history detail metadata, frame and canvas fit 1–140 columns and 1–30 rows with compact navigation");

	// Fetch's nullable Web IDL options remain transparent even if compression is configured off.
	assert.equal(await (await original.fetch("data:text/plain,control", null)).text(), "control");
	for (const enabled of [false, true]) {
		let captured;
		globalThis.fetch = async (...args) => { captured = args; return new Response("ok"); };
		compression.updateLiveContext({ ...compression.DEFAULT_CONFIG, enabled }, { providerBaseUrls: new Map(), modelToProvider: new Map() });
		compression.setupFetchHook();
		for (const input of ["data:text/plain,control", new URL("data:text/plain,control"), new Request("https://fixture.invalid", { method: "POST", body: "body" })]) {
			assert.equal(await (await fetch(input, null)).text(), "ok");
			assert.equal(captured[0], input); assert.deepEqual(captured[1], {});
		}
		compression.teardownFetchHook();
	}
	globalThis.fetch = original.fetch;
	console.log("✓ fetch null options preserve string/URL/Request calls with compression both on and off");
} finally {
	compression.teardownFetchHook(); globalThis.fetch = original.fetch;
	for (const h of [...live]) await h.shutdown();
	process.chdir(original.cwd);
	for (const [key, value] of Object.entries(original.env)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
}
