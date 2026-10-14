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
console.log("  ✓ All commands (status, off, on, reload) work as expected.");

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

// 清理临时目录
rmSync(TEST_AGENT_DIR, { recursive: true, force: true });

console.log("\nALL VERIFICATION TESTS PASSED SUCCESSFULLY! 🎉");
process.exit(0);
