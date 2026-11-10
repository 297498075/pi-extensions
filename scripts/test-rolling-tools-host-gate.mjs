import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离测试环境：全局配置目录指向临时目录，避免读到真实用户配置
const root = mkdtempSync(join(tmpdir(), "rolling-host-gate-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalProfile = process.env.PI_ROLLING_TOOLS_PI_WEB;
const originalMarker = globalThis.__piWebHttpDispatcherConfigured;
const originalHostname = process.env.PI_WEB_HOSTNAME;
const originalPassword = process.env.PI_WEB_PASSWORD;
process.env.PI_CODING_AGENT_DIR = root;
delete process.env.PI_ROLLING_TOOLS_PI_WEB;
delete process.env.PI_WEB_HOSTNAME;
delete process.env.PI_WEB_PASSWORD;
delete globalThis.__piWebHttpDispatcherConfigured;

const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme();
const { default: rollingTools } = await import("../extensions/rolling-tools.ts");

const configPath = join(root, "extensions", "rolling-tools", "config.json");
function writeConfig(config) {
	mkdirSync(join(root, "extensions", "rolling-tools"), { recursive: true });
	writeFileSync(configPath, JSON.stringify({ configVersion: 3, ...config }), "utf-8");
}

function mount(mode = "rpc") {
	const handlers = new Map();
	const widgetCalls = [];
	const notifications = [];
	let command;
	rollingTools({
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(_name, cmd) {
			command = cmd;
		},
		appendEntry() {},
	});
	const ctx = {
		cwd: root,
		mode,
		hasUI: true,
		sessionManager: { getBranch: () => [] },
		ui: {
			notify(message) {
				notifications.push(String(message));
			},
			setStatus() {},
			setToolsExpanded() {},
			setWidget(key, value) {
				widgetCalls.push({ key, value });
			},
			custom() {
				return Promise.resolve();
			},
		},
	};
	return {
		widgetCalls,
		notifications,
		lastWidget() {
			return widgetCalls.at(-1)?.value;
		},
		async emit(name, event = {}) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
		async run(args) {
			await command.handler(args, ctx);
		},
	};
}

try {
	// 1. pi-web 宿主：rpc + 进程标记 → 整体停用
	globalThis.__piWebHttpDispatcherConfigured = true;
	const piWeb = mount("rpc");
	await piWeb.emit("session_start");
	assert.equal(piWeb.lastWidget(), undefined, "pi-web must clear the rolling widget");
	await piWeb.emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: { command: "ls" } });
	await piWeb.emit("tool_execution_end", { toolCallId: "a", toolName: "bash", isError: false, result: { content: [] } });
	assert.ok(
		piWeb.widgetCalls.every(call => call.value === undefined),
		"pi-web must never register a widget factory",
	);
	await piWeb.run("status");
	assert.ok(
		piWeb.notifications.some(text => text.includes("Host: pi-web")),
		"/rolling-tools status must report the pi-web host",
	);
	console.log("✓ pi-web host disables the widget, silencing and status enhancements");

	// 2. 显式 /rolling-tools on 允许本会话恢复
	await piWeb.run("on");
	assert.equal(typeof piWeb.lastWidget(), "function", "/rolling-tools on lifts the host gate for this session");
	console.log("✓ /rolling-tools on lifts the host gate");

	// 3. 环境变量覆盖：PI_ROLLING_TOOLS_PI_WEB=on
	process.env.PI_ROLLING_TOOLS_PI_WEB = "on";
	const overridden = mount("rpc");
	await overridden.emit("session_start");
	assert.equal(typeof overridden.lastWidget(), "function", "PI_ROLLING_TOOLS_PI_WEB=on keeps the widget in pi-web");
	console.log("✓ PI_ROLLING_TOOLS_PI_WEB=on keeps the widget");

	// 4. 配置项覆盖：disableInPiWeb: false
	delete process.env.PI_ROLLING_TOOLS_PI_WEB;
	writeConfig({ disableInPiWeb: false });
	const configured = mount("rpc");
	await configured.emit("session_start");
	assert.equal(typeof configured.lastWidget(), "function", "disableInPiWeb:false keeps the widget in pi-web");
	console.log("✓ disableInPiWeb:false keeps the widget");

	// 5. PI_ROLLING_TOOLS_PI_WEB=off 强制停用
	writeConfig({ disableInPiWeb: true });
	process.env.PI_ROLLING_TOOLS_PI_WEB = "off";
	const forced = mount("rpc");
	await forced.emit("session_start");
	assert.equal(forced.lastWidget(), undefined, "PI_ROLLING_TOOLS_PI_WEB=off forces the host gate");
	console.log("✓ PI_ROLLING_TOOLS_PI_WEB=off forces the host gate");

	// 6. 终端 TUI 与无 pi-web 标记的 RPC 客户端保持原有行为
	delete process.env.PI_ROLLING_TOOLS_PI_WEB;
	delete globalThis.__piWebHttpDispatcherConfigured;
	const client = mount("rpc");
	await client.emit("session_start");
	assert.equal(typeof client.lastWidget(), "function", "a plain RPC client keeps the widget");
	const tui = mount("tui");
	await tui.emit("session_start");
	assert.equal(typeof tui.lastWidget(), "function", "the terminal TUI keeps the widget");
	console.log("✓ terminal TUI and non-pi-web RPC clients keep the widget");
} finally {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalProfile === undefined) delete process.env.PI_ROLLING_TOOLS_PI_WEB;
	else process.env.PI_ROLLING_TOOLS_PI_WEB = originalProfile;
	if (originalHostname === undefined) delete process.env.PI_WEB_HOSTNAME;
	else process.env.PI_WEB_HOSTNAME = originalHostname;
	if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
	else process.env.PI_WEB_PASSWORD = originalPassword;
	if (originalMarker === undefined) delete globalThis.__piWebHttpDispatcherConfigured;
	else globalThis.__piWebHttpDispatcherConfigured = originalMarker;
	rmSync(root, { recursive: true, force: true });
}
