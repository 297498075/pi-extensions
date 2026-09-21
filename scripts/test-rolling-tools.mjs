import assert from "node:assert/strict";
import { initTheme, InteractiveMode, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import rollingTools from "../extensions/rolling-tools.ts";

initTheme();

console.log("=== Test 1: Extension Initialization & Tool Silencing Hook ===");
const handlers = new Map();
let registeredCommand = null;

const fakePi = {
	on(event, handler) {
		const list = handlers.get(event) || [];
		list.push(handler);
		handlers.set(event, list);
	},
	registerCommand(name, cmd) {
		registeredCommand = { name, ...cmd };
	},
};

rollingTools(fakePi);

assert.ok(handlers.has("session_start"), "session_start handler registered");
assert.ok(handlers.has("agent_start"), "agent_start handler registered");
assert.ok(handlers.has("tool_call"), "tool_call handler registered");
assert.ok(handlers.has("tool_result"), "tool_result handler registered");
assert.ok(registeredCommand, "rolling-tools command registered");
console.log("✓ Event handlers and command registered successfully.");

console.log("\n=== Test 2: ToolExecutionComponent Silencing & Ctrl+O Expansion ===");
const testTools = [
	{ name: "read", shouldSilence: true },
	{ name: "bash", shouldSilence: true },
	{ name: "powershell", shouldSilence: true },
	{ name: "grep", shouldSilence: true },
	{ name: "find", shouldSilence: true },
	{ name: "ls", shouldSilence: true },
	{ name: "obs_recall", shouldSilence: true },
	{ name: "update_plan", shouldSilence: true },
	{ name: "mcp", shouldSilence: true },
	{ name: "mcp__playwright__navigate", shouldSilence: true },
	{ name: "mcp__rider-debugger__list_threads", shouldSilence: true },
	{ name: "rider_execute_tool", shouldSilence: true },
	{ name: "edit", shouldSilence: false }, // Must show diff in transcript!
	{ name: "write", shouldSilence: false }, // Must show diff in transcript!
];

for (const { name, shouldSilence } of testTools) {
	const comp = new ToolExecutionComponent(
		name,
		`call_${name}`,
		{ path: "test.txt", command: "ls" },
		{},
		undefined,
		{ requestRender() {} },
		process.cwd(),
	);

	const collapsedLines = comp.render(80).length;
	if (shouldSilence) {
		assert.equal(collapsedLines, 0, `Tool "${name}" should be silenced (0 lines) when collapsed`);
		comp.setExpanded(true);
		const expandedLines = comp.render(80).length;
		assert.ok(expandedLines > 0, `Tool "${name}" should render lines when expanded (Ctrl+O)`);
		comp.setExpanded(false);
		assert.equal(comp.render(80).length, 0, `Tool "${name}" should return to 0 lines when re-collapsed`);
	} else {
		assert.ok(collapsedLines > 0, `Tool "${name}" should NOT be silenced when collapsed`);
	}
	console.log(`  ✓ Tool "${name}": collapsed=${collapsedLines}, expectedSilence=${shouldSilence}`);
}

console.log("\n=== Test 3: SoL-Pi Notification Interception ===");
let widgetContent = null;
let notifiedMessage = null;

const fakeUi = {
	setWidget(key, content) {
		widgetContent = content;
	},
	notify(msg, type) {
		notifiedMessage = { msg, type };
	},
	setStatus(key, text) {},
	setToolsExpanded() {},
	requestRender() {},
};

const fakeCtx = {
	hasUI: true,
	ui: fakeUi,
	cwd: process.cwd(),
};

// Trigger agent_start to install UI hooks
const agentStartHandlers = handlers.get("agent_start") || [];
for (const h of agentStartHandlers) {
	await h({}, fakeCtx);
}

// Now test notify with SoL-Pi savings message
const solPiMsg = "⚡ SoL-Pi · Observation Pack\nMoney saved · 15.2k tokens ($0.04)";
notifiedMessage = null;
fakeUi.notify(solPiMsg, "info");

assert.equal(notifiedMessage, null, "SoL-Pi toast notification must be suppressed!");
console.log("  ✓ SoL-Pi toast notification suppressed successfully.");

// Test setStatus with key "sol-pi-savings"
let updatedStatusKey = null;
let updatedStatusText = null;
const im = Object.create(InteractiveMode.prototype);
im.footerDataProvider = {
	setExtensionStatus(key, text) {
		updatedStatusKey = key;
		updatedStatusText = text;
	},
};
im.ui = { requestRender() {} };

im.setExtensionStatus("sol-pi-savings", "⚡ Observation Pack · 4,756 context tokens avoided");
assert.equal(updatedStatusKey, "sol-pi-savings", "Must handle sol-pi-savings status key");
assert.ok(updatedStatusText.includes("\x1b[33m⚡"), "Must format with ANSI warning yellow");
assert.ok(updatedStatusText.includes("(0s ago)"), "Must include relative time ticker (0s ago)");
console.log("  ✓ SoL-Pi 'sol-pi-savings' status key intercepted, colorized with ANSI and (0s ago):");
console.log("    " + updatedStatusText);

console.log("\n=== Test 4: Tool Call & Result Tracking ===");
const toolCallHandlers = handlers.get("tool_call") || [];
const toolResultHandlers = handlers.get("tool_result") || [];

// Call obs_recall
for (const h of toolCallHandlers) {
	await h(
		{
			toolCallId: "call_obs_1",
			toolName: "obs_recall",
			input: { id: "019fd5a5-9a4e", offset: 120 },
		},
		fakeCtx,
	);
}

const dummyTheme = {
	fg: (col, str) => `[${col}]${str}`,
	bg: (col, str) => str,
	bold: (str) => `*${str}*`,
};
const dummyTui = { requestRender() {} };

let widgetLines = widgetContent(dummyTui, dummyTheme).render(100);
assert.ok(widgetLines.some((l) => l.includes("obs_recall") && l.includes("019fd5a5-9a4e @120")), "obs_recall must appear in widget");

// Result for obs_recall
for (const h of toolResultHandlers) {
	await h(
		{
			toolCallId: "call_obs_1",
			toolName: "obs_recall",
			isError: false,
			content: [{ type: "text", text: "Successfully recalled observation data" }],
		},
		fakeCtx,
	);
}

widgetLines = widgetContent(dummyTui, dummyTheme).render(100);
assert.ok(widgetLines.some((l) => l.includes("obs_recall") && l.includes("✓")), "obs_recall status must show done");
console.log("  ✓ obs_recall tracked and rolled into widget smoothly.");

// Call namespaced MCP tool: mcp__rider-debugger__list_threads
for (const h of toolCallHandlers) {
	await h(
		{
			toolCallId: "call_mcp_1",
			toolName: "mcp__rider-debugger__list_threads",
			input: { rootFolder: "C:/project" },
		},
		fakeCtx,
	);
}

widgetLines = widgetContent(dummyTui, dummyTheme).render(100);
assert.ok(widgetLines.some((l) => l.includes("rider-debugger:list_threads")), "mcp namespaced tool must be formatted nicely");
console.log("  ✓ mcp__rider-debugger__list_threads formatted as rider-debugger:list_threads.");

// Call powershell tool (native Windows tool in Pi 0.86+)
for (const h of toolCallHandlers) {
	await h(
		{
			toolCallId: "call_ps_1",
			toolName: "powershell",
			input: { command: "Get-Process\nSelect-Object -First 5" },
		},
		fakeCtx,
	);
}

widgetLines = widgetContent(dummyTui, dummyTheme).render(100);
assert.ok(widgetLines.some((l) => l.includes("powershell") && l.includes("Get-Process ↵")), "powershell multiline command must format nicely with ↵");
console.log("  ✓ powershell command tracked and formatted with ↵ indicator.");

console.log("\n=== Test 5: Command Handling (/rolling-tools) ===");
let lastCmdNotification = null;
fakeUi.notify = (msg) => {
	lastCmdNotification = msg;
};

await registeredCommand.handler("status", fakeCtx);
assert.ok(lastCmdNotification?.includes("rolling-tools 状态:"), "status command works");

await registeredCommand.handler("off", fakeCtx);
assert.ok(lastCmdNotification?.includes("已禁用"), "off command works");

await registeredCommand.handler("on", fakeCtx);
assert.ok(lastCmdNotification?.includes("已启用"), "on command works");

await registeredCommand.handler("reload", fakeCtx);
assert.ok(lastCmdNotification?.includes("配置已重载"), "reload command works");
console.log("  ✓ All commands (status, off, on, reload) work as expected.");

console.log("\nALL VERIFICATION TESTS PASSED SUCCESSFULLY! 🎉");
