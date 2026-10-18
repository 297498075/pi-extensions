import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import rollingTools from "../extensions/rolling-tools.ts";
import { clipboardCommand, openFileCommand, openLocalFile, runDesktopCommand } from "../extensions/lib/desktop-actions.ts";

const root = mkdtempSync(join(tmpdir(), "rolling-safety-"));
const originalAgent = process.env.PI_CODING_AGENT_DIR;
const originalSpawn = childProcess.spawn;
process.env.PI_CODING_AGENT_DIR = root;
initTheme();
const tick = () => new Promise(resolve => setImmediate(resolve));
const themes = [
	{ fg: (_c, s) => s, bold: s => s },
	{ fg: (_c, s) => `\x1b[34m${s}\x1b[39m`, bold: s => `\x1b[1m${s}\x1b[22m` },
];
const tui = { requestRender() {}, terminal: { rows: 40 } };
function fakeChild(inputError) {
	const child = new EventEmitter();
	child.stdin = new Writable({ write(_chunk, _encoding, done) { done(inputError); } });
	child.stderr = new EventEmitter();
	child.kills = 0;
	child.kill = () => { child.kills++; return true; };
	return child;
}
async function withSpawn(factory, test) {
	childProcess.spawn = factory; syncBuiltinESMExports();
	try { return await test(); }
	finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
}
function environment(theme) {
	const handlers = new Map(); let command, widget, overlay;
	const ctx = { cwd: root, mode: "tui", hasUI: true, sessionManager: { getBranch: () => [] }, ui: {
		notify() {}, setStatus() {}, setToolsExpanded() {},
		setWidget(_key, factory) { if (typeof factory === "function") widget = factory; },
		custom(factory) { overlay = factory(tui, theme, {}, () => {}); return Promise.resolve(); },
	} };
	rollingTools({ on(e, h) { handlers.set(e, [...(handlers.get(e) || []), h]); }, registerCommand(_name, c) { command = c; }, appendEntry() {} });
	return { ctx, widget: () => widget(tui, theme), overlay: () => overlay, command: args => command.handler(args, ctx),
		async emit(e, event = {}) { for (const h of handlers.get(e) || []) await h(event, ctx); } };
}
function bounded(component, widths) {
	for (const width of widths) {
		for (const line of component.render(width)) {
			assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} columns exceed ${width}: ${line}`);
			assert.ok(!line.includes("\n"), "one returned element must represent one physical line");
		}
	}
}
try {
	const literal = join(root, "notes&echo.PI_SAFE_MARKER%HOME%';.txt");
	writeFileSync(literal, "fixture");
	for (const platform of ["win32", "darwin", "linux"]) {
		const copy = clipboardCommand("literal & % text", platform);
		assert.equal(copy.input, "literal & % text");
		assert.ok(!copy.args.some(arg => arg.includes("literal")), "clipboard content is only stdin");
		const open = openFileCommand(literal, platform);
		assert.ok(!/(?:^|[\\/])cmd(?:\.exe)?$/i.test(open.command));
		if (platform === "win32") {
			const script = Buffer.from(open.args.at(-1), "base64").toString("utf16le");
			assert.equal(open.env.PI_EXTENSIONS_OPEN_PATH, literal);
			assert.ok(!script.includes(literal));
			assert.ok(script.includes("ProcessStartInfo") && script.includes("UseShellExecute"));
			assert.ok(!/Invoke-Expression|\biex\b|cmd\s*\/c|Start-Process\s+-FilePath\s+['"]/.test(script));
		} else assert.deepEqual(open.args, [literal]);
	}
	if (process.platform === "win32") {
		const command = openFileCommand(literal);
		if (existsSync(command.command)) {
			// Execute only the data-preparation part in real Windows PowerShell.
			// Replace the OS-launch statement with a literal round-trip assertion;
			// no GUI application, file association or user command is executed.
			const script = Buffer.from(command.args.at(-1), "base64").toString("utf16le");
			const probe = script.replace("[System.Diagnostics.Process]::Start($info) | Out-Null", "[Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($info.FileName)))");
			assert.notEqual(probe, script);
			const result = spawnSync(command.command, [...command.args.slice(0, -1), Buffer.from(probe, "utf16le").toString("base64")], { env: command.env, encoding: "utf8", timeout: 10_000, windowsHide: true });
			assert.equal(result.status, 0, result.stderr);
			assert.equal(Buffer.from(result.stdout.trim(), "base64").toString("utf8"), literal);
		}
	}
	assert.equal((await openLocalFile("/?&echo.NOT_EXECUTED")).ok, false);
	assert.equal((await openLocalFile(join(root, "absent.txt"))).ok, false);
	console.log("✓ path metacharacters remain literal data, no cmd path concatenation");

	assert.equal((await runDesktopCommand({ command: join(root, "missing-program"), args: [] })).ok, false);
	const nonzero = await runDesktopCommand({ command: process.execPath, args: ["-e", "process.stderr.write('helper unavailable');process.exit(7)"] });
	assert.equal(nonzero.ok, false); assert.match(nonzero.error, /helper unavailable/);
	const success = await runDesktopCommand({ command: process.execPath, args: ["-e", "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.exit(s==='literal & data'?0:1))"], input: "literal & data" });
	assert.equal(success.ok, true);
	await withSpawn(() => {
		const child = fakeChild(Object.assign(Error("simulated EPIPE"), { code: "EPIPE" })); return child;
	}, async () => {
		const result = await runDesktopCommand({ command: "fixture", args: [], input: "x" });
		assert.equal(result.ok, false); assert.match(result.error, /EPIPE/);
	});
	let child;
	await withSpawn(() => { child = fakeChild(); return child; }, async () => {
		const controller = new AbortController();
		const pending = runDesktopCommand({ command: "fixture", args: [] }, controller.signal);
		controller.abort(); assert.equal((await pending).ok, false); assert.equal(child.kills, 1);
		// Late child events must remain handled even after cancellation.
		child.emit("error", Error("late error")); child.stdin.emit("error", Error("late stdin error"));
		assert.equal(child.kills, 1);
	});
	await withSpawn(() => {
		child = fakeChild();
		child.kill = () => { child.kills++; child.emit("error", Object.assign(Error("cannot kill helper"), { code: "EPERM" })); return false; };
		return child;
	}, async () => {
		const controller = new AbortController();
		const pending = runDesktopCommand({ command: "fixture", args: [] }, controller.signal);
		controller.abort(); assert.equal((await pending).ok, false); assert.equal(child.kills, 1, "synchronous kill errors must not recurse");
	});
	const already = new AbortController(); already.abort();
	await withSpawn(() => { throw Error("must not spawn after preflight abort"); }, async () => {
		assert.equal((await runDesktopCommand({ command: "fixture", args: [] }, already.signal)).ok, false);
	});
	await withSpawn(() => { child = fakeChild(); return child; }, async () => {
		// A real child keeps the loop alive; this mock needs one referenced timer.
		const keepAlive = setTimeout(() => {}, 100);
		try {
			const result = await runDesktopCommand({ command: "fixture", args: [] }, undefined, 10);
			assert.equal(result.ok, false); assert.match(result.error, /超时/); assert.equal(child.kills, 1);
		} finally { clearTimeout(keepAlive); }
	});
	console.log("✓ missing executables, nonzero exit, stdin EPIPE, timeout, cancellation and late errors resolve safely");

	const widths = [1, 2, 3, 4, 5, 8, 10, 15, 20, 30, 40, 60, 80, 100, 140];
	for (const theme of themes) {
		const env = environment(theme);
		try {
			await env.emit("session_start", { reason: "startup" });
			await env.emit("before_provider_request"); bounded(env.widget(), widths);
			const longTool = "mcp__very_long_server_identifier_for_custom_workflow_tools__execute_workflow_and_wait_for_result";
			for (const [id, toolName, input] of [
				["read", "read", { path: "图片".repeat(25) + "👨‍👩‍👧‍👦.png" }],
				["image", "generate_image", { prompt: "中文提示词".repeat(20) }],
				["mcp", longTool, { query: "test" }],
			]) {
				await env.emit("tool_call", { toolCallId: id, toolName, input });
				bounded(env.widget(), widths);
			}
			await env.command("mode running"); bounded(env.widget(), widths);
			await env.emit("tool_result", { toolCallId: "read", toolName: "read", isError: true, content: [{ type: "text", text: "找不到文件".repeat(30) }] });
			bounded(env.widget(), widths);
			await env.command("mode fixed");
			const widget = env.widget();
			bounded(widget, widths);
			const visible = widget.render(80);
			widget.handleMouse({ type: "click", button: "left", x: 3, y: 1 });
			bounded(widget, widths); // expanded output/path rows also obey the same boundary
			assert.ok(visible[0].includes("➕"));
			const combined = visible.slice(1).map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimStart()).join("");
			assert.ok(combined.includes("very_long_server_identifier_for_custom_workflow_tools:execute_workflow_and_wait_for_result"), "fixed-mode wrapping must not drop long tool names");
		} finally { await env.emit("session_shutdown"); }
	}
	console.log("✓ fixed/running/error/waiting/expanded layouts fit 1–140 columns with CJK, emoji and ANSI");

	const env = environment(themes[0]);
	try {
		await env.emit("session_start", { reason: "startup" });
		await env.emit("tool_call", { toolCallId: "file", toolName: "read", input: { path: literal } });
		const widget = env.widget(); widget.render(140);
		let invocation;
		await withSpawn((command, args, options) => {
			invocation = { command, args, options }; const p = fakeChild(); queueMicrotask(() => p.emit("close", 0, null)); return p;
		}, async () => {
			widget.handleMouse({ type: "click", button: "left", ctrl: true, x: 4, y: 1 });
			await tick();
			assert.ok(invocation); assert.equal(invocation.options.shell, false);
			assert.ok(!/(?:^|[\\/])cmd(?:\.exe)?$/i.test(invocation.command));
			if (process.platform === "win32") assert.equal(invocation.options.env.PI_EXTENSIONS_OPEN_PATH, literal);
			else assert.deepEqual(invocation.args, [literal]);
		});
		await withSpawn(() => {
			const p = fakeChild(); queueMicrotask(() => p.emit("error", Object.assign(Error("clipboard helper missing"), { code: "ENOENT" }))); return p;
		}, async () => {
			widget.render(140);
			widget.handleMouse({ type: "click", button: "left", ctrl: true, x: 4, y: 1 });
			await tick();
			assert.ok(widget.render(80).some(line => line.includes("打开失败")), "failed open must be visible without crashing");
			widget.render(140);
			widget.handleMouse({ type: "click", button: "right", x: 4, y: 1 });
			await tick(); const lines = widget.render(80);
			assert.ok(lines.some(line => line.includes("复制失败")), "failed copy must never claim success");
			assert.ok(!lines.some(line => line.includes("已复制")));
			bounded(widget, widths);
			await env.command("history");
			const overlayLines = env.overlay().render(100);
			const top = overlayLines.findIndex(line => line.includes("┌"));
			const left = overlayLines[top].indexOf("┌");
			env.overlay().handleMouse({ type: "click", button: "left", x: left + 4, y: top + 2 });
			await tick();
			assert.ok(env.overlay().render(100).some(line => line.includes("复制失败")), "overlay must also report failure safely");
		});
		let shutdownChild;
		await withSpawn(() => { shutdownChild = fakeChild(); return shutdownChild; }, async () => {
			widget.render(140); widget.handleMouse({ type: "click", button: "right", x: 4, y: 1 });
			await env.emit("session_shutdown"); await tick();
			assert.equal(shutdownChild.kills, 1, "shutdown cancels an in-flight desktop helper");
		});
	} finally { await env.emit("session_shutdown"); }
	console.log("✓ real Ctrl-click route, truthful widget/overlay feedback and shutdown cleanup");
} finally {
	childProcess.spawn = originalSpawn; syncBuiltinESMExports();
	if (originalAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgent;
	rmSync(root, { recursive: true, force: true });
}
console.log("All rolling-tools safety regressions passed (no clipboard or GUI access).");
