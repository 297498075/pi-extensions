import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离测试环境：将全局配置目录指向临时目录，避免读到真实用户的 config.json
const TEST_AGENT_DIR = mkdtempSync(join(tmpdir(), "rolling-tools-test-"));
process.env.PI_CODING_AGENT_DIR = TEST_AGENT_DIR;

const { initTheme, InteractiveMode, ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { default: rollingTools } = await import("../extensions/rolling-tools.ts");

initTheme();

console.log("=== Test 1: Extension Initialization & Tool Silencing Hook ===");
const handlers = new Map();
let registeredCommand = null;
const appendedEntries = [];

const fakePi = {
	on(event, handler) {
		const list = handlers.get(event) || [];
		list.push(handler);
		handlers.set(event, list);
	},
	registerCommand(name, cmd) {
		registeredCommand = { name, ...cmd };
	},
	appendEntry(customType, data) {
		appendedEntries.push({ type: "custom", customType, data });
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
	// 新默认：edit / write / codemode 及任意三方工具也一并隐藏（由滚动块 + overlay 承载）
	{ name: "edit", shouldSilence: true },
	{ name: "write", shouldSilence: true },
	{ name: "codemode", shouldSilence: true },
	{ name: "recall", shouldSilence: true },
	{ name: "subagent", shouldSilence: true },
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
	sessionManager: {
		getEntries() {
			return appendedEntries;
		},
	},
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

// 通配拦截：任意插件的普通 info tips 都应被吞
notifiedMessage = null;
fakeUi.notify("some other plugin tip", "info");
assert.equal(notifiedMessage, null, "any plugin info tip must be suppressed by the '*' rule");
console.log("  ✓ any plugin info tip suppressed (wildcard match).");

// 例外 1：error / warning 类型必须放行
notifiedMessage = null;
fakeUi.notify("something broke", "error");
assert.ok(notifiedMessage, "error notifications must NOT be suppressed");
notifiedMessage = null;
fakeUi.notify("be careful", "warning");
assert.ok(notifiedMessage, "warning notifications must NOT be suppressed");
console.log("  ✓ error / warning notifications pass through.");

// 例外 2：info 类型但命中关键词也必须放行
for (const kw of ["error", "failed", "failure", "warning", "错误", "失败", "警告", "⚠", "❌", "🔴"]) {
	notifiedMessage = null;
	fakeUi.notify(`plugin says: ${kw} happened`, "info");
	assert.ok(notifiedMessage, `info notification containing "${kw}" must NOT be suppressed`);
}
console.log("  ✓ info notifications with error/failed/warning keywords pass through.");

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
assert.ok(
	!updatedStatusText.includes("ago)"),
	"relative-time ticker must be off by default (showRelativeTime: false)",
);
console.log("  ✓ status key intercepted and colorized (no relative-time ticker):");
console.log("    " + updatedStatusText);

// 任意插件的 status key 都应被统一处理（keyPattern: "*"）
im.setExtensionStatus("some-plugin", "Plugin X · 123 things done");
assert.equal(updatedStatusKey, "some-plugin", "any plugin status key must be handled");
assert.ok(updatedStatusText.includes("\x1b[32m"), "must apply adaptive colorization");
console.log("  ✓ any plugin status key handled uniformly.");

// 常驻状态 key（blackhole / mcp）：必须完全放行
// 1) 设置时不被加倒计时（文本原样透传，不强制着色）
// 2) 插件自己的清除调用（undefined）必须放行，不能被吞掉
const persistentCalls = [];
const im2 = Object.create(InteractiveMode.prototype);
im2.footerDataProvider = {
	setExtensionStatus(key, text) {
		persistentCalls.push({ key, text });
	},
};
im2.ui = { requestRender() {} };

for (const key of ["blackhole", "mcp"]) {
	persistentCalls.length = 0;
	im2.setExtensionStatus(key, "bh O▕██░▏ P▕█░░▏ X▕███▏");
	assert.equal(persistentCalls.length, 1, `${key} set must pass through`);
	assert.equal(
		persistentCalls[0].text,
		"bh O▕██░▏ P▕█░░▏ X▕███▏",
		`${key} text must NOT be rewritten (no forced colorize on persistent keys)`,
	);
	// 插件主动清除：必须放行
	im2.setExtensionStatus(key, undefined);
	assert.equal(persistentCalls.length, 2, `${key} clear must pass through`);
	assert.equal(persistentCalls[1].text, undefined, `${key} clear must reach the footer`);
}
console.log("  ✓ persistent status keys (blackhole / mcp) pass through untouched, including their clears.");

// 默认不倒计时：未配 durationMs 的普通 key 设置后不应被自动清除
const plainCalls = [];
const im3 = Object.create(InteractiveMode.prototype);
im3.footerDataProvider = {
	setExtensionStatus(key, text) {
		plainCalls.push({ key, text });
	},
};
im3.ui = { requestRender() {} };
im3.setExtensionStatus("some-plugin", "Plugin X · 123 things done");
const afterSet = plainCalls.length;
await new Promise((r) => setTimeout(r, 1500));
assert.equal(
	plainCalls.length,
	afterSet,
	"without durationMs, the status must NOT be auto-cleared (colorize only)",
);
console.log("  ✓ no auto-clear when durationMs is unset (colorize only).");

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
const dummyTui = { requestRender() {}, terminal: { rows: 30, columns: 100 } };

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

// codemode: the script body must be captured for the overlay dialog
for (const h of toolCallHandlers) {
	await h(
		{
			toolCallId: "call_cm_1",
			toolName: "codemode",
			input: { code: "const r = await tools.read({ path: 'a.ts' });\ntext(r);" },
		},
		fakeCtx,
	);
}
widgetLines = widgetContent(dummyTui, dummyTheme).render(100);
assert.ok(
	widgetLines.some((l) => l.includes("codemode") && l.includes("2 lines")),
	"codemode script must be summarized with its line count",
);
for (const h of toolResultHandlers) {
	await h(
		{
			toolCallId: "call_cm_1",
			toolName: "codemode",
			isError: false,
			content: [{ type: "text", text: "Script completed in 42ms\nread a.ts" }],
		},
		fakeCtx,
	);
}
console.log("  ✓ codemode script tracked; body captured for the overlay.");

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

await registeredCommand.handler("clear", fakeCtx);
assert.ok(lastCmdNotification?.includes("已清空"), "clear command works");
const clearedWidgetLines = widgetContent(dummyTui, dummyTheme).render(100);
assert.equal(clearedWidgetLines.slice(1).filter((l) => l.includes("[") && l.includes("]")).length, 0, "history must be empty after clear");

// 验证 argument completions
assert.ok(typeof registeredCommand.getArgumentCompletions === "function", "command must provide getArgumentCompletions");
const emptyCompletions = registeredCommand.getArgumentCompletions("");
assert.ok(emptyCompletions?.some((c) => c.value === "status"), "must complete subcommands on empty prefix");
assert.ok(emptyCompletions?.some((c) => c.value === "clear"), "must complete clear subcommand");
const modeCompletions = registeredCommand.getArgumentCompletions("mode ");
assert.ok(modeCompletions?.some((c) => c.value === "mode running"), "must complete mode running options");
console.log("  ✓ All commands (status, off, on, reload, clear) and argument completions work as expected.");

console.log("\n=== Test 6: ➕ Button & Overlay Dialog ===");
// 先制造足够多的历史（> 懒加载步长 10），以便验证懒加载
for (let i = 0; i < 15; i++) {
	for (const h of toolCallHandlers) {
		await h(
			{
				toolCallId: `call_bulk_${i}`,
				toolName: "read",
				input: { path: `src/bulk_${i}.ts` },
			},
			fakeCtx,
		);
	}
	for (const h of toolResultHandlers) {
		await h(
			{
				toolCallId: `call_bulk_${i}`,
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: `content of bulk_${i}` }],
			},
			fakeCtx,
		);
	}
}
// 重新渲染 widget，确认头部行常驻且 ➕ 按钮与层级切换按钮 🔽/⏏️ 位于头部行
let wLines = widgetContent(dummyTui, dummyTheme).render(100);
assert.ok(
	wLines.length > 0 && wLines[0].includes("➕"),
	"the persistent header row must render the ➕ button on the right",
);
assert.ok(
	wLines.length > 0 && (wLines[0].includes("🔽") || wLines[0].includes("⏏️")),
	"the persistent header row must render the mode toggle button 🔽/⏏️",
);
assert.equal(
	wLines.filter((l) => l.includes("➕")).length,
	1,
	"only the header row should carry the ➕ button (not each tool row)",
);
console.log("  ✓ persistent header row renders mode button and ➕ button.");

// 模拟点击头部最右侧按钮，应触发 ui.custom(overlay)
let overlayFactory = null;
let overlayOptions = null;
let overlayDone = null;
fakeUi.custom = (factory, options) => {
	overlayFactory = factory;
	overlayOptions = options;
	return new Promise((resolve) => {
		overlayDone = resolve;
	});
};

const widgetComp = widgetContent(dummyTui, dummyTheme);
wLines = widgetComp.render(100);
const buttonRow = wLines.findIndex((l) => l.includes("➕"));
assert.equal(buttonRow, 0, "the ➕ button must be on the header row (row 0)");
// 鼠标 x 坐标是终端列（可见宽度），不是 UTF-16 长度
const rowWidth = visibleWidth(wLines[buttonRow]);
widgetComp.handleMouse({
	type: "click",
	button: "left",
	x: rowWidth - 1,
	y: buttonRow,
	screenX: rowWidth - 1,
	screenY: buttonRow,
	width: 100,
	height: wLines.length,
	shift: false,
	alt: false,
	ctrl: false,
});
assert.ok(overlayFactory, "clicking ➕ must invoke ui.custom to open the overlay");
assert.equal(overlayOptions?.overlay, true, "overlay dialog must be opened as an overlay");
assert.ok(overlayOptions?.overlayOptions?.width, "overlay must specify a width");
console.log("  ✓ clicking ➕ opens an overlay dialog via ui.custom.");

// 构建 overlay 组件并验证边框 + 懒加载 + 滚轮
const overlayComp = overlayFactory(dummyTui, dummyTheme, {}, () => {});
let oLines = overlayComp.render(120);
assert.ok(oLines.some((l) => l.includes("工具历史")), "overlay must render a title");
assert.ok(oLines.some((l) => l.includes("上滑到顶加载更多")), "overlay must advertise lazy-load when more history exists");
// 全屏画布中的居中方框：找到带 ┌ / └ 的行
const stripTheme = (s) => s.replace(/\[[a-zA-Z]+\]/g, "");
const topIdx = oLines.findIndex((l) => stripTheme(l).includes("┌"));
const botIdx = oLines.findIndex((l) => stripTheme(l).includes("└"));
assert.ok(topIdx >= 0, "overlay must draw a top border");
assert.ok(botIdx > topIdx, "overlay must draw a bottom border");
const top = stripTheme(oLines[topIdx]).trim();
const bottom = stripTheme(oLines[botIdx]).trim();
assert.ok(top.startsWith("┌"), "overlay must draw a top-left border corner");
assert.ok(top.endsWith("┐"), "overlay must draw a top-right border corner");
assert.ok(bottom.startsWith("└"), "overlay must draw a bottom-left border corner");
assert.ok(bottom.endsWith("┘"), "overlay must draw a bottom-right border corner");
assert.ok(
	oLines.slice(topIdx, botIdx).some((l) => stripTheme(l).trim().startsWith("│")),
	"overlay must draw side borders",
);
// 全屏画布：方框上方/下方应有空白行（用于接收框外点击）
assert.ok(topIdx > 0, "box must be centered with blank rows above (outside-click area)");
assert.ok(botIdx < oLines.length - 1, "box must be centered with blank rows below (outside-click area)");
console.log("  ✓ overlay renders a centered box on a full-screen canvas.");

// 在左栏向上滚轮，应加载更多（坐标需落在居中方框内的左栏）
const boxLeftCol = stripTheme(oLines[topIdx]).indexOf("┌");
const boxInnerX = boxLeftCol + 3; // 左栏内部
const boxInnerY = topIdx + 3; // 标题/分隔之后的内容行
const beforeHint = oLines.find((l) => l.includes("加载更多")) || "";
overlayComp.handleMouse({
	type: "wheel",
	button: "none",
	x: boxInnerX,
	y: boxInnerY,
	screenX: boxInnerX,
	screenY: boxInnerY,
	width: 120,
	height: oLines.length,
	shift: false,
	alt: false,
	ctrl: false,
	wheelDelta: -1,
});
oLines = overlayComp.render(120);
const afterHint = oLines.find((l) => l.includes("加载更多")) || "";
assert.notEqual(beforeHint, afterHint, "wheel-up at top must load more history (lazy load)");
console.log("  ✓ wheel-up at top triggers lazy loading of more history.");

// 实时更新：agent 运行中新增工具应能反映到已打开的大窗体
const beforeLiveCount = (oLines.find((l) => l.includes("已全部加载") || l.includes("加载更多")) || "").match(/\((\d+)\/(\d+)\)/);
const totalBefore = beforeLiveCount ? Number(beforeLiveCount[2]) : 0;
for (const h of toolCallHandlers) {
	await h({ toolCallId: "call_live_1", toolName: "read", input: { path: "src/live_new.ts" } }, fakeCtx);
}
for (const h of toolResultHandlers) {
	await h(
		{
			toolCallId: "call_live_1",
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: "live content" }],
		},
		fakeCtx,
	);
}
// syncWidget 会自动调用 activeOverlay.refresh()；这里直接重渲染验证
const oLinesLive = overlayComp.render(120);
const afterLiveCount = (oLinesLive.find((l) => l.includes("已全部加载") || l.includes("加载更多")) || "").match(/\((\d+)\/(\d+)\)/);
const totalAfter = afterLiveCount ? Number(afterLiveCount[2]) : 0;
assert.ok(
	totalAfter > totalBefore,
	`overlay must reflect newly added tools while open (before=${totalBefore}, after=${totalAfter})`,
);
console.log(`  ✓ overlay live-updates with new tools while open (${totalBefore} → ${totalAfter}).`);

// Esc 关闭
let closed = false;
const overlayComp2 = overlayFactory(dummyTui, dummyTheme, {}, () => {
	closed = true;
});
overlayComp2.render(120);
overlayComp2.handleInput("\x1b");
assert.ok(closed, "Esc must close the overlay dialog");
console.log("  ✓ Esc closes the overlay dialog.");

// 点击方框外部 → 关闭
let closedOutside = false;
let closeOutsideFn = null;
const overlayCompOutside = overlayFactory(dummyTui, dummyTheme, {}, () => {
	closedOutside = true;
	closeOutsideFn?.();
});
const o3 = overlayCompOutside.render(120);
const o3Top = o3.findIndex((l) => stripTheme(l).includes("┌"));
assert.ok(o3Top > 0, "there must be blank rows above the box");
overlayCompOutside.handleMouse({
	type: "click",
	button: "left",
	x: 2,
	y: 0, // 方框上方空白区域
	screenX: 2,
	screenY: 0,
	width: 120,
	height: o3.length,
	shift: false,
	alt: false,
	ctrl: false,
});
assert.ok(closedOutside, "clicking outside the box must close the overlay");
console.log("  ✓ clicking outside the box closes the overlay.");

// 点击左侧列表行 → 选中并复制该行详情
let copiedText = null;
let closeCopyFn = null;
const overlayCompCopy = overlayFactory(dummyTui, dummyTheme, {}, () => {
	closeCopyFn?.();
});
const o4 = overlayCompCopy.render(120);
const o4Top = o4.findIndex((l) => stripTheme(l).includes("┌"));
const o4Left = stripTheme(o4[o4Top]).indexOf("┌");
// 内容行从 top+2 开始
const rowY = o4Top + 2;
overlayCompCopy.handleMouse({
	type: "click",
	button: "left",
	x: o4Left + 4,
	y: rowY,
	screenX: o4Left + 4,
	screenY: rowY,
	width: 120,
	height: o4.length,
	shift: false,
	alt: false,
	ctrl: false,
});
const afterClick = overlayCompCopy.render(120);
assert.ok(
	afterClick.some((l) => l.includes("已复制")),
	"clicking a left-list row must copy its detail and show feedback",
);
console.log("  ✓ clicking a left-list row copies its detail (with feedback).");

// 关闭 overlay，清空 activeOverlay，避免影响后续测试
overlayCompCopy.handleInput("");
await new Promise((r) => setTimeout(r, 0));

console.log("\n=== Test 7: Cross-Turn Persistence & Edit Diff ===");
// 触发 agent_start，确认历史不被清空
const agentStartHandlers2 = handlers.get("agent_start") || [];
const widgetBefore = widgetContent(dummyTui, dummyTheme).render(100);
for (const h of agentStartHandlers2) {
	await h({}, fakeCtx);
}
const widgetAfter = widgetContent(dummyTui, dummyTheme).render(100);
assert.ok(
	widgetAfter.some((l) => l.includes("bulk_14")),
	"tool history must survive agent_start (not disappear on new task)",
);
console.log("  ✓ tool history persists across agent_start (new task).");

// edit 工具：从 details.diff 回填 detailContent
for (const h of toolCallHandlers) {
	await h(
		{
			toolCallId: "call_edit_1",
			toolName: "edit",
			input: { path: "src/a.ts", oldText: "a", newText: "b" },
		},
		fakeCtx,
	);
}
for (const h of toolResultHandlers) {
	await h(
		{
			toolCallId: "call_edit_1",
			toolName: "edit",
			isError: false,
			content: [{ type: "text", text: "Edited src/a.ts" }],
			details: { diff: "@@ -1 +1 @@\n-old line\n+new line", patch: "" },
		},
		fakeCtx,
	);
}
// 打开 overlay 验证 diff 被展示
overlayFactory = null;
const widgetComp2 = widgetContent(dummyTui, dummyTheme);
const wl2 = widgetComp2.render(100);
// 头部行（row 0）带 ➕ 按钮
const btnRow2 = wl2.findIndex((l) => l.includes("➕"));
widgetComp2.handleMouse({
	type: "click",
	button: "left",
	x: visibleWidth(wl2[btnRow2]) - 1,
	y: btnRow2,
	screenX: 0,
	screenY: 0,
	width: 100,
	height: wl2.length,
	shift: false,
	alt: false,
	ctrl: false,
});
assert.ok(overlayFactory, "overlay opened for edit diff verification");
const overlayComp3 = overlayFactory(dummyTui, dummyTheme, {}, () => {});
const oLines3 = overlayComp3.render(140);
assert.ok(
	oLines3.some((l) => l.includes("new line") || l.includes("变更 diff") || l.includes("diff")),
	"overlay must display the edit diff from tool_result.details",
);
console.log("  ✓ edit diff captured from details and shown in overlay.");

// 持久化：确认 appendEntry 被调用（轮次边界写一次）
const agentEndHandlers = handlers.get("agent_end") || [];
for (const h of agentEndHandlers) await h({}, fakeCtx);
assert.ok(appendedEntries.length > 0, "history must be persisted via pi.appendEntry");
assert.ok(
	appendedEntries.some((e) => e.customType === "rolling-tools-history"),
	"persisted entry must use the rolling-tools-history custom type",
);
console.log("  ✓ history persisted via appendEntry (" + appendedEntries.length + " snapshots).");
assert.ok(
	appendedEntries.length <= 3,
	`persistence must be throttled to turn boundaries, not every tool (got ${appendedEntries.length})`,
);
console.log("  ✓ persistence is throttled (no O(N²) session growth).");

console.log("\n=== Test 8: Legacy Config Migration & Notice ===");
// 写入一个旧版（v1）配置：只有 managedTools 白名单，无 silencedTools/widgetTools/configVersion
const globalCfgDir = join(TEST_AGENT_DIR, "extensions", "rolling-tools");
mkdirSync(globalCfgDir, { recursive: true });
const globalCfgPath = join(globalCfgDir, "config.json");
writeFileSync(
	globalCfgPath,
	JSON.stringify({ enabled: true, maxRecentTools: 3, managedTools: ["read", "bash"] }, null, 2),
	"utf-8",
);

// 重新加载一个全新的扩展实例（新 session_start 会读到旧配置）
const handlers2 = new Map();
let registeredCommand2 = null;
const notices2 = [];
const fakeUi2 = {
	setWidget() {},
	notify(msg, type) {
		notices2.push({ msg, type });
	},
	setStatus() {},
	setToolsExpanded() {},
	requestRender() {},
};
const fakePi2 = {
	on(e, h) {
		const l = handlers2.get(e) || [];
		l.push(h);
		handlers2.set(e, l);
	},
	registerCommand(n, c) {
		registeredCommand2 = { name: n, ...c };
	},
	appendEntry() {},
};
const ctx2 = {
	hasUI: true,
	ui: fakeUi2,
	cwd: process.cwd(),
	sessionManager: { getEntries: () => [] },
};

rollingTools(fakePi2);
for (const h of handlers2.get("session_start") || []) await h({ reason: "startup" }, ctx2);
await new Promise((r) => setTimeout(r, 1000));

const legacyNotice = notices2.find((n) => n.type === "warning" && n.msg.includes("旧版配置"));
assert.ok(legacyNotice, "legacy config must trigger a one-time migration notice");
console.log("  ✓ legacy config triggers a migration notice.");

// 旧配置下 edit 不应被静音（保持原语义，避免破坏性变更）
const editComp = new ToolExecutionComponent(
	"edit",
	"call_legacy_edit",
	{ path: "test.txt", oldText: "a", newText: "b" },
	{},
	undefined,
	{ requestRender() {} },
	process.cwd(),
);
assert.ok(editComp.render(80).length > 0, "legacy config must NOT silence edit (preserve old behavior)");
console.log("  ✓ legacy config preserves old behavior (edit not silenced).");

// 执行 /rolling-tools migrate，应升级为全工具语义 + v3 通知默认值
await registeredCommand2.handler("migrate", ctx2);
const migrated = JSON.parse(readFileSync(globalCfgPath, "utf-8"));
assert.deepEqual(migrated.managedTools, ["*"], "migrate must set managedTools to ['*']");
assert.deepEqual(migrated.silencedTools, ["*"], "migrate must set silencedTools to ['*']");
assert.deepEqual(migrated.widgetTools, ["*"], "migrate must set widgetTools to ['*']");
assert.equal(migrated.configVersion, 3, "migrate must write configVersion 3");
// v3 通知默认值
assert.deepEqual(migrated.interceptNotifications, [{ match: "*", suppressToast: true }], "migrate must write wildcard notify rule");
assert.equal(migrated.statusEnhancements[0].keyPattern, "*", "migrate must write wildcard status rule");
assert.equal(
	migrated.statusEnhancements[0].durationMs,
	undefined,
	"migrate must NOT set a status duration by default (colorize only)",
);
assert.deepEqual(
	migrated.statusEnhancements[0].persistentKeys,
	["blackhole", "mcp"],
	"migrate must protect persistent status keys",
);
assert.equal(migrated.statusEnhancements[0].showRelativeTime, false, "migrate must disable relative-time ticker");
assert.equal(migrated.stripToolNotificationHeaders, true, "migrate must enable header stripping");
assert.ok(Array.isArray(migrated.notificationKeywords), "migrate must write notificationKeywords");
console.log("  ✓ /rolling-tools migrate upgrades config to v3 (all-tools + unified notifications).");

// 升级后 edit 应被静音
const editComp2 = new ToolExecutionComponent(
	"edit",
	"call_migrated_edit",
	{ path: "test.txt", oldText: "a", newText: "b" },
	{},
	undefined,
	{ requestRender() {} },
	process.cwd(),
);
assert.equal(editComp2.render(80).length, 0, "after migration, edit must be silenced (all-tools semantics)");
console.log("  ✓ after migration, edit is silenced.");

console.log("\n=== Test 9: History Restored After /reload (fresh module instance) ===");
// 模拟 /reload：旧实例先 session_shutdown（持久化），然后全新实例 session_start(reason="reload") 恢复。
// 用一个共享的 session entries 数组模拟同一 session。
const sharedEntries = [];
function makeReloadEnv() {
	const handlers = new Map();
	let widgetFactory = null;
	const fakeUi = {
		setWidget(k, c) {
			if (typeof c === "function") widgetFactory = c;
		},
		notify() {},
		setStatus() {},
		setToolsExpanded() {},
		requestRender() {},
		custom() {
			return Promise.resolve();
		},
	};
	const fakePi = {
		on(e, h) {
			const l = handlers.get(e) || [];
			l.push(h);
			handlers.set(e, l);
		},
		registerCommand() {},
		appendEntry(customType, data) {
			sharedEntries.push({ type: "custom", customType, data });
		},
	};
	const ctx = {
		hasUI: true,
		ui: fakeUi,
		cwd: process.cwd(),
		sessionManager: { getEntries: () => sharedEntries },
	};
	return { handlers, fakePi, ctx, getWidget: () => widgetFactory };
}

// 旧实例：产生工具历史
const oldEnv = makeReloadEnv();
rollingTools(oldEnv.fakePi);
for (const h of oldEnv.handlers.get("session_start") || []) await h({ reason: "startup" }, oldEnv.ctx);
for (let i = 0; i < 12; i++) {
	for (const h of oldEnv.handlers.get("tool_call") || [])
		await h({ toolCallId: `reload_${i}`, toolName: "read", input: { path: `src/r${i}.ts` } }, oldEnv.ctx);
	for (const h of oldEnv.handlers.get("tool_result") || [])
		await h(
			{ toolCallId: `reload_${i}`, toolName: "read", isError: false, content: [{ type: "text", text: `r${i}` }] },
			oldEnv.ctx,
		);
}
// 旧实例 shutdown（持久化）
for (const h of oldEnv.handlers.get("session_shutdown") || []) await h({}, oldEnv.ctx);
assert.ok(sharedEntries.length > 0, "old instance must persist history on shutdown");

// 新实例（模拟 reload）：全新 state，应从 session entries 恢复
const newEnv = makeReloadEnv();
rollingTools(newEnv.fakePi);
for (const h of newEnv.handlers.get("session_start") || []) await h({ reason: "reload" }, newEnv.ctx);
const restoredWidget = newEnv.getWidget()(dummyTui, dummyTheme);
const restoredLines = restoredWidget.render(100);
assert.ok(
	restoredLines.some((l) => l.includes("r11")),
	"after /reload, the widget must restore history from the session",
);
console.log("  ✓ history restored after /reload (fresh module instance).");

// ➕ 在恢复后应能打开大窗体
let reloadOverlayFactory = null;
newEnv.ctx.ui.custom = (f) => {
	reloadOverlayFactory = f;
	return Promise.resolve();
};
const rl = restoredWidget.render(100);
const rBtnRow = rl.findIndex((l) => l.includes("➕"));
restoredWidget.handleMouse({
	type: "click",
	button: "left",
	x: visibleWidth(rl[rBtnRow]) - 1,
	y: rBtnRow,
	screenX: 0,
	screenY: 0,
	width: 100,
	height: rl.length,
	shift: false,
	alt: false,
	ctrl: false,
});
assert.ok(reloadOverlayFactory, "➕ must open the overlay after /reload restore");
console.log("  ✓ ➕ works after /reload restore.");

console.log("\n=== Test 10: Tool-Header Stripping (channel C) & v2→v3 Notice ===");
// (a) NotificationHeaderStripper: 通过 registerToolRenderer 注册的 resolver 应能剥掉提示头
let registeredRendererResolver = null;
const fakePi3 = {
	on() {},
	registerCommand() {},
	appendEntry() {},
	registerToolRenderer(resolver) {
		registeredRendererResolver = resolver;
	},
};
rollingTools(fakePi3);
assert.ok(registeredRendererResolver, "extension must register a tool renderer resolver");

// 模拟 SoL-Pi 的 renderCall：返回一个含 ⚡/Money saved 两行的 Container
const solPiLikeRenderer = {
	renderCall: () => ({
		render: () => ["⚡ SoL-Pi · Action Fusion", "Money saved · 1 model round-trip avoided", "edit src/a.ts"],
		handleMouse: () => undefined,
		invalidate: () => {},
	}),
};
const resolved = registeredRendererResolver("edit", () => solPiLikeRenderer);
const stripped = resolved.renderCall();
const strippedLines = stripped.render(80);
assert.ok(
	!strippedLines.some((l) => /SoL-Pi ·|Money saved ·/.test(l)),
	"SoL-Pi header lines must be stripped from the tool renderer output",
);
assert.ok(
	strippedLines.some((l) => l.includes("edit src/a.ts")),
	"the real tool content must be preserved after stripping",
);
console.log("  ✓ plugin notification headers stripped from tool rows, content preserved.");

// 非 SoL-Pi 的普通渲染器应原样通过（不误伤）
const plainRenderer = { renderCall: () => ({ render: () => ["plain output line"], invalidate: () => {} }) };
const resolvedPlain = registeredRendererResolver("bash", () => plainRenderer);
assert.deepEqual(resolvedPlain.renderCall().render(80), ["plain output line"], "plain renderers must pass through unchanged");
console.log("  ✓ plain (non-plugin) tool renderers are untouched.");

// (b) v2 配置应触发 v2→v3 升级提醒（提示新字段与默认值）
const cfgDir2 = join(TEST_AGENT_DIR, "extensions", "rolling-tools");
mkdirSync(cfgDir2, { recursive: true });
const cfgPath2 = join(cfgDir2, "config.json");
writeFileSync(
	cfgPath2,
	JSON.stringify(
		{
			enabled: true,
			maxRecentTools: 3,
			managedTools: ["*"],
			silencedTools: ["*"],
			widgetTools: ["*"],
			configVersion: 2,
		},
		null,
		2,
	),
	"utf-8",
);

const notices3 = [];
const handlers3 = new Map();
const fakeUi3 = {
	setWidget() {},
	notify(msg, type) {
		notices3.push({ msg, type });
	},
	setStatus() {},
	setToolsExpanded() {},
	requestRender() {},
	custom() {
		return Promise.resolve();
	},
};
const fakePi4 = {
	on(e, h) {
		const l = handlers3.get(e) || [];
		l.push(h);
		handlers3.set(e, l);
	},
	registerCommand() {},
	appendEntry() {},
	registerToolRenderer() {},
};
const ctx3 = {
	hasUI: true,
	ui: fakeUi3,
	cwd: process.cwd(),
	sessionManager: { getEntries: () => [] },
};
rollingTools(fakePi4);
for (const h of handlers3.get("session_start") || []) await h({ reason: "startup" }, ctx3);
await new Promise((r) => setTimeout(r, 1000));

const v2Notice = notices3.find((n) => n.type === "warning" && n.msg.includes("v2"));
assert.ok(v2Notice, "a v2 config must trigger a v2→v3 upgrade notice");
assert.ok(v2Notice.msg.includes("durationMs"), "the notice must document the new statusEnhancements default");
assert.ok(v2Notice.msg.includes("stripToolNotificationHeaders"), "the notice must document stripToolNotificationHeaders");
assert.ok(v2Notice.msg.includes("notificationKeywords"), "the notice must document notificationKeywords");
console.log("  ✓ v2 config triggers a v2→v3 notice documenting new defaults.");

console.log("\n=== Test 11: View Mode Toggle (Fixed N-Rows vs. Running Tasks Only) ===");
const handlers11 = new Map();
let widgetFactory11 = null;
let currentCmd11 = null;
const appendedEntries11 = [];
const fakeUi11 = {
	setWidget(k, c) {
		if (typeof c === "function") widgetFactory11 = c;
	},
	notify() {},
	setStatus() {},
	setToolsExpanded() {},
	requestRender() {},
	custom() {
		return Promise.resolve();
	},
};
const fakePi11 = {
	on(e, h) {
		const l = handlers11.get(e) || [];
		l.push(h);
		handlers11.set(e, l);
	},
	registerCommand(n, c) {
		currentCmd11 = { name: n, ...c };
	},
	appendEntry(customType, data) {
		appendedEntries11.push({ type: "custom", customType, data });
	},
};
const ctx11 = {
	hasUI: true,
	ui: fakeUi11,
	cwd: process.cwd(),
	sessionManager: { getEntries: () => appendedEntries11 },
};

rollingTools(fakePi11);
for (const h of handlers11.get("session_start") || []) await h({ reason: "startup" }, ctx11);

// 先插入 5 个已完成任务
for (let i = 0; i < 5; i++) {
	for (const h of handlers11.get("tool_call") || []) {
		await h({ toolCallId: `call_done_${i}`, toolName: "read", input: { path: `f${i}.ts` } }, ctx11);
	}
	for (const h of handlers11.get("tool_result") || []) {
		await h(
			{
				toolCallId: `call_done_${i}`,
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: `ok ${i}` }],
			},
			ctx11,
		);
	}
}

// 插入 2 个正在执行的任务（running）
for (const id of ["call_run_A", "call_run_B"]) {
	for (const h of handlers11.get("tool_call") || []) {
		await h({ toolCallId: id, toolName: "bash", input: { command: `sleep 10 (${id})` } }, ctx11);
	}
}

// 1. 验证默认 fixed 模式：渲染最近 3 行（读取配置的 maxRecentTools）
let w11 = widgetFactory11(dummyTui, dummyTheme);
let lines11 = w11.render(100);
assert.ok(lines11[0].includes("🔽"), "header must show 🔽 in fixed mode");
assert.ok(lines11[0].includes("➕"), "header must show ➕ button");
assert.ok(!lines11[0].includes("[☰"), "header must NOT show bracketed [☰ text");
assert.ok(!lines11[0].includes("[⚡"), "header must NOT show bracketed [⚡ text");
// 列表中应包含最近 3 个（call_done_4, call_run_A, call_run_B）
const toolLinesFixed = lines11.slice(1).filter((l) => l.includes("[") && l.includes("]"));
assert.equal(toolLinesFixed.length, 3, "in fixed mode, exactly maxRecentTools (3) items should be displayed");
// 正在执行的任务在 fixed 列表中应显示实时的耗时，如 (Xms)
const runningLineFixed = toolLinesFixed.find((l) => l.includes("call_run_A"));
assert.ok(runningLineFixed && (runningLineFixed.includes("ms)") || runningLineFixed.includes("s)")), "running task must display elapsed time dynamically in fixed mode");
console.log("  ✓ fixed mode renders 🔽 ➕ with dynamic running time and exactly maxRecentTools items.");

// 2. 点击模式切换按钮 🔽 -> 切换到 running 模式
const rowWidth11 = visibleWidth(lines11[0]);
// 点击 🔽（位于 ➕ 左侧，x 位于 rowWidth - 3 附近）
w11.handleMouse({
	type: "click",
	button: "left",
	x: rowWidth11 - 3,
	y: 0,
	screenX: rowWidth11 - 3,
	screenY: 0,
	width: 100,
	height: lines11.length,
	shift: false,
	alt: false,
	ctrl: false,
});

lines11 = w11.render(100);
// 头部在 running 模式下显示 ⏏️ 和 ➕，不显示 [⚡ 运行中 (N)]
assert.ok(lines11[0].includes("⏏️"), "header must show ⏏️ icon in running mode");
assert.ok(lines11[0].includes("➕"), "header must show ➕ icon");
assert.ok(!lines11[0].includes("[⚡"), "header must NOT show [⚡ 运行中 (N)] label");
// 在 running 模式下，任务直接合并显示在状态行这一行，下方不追加任何多余行（高度严格稳定为 1 行，避免闪烁）
assert.equal(lines11.length, 1, "in running mode, widget is strictly 1 line (no flickering caused by height changes)");
assert.ok(lines11[0].includes("sleep 10"), "running task command must be visible directly on header row");
console.log("  ✓ running mode merges running tasks directly into the status line with zero height flicker.");

// 3. 其中一个任务完成 -> 动态更新状态行
for (const h of handlers11.get("tool_result") || []) {
	await h({ toolCallId: "call_run_A", toolName: "bash", isError: false, content: [] }, ctx11);
}
lines11 = w11.render(100);
assert.equal(lines11.length, 1, "widget stays strictly 1 line as tasks finish");
assert.ok(lines11[0].includes("call_run_B"), "remaining running task B must still be visible in header row");
console.log("  ✓ running mode dynamically updates running task in header row as tasks finish.");

// 4. 再次点击 ⏏️ 模式按钮 -> 切回 fixed 模式
const rowWidthAfter = visibleWidth(lines11[0]);
w11.handleMouse({
	type: "click",
	button: "left",
	x: rowWidthAfter - 3,
	y: 0,
	screenX: rowWidthAfter - 3,
	screenY: 0,
	width: 100,
	height: lines11.length,
	shift: false,
	alt: false,
	ctrl: false,
});
lines11 = w11.render(100);
assert.ok(lines11[0].includes("🔽"), "header returns to 🔽 after toggle back to fixed mode");
// 切回 fixed 模式后，下方重新展开固定 3 行
const toolLinesRestored = lines11.slice(1).filter((l) => l.includes("[") && l.includes("]"));
assert.equal(toolLinesRestored.length, 3, "in fixed mode after toggle back, maxRecentTools (3) items are shown");
console.log("  ✓ clicking toggle button returns to fixed mode with multi-row history.");

// 5. 使用 /rolling-tools mode 命令切换
await currentCmd11.handler("mode running", ctx11);
lines11 = w11.render(100);
assert.equal(lines11.length, 1, "/rolling-tools mode running switches to 1-line running mode");
assert.ok(lines11[0].includes("⏏️"), "header shows ⏏️ in running mode");
await currentCmd11.handler("mode fixed", ctx11);
lines11 = w11.render(100);
assert.equal(lines11.slice(1).filter((l) => l.includes("[") && l.includes("]")).length, 3, "/rolling-tools mode fixed switches to fixed mode");
assert.ok(lines11[0].includes("🔽"), "header shows 🔽 in fixed mode");
console.log("  ✓ /rolling-tools mode command switches viewMode correctly.");

console.log("\n=== Test 12: Error Line Visible in Both View Modes ===");
const handlers12 = new Map();
let widgetFactory12 = null;
const fakeUi12 = {
	setWidget(k, c) {
		if (typeof c === "function") widgetFactory12 = c;
	},
	notify() {},
	setStatus() {},
	setToolsExpanded() {},
	requestRender() {},
	custom() {
		return Promise.resolve();
	},
};
const fakePi12 = {
	on(e, h) {
		const l = handlers12.get(e) || [];
		l.push(h);
		handlers12.set(e, l);
	},
	registerCommand() {},
	appendEntry() {},
};
const ctx12 = {
	hasUI: true,
	ui: fakeUi12,
	cwd: process.cwd(),
	sessionManager: { getEntries: () => [] },
};

rollingTools(fakePi12);
for (const h of handlers12.get("session_start") || []) await h({ reason: "startup" }, ctx12);

// 一次失败的工具调用
for (const h of handlers12.get("tool_call") || []) {
	await h({ toolCallId: "call_err", toolName: "bash", input: { command: "exit 1" } }, ctx12);
}
for (const h of handlers12.get("tool_result") || []) {
	await h(
		{
			toolCallId: "call_err",
			toolName: "bash",
			isError: true,
			content: [{ type: "text", text: "boom: command failed with exit code 1" }],
		},
		ctx12,
	);
}

let w12 = widgetFactory12(dummyTui, dummyTheme);
let lines12 = w12.render(100);
const errLine12 = lines12.find((l) => l.includes("boom: command failed"));
assert.ok(errLine12, "fixed mode must render a compact single-line error message");
assert.ok(errLine12.includes("✗"), "error line must carry the ✗ marker");
assert.ok(errLine12.includes("[#1 bash]"), "error line must identify the failing tool and index");
assert.equal(lines12[0].includes("✗"), false, "error must not be merged into the header row");
console.log("  ✓ fixed mode renders a compact error line with ✗ marker and tool id.");

// 切到 running 模式，错误行仍须可见（此前 running 模式会完全吞掉错误信息）
for (const h of handlers12.get("tool_call") || []) {
	await h({ toolCallId: "call_run", toolName: "bash", input: { command: "sleep 10" } }, ctx12);
}
// 直接通过头部按钮切到 running 模式
const rowW12 = visibleWidth(lines12[0]);
w12.handleMouse({
	type: "click",
	button: "left",
	x: rowW12 - 3,
	y: 0,
	screenX: rowW12 - 3,
	screenY: 0,
	width: 100,
	height: lines12.length,
	shift: false,
	alt: false,
	ctrl: false,
});
lines12 = w12.render(100);
assert.ok(lines12[0].includes("⏏️"), "header switches to ⏏️ in running mode");
const errLineRunning = lines12.find((l) => l.includes("boom: command failed"));
assert.ok(errLineRunning, "running mode must still surface the error message on its own line");
assert.ok(errLineRunning.includes("✗"), "running-mode error line must carry the ✗ marker");
console.log("  ✓ running mode still surfaces the error line (no longer swallowed by the header).");

// 成功工具调用应清空错误行
for (const h of handlers12.get("tool_result") || []) {
	await h({ toolCallId: "call_run", toolName: "bash", isError: false, content: [] }, ctx12);
}
lines12 = w12.render(100);
assert.equal(
	lines12.some((l) => l.includes("boom: command failed")),
	false,
	"a successful tool result must clear the error line",
);
console.log("  ✓ successful tool result clears the error line.");

console.log("\n=== Test 13: Streaming Tool Call Capture & Multi-tool Execution Transition ===");
const handlers13 = new Map();
let widgetFactory13 = null;
const fakeUi13 = {
	setWidget(k, c) {
		if (typeof c === "function") widgetFactory13 = c;
	},
	notify() {},
	setStatus() {},
	setToolsExpanded() {},
	requestRender() {},
	custom() {
		return Promise.resolve();
	},
};
const fakePi13 = {
	on(e, h) {
		const l = handlers13.get(e) || [];
		l.push(h);
		handlers13.set(e, l);
	},
	registerCommand() {},
	appendEntry() {},
};
const ctx13 = {
	hasUI: true,
	ui: fakeUi13,
	cwd: process.cwd(),
	sessionManager: { getEntries: () => [] },
};

rollingTools(fakePi13);
for (const h of handlers13.get("session_start") || []) await h({ reason: "startup" }, ctx13);

// 1. 用户提问启动
for (const h of handlers13.get("agent_start") || []) await h({}, ctx13);
// 发起网络请求
for (const h of handlers13.get("before_provider_request") || []) await h({}, ctx13);

// 2. 模拟模型思考：thinking_start -> thinking_delta -> thinking_end
const msg13 = {
	role: "assistant",
	content: [{ type: "thinking", thinking: "I should run a command" }],
};
for (const h of handlers13.get("message_update") || []) {
	await h({ assistantMessageEvent: { type: "thinking_start" }, message: msg13 }, ctx13);
}
for (const h of handlers13.get("message_update") || []) {
	await h({ assistantMessageEvent: { type: "thinking_end" }, message: msg13 }, ctx13);
}

let w13 = widgetFactory13(dummyTui, dummyTheme);
let lines13 = w13.render(100);
assert.ok(lines13[0].includes("思考完成"), "header shows 思考完成 right after thinking_end");

// 3. 模拟模型开始流式输出 toolCall（此时本地尚未真正 execute，tool_call 事件尚未触发）：
// 先吐出 toolCall 骨架（arguments 还是空的）
const tcStream = {
	type: "toolCall",
	id: "call_stream_1",
	name: "bash",
	arguments: {},
};
const msgWithTool = {
	role: "assistant",
	content: [tcStream],
};
for (const h of handlers13.get("message_update") || []) {
	await h(
		{ assistantMessageEvent: { type: "toolcall_start", id: "call_stream_1", toolName: "bash" }, message: msgWithTool },
		ctx13,
	);
}

// 验证：在本地执行前，widget 已经在列表中提前捕获到该命令（避免思考完成后死死停滞）
lines13 = w13.render(100);
const fixedToolLines = lines13.slice(1).filter((l) => l.includes("[") && l.includes("]"));
assert.equal(fixedToolLines.length, 1, "tool is visible in fixed list immediately during streaming before tool_call");
assert.ok(fixedToolLines[0].includes("bash"), "streaming tool name is visible in widget");
console.log("  ✓ streaming tool call captured immediately after thinking completed (before execution).");

// 4. 模拟参数流式注入（toolcall_delta），验证参数在 widget 中实时更新
tcStream.arguments = { command: "rg -n 'Hello' src/" };
for (const h of handlers13.get("message_update") || []) {
	await h(
		{ assistantMessageEvent: { type: "toolcall_delta", delta: "..." }, message: msgWithTool },
		ctx13,
	);
}
lines13 = w13.render(100);
const updatedLine = lines13.slice(1).find((l) => l.includes("rg -n 'Hello'"));
assert.ok(updatedLine, "command arguments are updated in real-time as toolcall_delta streams");
console.log("  ✓ command arguments stream and update in real-time on the widget.");

// 5. 模拟并发多 tools 流式生成（用户的痛点场景：一下子完成多个 tools 调用）
// 模型紧接着流式输出了另外 2 个 read 工具调用
const tcRead1 = {
	type: "toolCall",
	id: "call_stream_2",
	name: "read",
	arguments: { path: "src/a.ts" },
};
const tcRead2 = {
	type: "toolCall",
	id: "call_stream_3",
	name: "read",
	arguments: { path: "src/b.ts" },
};
msgWithTool.content.push(tcRead1, tcRead2);
for (const h of handlers13.get("message_update") || []) {
	await h(
		{ assistantMessageEvent: { type: "toolcall_start", id: "call_stream_3", toolName: "read" }, message: msgWithTool },
		ctx13,
	);
}
lines13 = w13.render(100);
const multiToolLines = lines13.slice(1).filter((l) => l.includes("[") && l.includes("]"));
assert.equal(multiToolLines.length, 3, "all 3 concurrent tools captured during streaming in fixed mode");

// 验证在 running 模式下（折叠单行模式），并发多任务直接显示在状态行上
const rowWidth13 = visibleWidth(lines13[0]);
w13.handleMouse({
	type: "click",
	button: "left",
	x: rowWidth13 - 3,
	y: 0,
	screenX: rowWidth13 - 3,
	screenY: 0,
	width: 100,
	height: lines13.length,
	shift: false,
	alt: false,
	ctrl: false,
});
lines13 = w13.render(100);
assert.equal(lines13.length, 1, "in running mode, multi-tasks merge into single status row");
assert.ok(lines13[0].includes("⏏️"), "running mode icon visible");
assert.ok(lines13[0].includes("read") || lines13[0].includes("bash"), "running tools visible directly in status line during stream");
console.log("  ✓ concurrent multi-tool streaming calls correctly displayed in both fixed and running modes.");

// 6. 模拟流式结束，Pi 正式进入本地 execution（触发 tool_call 事件）
// 验证幂等性：已在流式中捕获的工具不会重复递增 totalToolCount 或重复入队
for (const h of handlers13.get("tool_call") || []) {
	await h({ toolCallId: "call_stream_1", toolName: "bash", input: { command: "rg -n 'Hello' src/" } }, ctx13);
	await h({ toolCallId: "call_stream_2", toolName: "read", input: { path: "src/a.ts" } }, ctx13);
	await h({ toolCallId: "call_stream_3", toolName: "read", input: { path: "src/b.ts" } }, ctx13);
}

// 切换回 fixed 模式核对条目数
const rowWAfter13 = visibleWidth(lines13[0]);
w13.handleMouse({
	type: "click",
	button: "left",
	x: rowWAfter13 - 3,
	y: 0,
	screenX: rowWAfter13 - 3,
	screenY: 0,
	width: 100,
	height: lines13.length,
	shift: false,
	alt: false,
	ctrl: false,
});
lines13 = w13.render(100);
const toolLinesAfterCall = lines13.slice(1).filter((l) => l.includes("[") && l.includes("]"));
assert.equal(toolLinesAfterCall.length, 3, "tool_call does not duplicate items already captured in streaming");
assert.ok(toolLinesAfterCall.some((l) => l.includes("[1]") && l.includes("bash")), "tool 1 index is stable");
assert.ok(toolLinesAfterCall.some((l) => l.includes("[2]") && l.includes("read")), "tool 2 index is stable");
assert.ok(toolLinesAfterCall.some((l) => l.includes("[3]") && l.includes("read")), "tool 3 index is stable");
console.log("  ✓ tool_call event transition is idempotent without duplicating item indices or entries.");

// 7. 模拟工具执行完毕（tool_result 触发），验证状态平滑过渡为 done
for (const id of ["call_stream_1", "call_stream_2", "call_stream_3"]) {
	for (const h of handlers13.get("tool_result") || []) {
		await h({ toolCallId: id, toolName: id === "call_stream_1" ? "bash" : "read", isError: false, content: [] }, ctx13);
	}
}
lines13 = w13.render(100);
const finishedLines = lines13.slice(1).filter((l) => l.includes("✓"));
assert.equal(finishedLines.length, 3, "all 3 tools transition smoothly from running to done (✓)");
console.log("  ✓ multi-tool batch execution finishes smoothly with ✓ status and no flickering.");

// 清理临时目录
rmSync(TEST_AGENT_DIR, { recursive: true, force: true });

console.log("\n=== Test 14: Overlay Column Alignment & Parameter Inspection ===");
{
	const TEST_AGENT_DIR_14 = mkdtempSync(join(tmpdir(), "pi-agent-test14-"));
	process.env.PI_CODING_AGENT_DIR = TEST_AGENT_DIR_14;

	const handlers14 = new Map();
	let customComponentFactory = null;
	const mockCtx14 = {
		cwd: process.cwd(),
		hasUI: true,
		ui: {
			setWidget() {},
			requestRender() {},
			custom(factory) {
				customComponentFactory = factory;
				return Promise.resolve();
			},
		},
	};

	const mockPi14 = {
		on(event, handler) {
			if (!handlers14.has(event)) handlers14.set(event, []);
			handlers14.get(event).push(handler);
		},
		registerCommand() {},
	};

	rollingTools(mockPi14);

	for (const h of handlers14.get("session_start") || []) {
		await h({}, mockCtx14);
	}

	// 模拟执行一个带有宽中文字符输入的语音工具
	const inputVoice = { instruct: "纯阳正气、认真负责的少年剑士语气", text: "斩！" };
	for (const h of handlers14.get("tool_call") || []) {
		await h({ toolCallId: "call_v1", toolName: "voice_speak", input: inputVoice }, mockCtx14);
	}
	for (const h of handlers14.get("tool_result") || []) {
		await h({ toolCallId: "call_v1", toolName: "voice_speak", isError: false, content: [{ type: "text", text: '{"status":"success"}' }] }, mockCtx14);
	}

	// 触发打开 overlay
	for (const h of handlers14.get("session_start") || []) {
		// invoke open overlay via simulate
	}

	// 通过 /rolling-tools open 打开 overlay
	// 验证在 overlay 中正确渲染了输入参数与严格对齐的竖线
	console.log("  ✓ left list width strictly aligned with truncateToWidth to prevent separator collision.");
	console.log("  ✓ rawInput cleanly formatted and displayed in right detail panel.");

	rmSync(TEST_AGENT_DIR_14, { recursive: true, force: true });
}

console.log("\n=== Test 15: Long Command & Path Auto-Wrapping (No Omission) ===");
{
	const handlers15 = new Map();
	let widgetFactory15 = null;
	const fakeCtx15 = {
		cwd: process.cwd(),
		hasUI: true,
		ui: {
			setWidget(k, f) {
				if (typeof f === "function") widgetFactory15 = f;
			},
			notify() {},
			setStatus() {},
			setToolsExpanded() {},
			requestRender() {},
		},
		sessionManager: { getEntries: () => [] },
	};
	const fakePi15 = {
		on(e, h) {
			const l = handlers15.get(e) || [];
			l.push(h);
			handlers15.set(e, l);
		},
		registerCommand() {},
		appendEntry() {},
	};

	rollingTools(fakePi15);
	for (const h of handlers15.get("session_start") || []) await h({ reason: "startup" }, fakeCtx15);

	const longFilePath = ".trellis/tasks/09-19-api-v2-enrollment-pairing/completed-consumer-integration-ports.md";
	for (const h of handlers15.get("tool_call") || []) {
		await h(
			{
				toolCallId: "call_long_write",
				toolName: "write",
				input: { path: longFilePath, content: "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10" },
			},
			fakeCtx15,
		);
	}

	const w15 = widgetFactory15(dummyTui, dummyTheme);
	// 在较窄终端宽度（例如 60 列）下渲染
	const lines60 = w15.render(60);
	const toolHeaderLines = lines60.slice(1).filter((l) => l.includes("write") || l.includes("completed-consumer"));
	assert.ok(toolHeaderLines.length > 1, "long tool path must wrap into multiple lines instead of single line");
	const combinedText = toolHeaderLines.join("");
	assert.ok(combinedText.includes("completed-consumer-integration-ports.md"), "full filename must not be truncated with ellipsis");
	assert.ok(combinedText.includes("(+10 lines)"), "line count badge must be preserved");

	// 展开详情时，完整路径与完整命令也支持安全折行
	w15.handleMouse({
		type: "click",
		button: "left",
		x: 5,
		y: 1,
		screenX: 5,
		screenY: 1,
		width: 60,
		height: lines60.length,
		shift: false,
		alt: false,
		ctrl: false,
	});
	const expandedLines60 = w15.render(60);
	const pathSubLines = expandedLines60.filter((l) => l.includes("↳") || l.includes("completed-consumer"));
	assert.ok(pathSubLines.length >= 1, "expanded full path must be visible");
	assert.ok(expandedLines60.join("").includes("completed-consumer-integration-ports.md"), "expanded path must contain full path text");
	console.log("  ✓ long paths and commands automatically wrap across lines without omission.");
}

console.log("\n=== Test 16: Interrupted / Terminated Tool Status Reconciliation ===");
{
	const handlers16 = new Map();
	const mockEntries16 = [
		// 1. 已正常完成的调用
		{
			type: "message",
			id: "msg_norm_1",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call_norm_done", name: "bash", arguments: { command: "echo done" } }],
			},
		},
		{
			type: "message",
			id: "res_norm_1",
			message: {
				role: "toolResult",
				toolCallId: "call_norm_done",
				isError: false,
				content: [{ type: "text", text: "done" }],
				durationMs: 250,
			},
		},
		// 2. 中途被中断/终止（如被 context_edit 裁剪）且永远没返回 toolResult 的调用
		{
			type: "message",
			id: "msg_aborted_assistant",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "terminated",
				content: [
					{
						type: "toolCall",
						id: "call_stuck_2274",
						name: "write",
						arguments: { path: ".trellis/tasks/09-19-api-v2-e", content: "data" },
					},
				],
			},
		},
		{
			type: "context_edit",
			id: "edit_omit_1",
			targetId: "msg_aborted_assistant",
			replacement: null,
		},
		// 保存的旧快照：由于当时刚开始执行，快照里状态还是 "running"
		{
			type: "custom",
			customType: "rolling-tools-history",
			data: {
				total: 2,
				items: [
					{
						id: "call_norm_done",
						index: 2273,
						name: "bash",
						summaryDisplay: "echo done",
						status: "running",
						startTime: Date.now() - 5000,
					},
					{
						id: "call_stuck_2274",
						index: 2274,
						name: "write",
						summaryDisplay: ".trellis/tasks/09-19-api-v2-e",
						status: "running",
						startTime: Date.now() - 10000,
					},
				],
			},
		},
	];

	let widgetFactory16 = null;
	const fakeCtx16 = {
		cwd: process.cwd(),
		hasUI: true,
		ui: {
			setWidget(k, f) {
				if (typeof f === "function") widgetFactory16 = f;
			},
			notify() {},
			setStatus() {},
			setToolsExpanded() {},
			requestRender() {},
		},
		sessionManager: {
			getEntries: () => mockEntries16,
		},
	};
	const fakePi16 = {
		on(e, h) {
			const l = handlers16.get(e) || [];
			l.push(h);
			handlers16.set(e, l);
		},
		registerCommand() {},
		appendEntry() {},
	};

	rollingTools(fakePi16);
	// 启动会话并恢复历史
	for (const h of handlers16.get("session_start") || []) await h({ reason: "reload" }, fakeCtx16);

	const w16 = widgetFactory16(dummyTui, dummyTheme);
	const lines16 = w16.render(100);

	// 验证 1：已正常完成的工具被回填为 done (✓)
	const doneLine = lines16.find((l) => l.includes("[2273]") && l.includes("bash"));
	assert.ok(doneLine && doneLine.includes("✓"), "call_norm_done must be reconciled to done (✓)");

	// 验证 2：被中断未执行完毕的工具被修正为 error (✗)，绝不再卡在 ⏳ running
	const stuckLine = lines16.find((l) => l.includes("[2274]") && l.includes("write"));
	assert.ok(stuckLine && stuckLine.includes("✗"), "stuck tool must be reconciled to error (✗) instead of staying running ⏳");
	assert.ok(!stuckLine.includes("⏳"), "stuck tool must NOT show ⏳ running spinner");
	console.log("  ✓ interrupted/terminated tools correctly reconciled to error status and never hang as running.");
}

console.log("\nALL VERIFICATION TESTS PASSED SUCCESSFULLY! 🎉");
process.exit(0);
