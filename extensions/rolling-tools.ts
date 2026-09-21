import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { InteractiveMode, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * 通知拦截规则
 */
interface InterceptNotificationRule {
	match: string;
	suppressToast?: boolean;
	rollIntoWidget?: boolean;
}

/**
 * 滚动条与工具静音配置结构
 */
interface RollingToolsConfig {
	enabled: boolean;
	maxRecentTools: number;
	managedTools: string[];
	silencedTools?: string[];
	widgetTools?: string[];
	genericPropertyFallbacks: string[];
	interceptNotifications: InterceptNotificationRule[];
}

const DEFAULT_CONFIG: RollingToolsConfig = {
	enabled: true,
	maxRecentTools: 3,
	managedTools: [
		"read",
		"bash",
		"grep",
		"find",
		"ls",
		"mcp",
		"mcp__*",
		"rider_execute_tool",
		"obs_recall",
		"update_plan",
	],
	genericPropertyFallbacks: [
		"command",
		"path",
		"pattern",
		"query",
		"url",
		"tool",
		"prompt",
		"id",
		"message",
	],
	interceptNotifications: [
		{
			match: "SoL-Pi",
			suppressToast: true,
			rollIntoWidget: true,
		},
		{
			match: "Money saved",
			suppressToast: true,
			rollIntoWidget: true,
		},
	],
};

interface ToolItem {
	id: string;
	index: number;
	name: string;
	displayName?: string;
	summaryDisplay: string;
	fullPath?: string;
	fullCommand?: string;
	output?: string;
	status: "running" | "done" | "error";
	durationMs?: number;
	startTime: number;
}

interface ActiveError {
	toolName: string;
	index: number;
	summary: string;
	message: string;
}

interface SolPiSavingsState {
	summary: string;
	fullMessage: string;
	timestamp: number;
}

type HeaderStatus =
	| { type: "idle" }
	| { type: "waiting_server"; startTime: number }
	| { type: "thinking"; startTime: number }
	| { type: "thinking_completed"; durationMs: number };

interface WidgetState {
	headerStatus: HeaderStatus;
	recentTools: ToolItem[];
	activeError: ActiveError | null;
	expandedItemId: string | null;
	copyFeedbackMessage: string | null;
	completedMessage: string | null;
	solPiSavings: SolPiSavingsState | null;
}

type LineKind = "header" | "detail_copyable" | "detail_info" | "other";

interface RenderedLineInfo {
	item: ToolItem | null;
	width: number;
	kind: LineKind;
	textToCopy?: string;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TOOL_SILENCE_HOOK_INSTALLED = Symbol.for("pi-rolling-tools.toolExecutionRenderHook.v1");
const UI_HOOKS_INSTALLED = Symbol.for("pi-rolling-tools.uiHooksInstalled.v1");

/**
 * 跨平台剪贴板复制
 */
function copyToClipboard(text: string): void {
	try {
		if (process.platform === "win32") {
			const proc = spawn("clip");
			proc.stdin.write(text);
			proc.stdin.end();
		} else if (process.platform === "darwin") {
			const proc = spawn("pbcopy");
			proc.stdin.write(text);
			proc.stdin.end();
		} else {
			const proc = spawn("xclip", ["-selection", "clipboard"]);
			proc.stdin.write(text);
			proc.stdin.end();
		}
	} catch {}
}

/**
 * 跨平台打开文件
 */
function openFile(filePath: string): void {
	try {
		if (process.platform === "win32") {
			spawn("cmd", ["/c", "start", "", filePath], { detached: true, stdio: "ignore" }).unref();
		} else if (process.platform === "darwin") {
			spawn("open", [filePath], { detached: true, stdio: "ignore" }).unref();
		} else {
			spawn("xdg-open", [filePath], { detached: true, stdio: "ignore" }).unref();
		}
	} catch {}
}

function truncate(str: string, maxLen = 50): string {
	if (!str) return "";
	if (str.length <= maxLen) return str;
	return str.slice(0, maxLen - 3) + "...";
}

function ensureDirectoryExists(dirPath: string): void {
	try {
		if (!existsSync(dirPath)) {
			mkdirSync(dirPath, { recursive: true });
		}
	} catch {}
}

function getGlobalConfigDir(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(agentDir, "extensions", "rolling-tools");
}

function getGlobalConfigPath(): string {
	return join(getGlobalConfigDir(), "config.json");
}

function getLocalConfigPath(cwd: string): string {
	return join(cwd, ".pi", "rolling-tools.json");
}

function mergeConfig(base: RollingToolsConfig, override: Partial<RollingToolsConfig>): RollingToolsConfig {
	return {
		enabled: typeof override.enabled === "boolean" ? override.enabled : base.enabled,
		maxRecentTools:
			typeof override.maxRecentTools === "number" && override.maxRecentTools > 0
				? override.maxRecentTools
				: base.maxRecentTools,
		managedTools: Array.isArray(override.managedTools) ? [...override.managedTools] : base.managedTools,
		silencedTools: Array.isArray(override.silencedTools) ? [...override.silencedTools] : base.silencedTools,
		widgetTools: Array.isArray(override.widgetTools) ? [...override.widgetTools] : base.widgetTools,
		genericPropertyFallbacks: Array.isArray(override.genericPropertyFallbacks)
			? [...override.genericPropertyFallbacks]
			: base.genericPropertyFallbacks,
		interceptNotifications: Array.isArray(override.interceptNotifications)
			? [...override.interceptNotifications]
			: base.interceptNotifications,
	};
}

/**
 * 读取并合并配置（默认值 -> 全局配置 -> 本地配置）
 */
function loadConfig(cwd: string): RollingToolsConfig {
	let config: RollingToolsConfig = { ...DEFAULT_CONFIG };

	const globalPath = getGlobalConfigPath();
	try {
		if (existsSync(globalPath)) {
			const raw = readFileSync(globalPath, "utf-8");
			const parsed = JSON.parse(raw);
			config = mergeConfig(config, parsed);
		} else {
			ensureDirectoryExists(dirname(globalPath));
			writeFileSync(globalPath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
		}
	} catch (e) {
		console.error("[rolling-tools] Failed to load global config:", e);
	}

	const localPath = getLocalConfigPath(cwd);
	try {
		if (existsSync(localPath)) {
			const raw = readFileSync(localPath, "utf-8");
			const parsed = JSON.parse(raw);
			config = mergeConfig(config, parsed);
		}
	} catch (e) {
		console.error("[rolling-tools] Failed to load local config:", e);
	}

	return config;
}

/**
 * 规则通配符匹配（支持精确匹配、前缀/后缀星号及中间通配）
 */
function matchesToolRule(rule: string, toolName: string): boolean {
	if (!rule || !toolName) return false;
	if (rule === "*" || rule === toolName) return true;
	if (rule.endsWith("*") && !rule.slice(0, -1).includes("*")) {
		return toolName.startsWith(rule.slice(0, -1));
	}
	if (rule.startsWith("*") && !rule.slice(1).includes("*")) {
		return toolName.endsWith(rule.slice(1));
	}
	if (rule.includes("*")) {
		const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
		return new RegExp(`^${escaped}$`).test(toolName);
	}
	return false;
}

function isManagedTool(toolName: string, rules: string[]): boolean {
	return rules.some((rule) => matchesToolRule(rule, toolName));
}

function shouldSilenceInTranscript(toolName: string, config: RollingToolsConfig): boolean {
	const rules = config.silencedTools ?? config.managedTools;
	return isManagedTool(toolName, rules);
}

function shouldIncludeInWidget(toolName: string, config: RollingToolsConfig): boolean {
	const rules = config.widgetTools ?? [...config.managedTools, "edit", "write"];
	return isManagedTool(toolName, rules);
}

/**
 * 通用属性启发式推导
 */
function extractGenericParameters(
	input: any,
	cwd: string,
	propertyPriority: string[],
): { summary: string; fullPath?: string; fullCommand?: string } {
	if (!input || typeof input !== "object") {
		return { summary: "" };
	}

	let summary = "";
	let fullPath: string | undefined;
	let fullCommand: string | undefined;

	for (const prop of propertyPriority) {
		const val = input[prop];
		if (val === undefined || val === null) continue;

		if (typeof val === "string") {
			const trimmed = val.trim();
			if (!trimmed) continue;

			if (prop === "path" || prop === "file" || prop === "filePath") {
				fullPath = resolve(cwd, trimmed);
				summary = `${prop}: ${trimmed}`;
			} else if (prop === "command" || prop === "cmd") {
				fullCommand = trimmed;
				const firstLine = trimmed.split("\n")[0] || "";
				summary = firstLine + (trimmed.includes("\n") ? " ↵" : "");
			} else {
				summary = `${prop}: ${trimmed}`;
			}
			break;
		} else if (typeof val === "number" || typeof val === "boolean") {
			summary = `${prop}: ${val}`;
			break;
		}
	}

	if (!fullPath && typeof input.path === "string" && input.path.trim()) {
		fullPath = resolve(cwd, input.path.trim());
	}
	if (!fullCommand && typeof input.command === "string" && input.command.trim()) {
		fullCommand = input.command.trim();
	}

	return { summary, fullPath, fullCommand };
}

/**
 * 提取简短摘要、完整路径与完整命令
 */
function extractSummaryAndMetadata(
	name: string,
	input: any,
	cwd: string,
	config: RollingToolsConfig,
): { summaryDisplay: string; fullPath?: string; fullCommand?: string; displayName?: string } {
	if (!input || typeof input !== "object") {
		return { summaryDisplay: "" };
	}

	// 1. 内置命令：bash
	if (name === "bash") {
		const rawCmd = typeof input.command === "string" ? input.command : "";
		const firstLine = rawCmd.split("\n")[0] || "";
		const isMultiline = rawCmd.includes("\n");
		const display = truncate(firstLine, 55) + (isMultiline ? " ↵" : "");
		return { summaryDisplay: display, fullCommand: rawCmd };
	}

	// 2. 内置文件工具：read / edit / write
	if (name === "read" || name === "edit" || name === "write") {
		const rawPath = typeof input.path === "string" ? input.path : "";
		if (!rawPath) return { summaryDisplay: "" };
		const absPath = resolve(cwd, rawPath);
		return { summaryDisplay: truncate(rawPath, 50), fullPath: absPath };
	}

	// 3. 内置搜索：grep
	if (name === "grep") {
		const scope = input.path ? resolve(cwd, input.path) : cwd;
		const display = `"${input.pattern || ""}" in ${truncate(input.path || ".", 30)}`;
		return { summaryDisplay: display, fullPath: scope };
	}

	// 4. 内置文件查找：find
	if (name === "find") {
		return { summaryDisplay: truncate(input.pattern || "", 50) };
	}

	// 5. 内置目录列表：ls
	if (name === "ls") {
		const dirPath = input.path ? resolve(cwd, input.path) : cwd;
		return { summaryDisplay: truncate(input.path || ".", 40), fullPath: dirPath };
	}

	// 6. SoL-Pi: obs_recall
	if (name === "obs_recall") {
		const id = typeof input.id === "string" ? input.id : "";
		const offset = typeof input.offset === "number" ? ` @${input.offset}` : "";
		return { summaryDisplay: truncate(`id: ${id}${offset}`, 50) };
	}

	// 7. SoL-Pi: update_plan
	if (name === "update_plan") {
		const stepCount = Array.isArray(input.steps) ? input.steps.length : 0;
		const activeGoal = Array.isArray(input.steps)
			? (input.steps.find((s: any) => s.status === "in_progress")?.goal || "")
			: "";
		const display = activeGoal
			? `${stepCount} steps · ${truncate(activeGoal, 35)}`
			: `${stepCount} steps`;
		return { summaryDisplay: display };
	}

	// 8. Rider MCP 工具：rider_execute_tool
	if (name === "rider_execute_tool") {
		const cmd = typeof input.command === "string" ? input.command : "";
		const root = typeof input.rootFolder === "string" ? input.rootFolder : undefined;
		return {
			summaryDisplay: truncate(cmd, 50),
			fullCommand: cmd,
			fullPath: root,
		};
	}

	// 9. 通用 MCP 统一网关：mcp
	if (name === "mcp") {
		const server = typeof input.server === "string" ? input.server : "";
		const targetTool = typeof input.tool === "string" ? input.tool : "";
		const action = typeof input.action === "string" ? input.action : "";

		let innerSummary = "";
		let fullCmd: string | undefined;
		let fullPth: string | undefined;

		if (input.args && typeof input.args === "object") {
			const inner = extractSummaryAndMetadata(targetTool || "inner", input.args, cwd, config);
			innerSummary = inner.summaryDisplay ? ` (${inner.summaryDisplay})` : "";
			fullCmd = inner.fullCommand;
			fullPth = inner.fullPath;
		}

		let prefix = "";
		if (server && targetTool) {
			prefix = `[${server}] ${targetTool}`;
		} else if (targetTool) {
			prefix = targetTool;
		} else if (action) {
			prefix = `action: ${action}`;
		}

		return {
			displayName: prefix || "mcp",
			summaryDisplay: truncate(prefix + innerSummary, 55),
			fullCommand: fullCmd,
			fullPath: fullPth,
		};
	}

	// 10. 命名空间 MCP 工具：mcp__<server>__<tool>
	if (name.startsWith("mcp__")) {
		const parts = name.slice(5).split("__");
		const server = parts[0] || "";
		const tool = parts.slice(1).join(":") || "";
		const niceName = server && tool ? `${server}:${tool}` : name;

		const { summary, fullPath, fullCommand } = extractGenericParameters(
			input,
			cwd,
			config.genericPropertyFallbacks,
		);
		return {
			displayName: niceName,
			summaryDisplay: summary ? truncate(summary, 50) : "",
			fullPath,
			fullCommand,
		};
	}

	// 11. 通用第三方工具回退机制
	const { summary, fullPath, fullCommand } = extractGenericParameters(
		input,
		cwd,
		config.genericPropertyFallbacks,
	);
	return {
		summaryDisplay: summary ? truncate(summary, 50) : truncate(JSON.stringify(input), 50),
		fullPath,
		fullCommand,
	};
}

/**
 * 解析 SoL-Pi 节省信息文本
 */
function parseSolPiSavings(message: string): SolPiSavingsState {
	const lines = message.split("\n").map((l) => l.trim()).filter(Boolean);
	let summary = "";

	for (const line of lines) {
		if (line.includes("Money saved ·")) {
			const parts = line.split("Money saved ·");
			summary = parts[1]?.trim() || line;
			break;
		} else if (line.includes("Money saved")) {
			summary = line;
			break;
		} else if (line.includes("tokens")) {
			summary = line;
			break;
		}
	}

	if (!summary && lines.length > 0) {
		summary = lines[lines.length - 1] ?? "";
	}

	summary = summary.replace(/^⚡\s*/u, "").trim();

	return {
		summary,
		fullMessage: message,
		timestamp: Date.now(),
	};
}

/**
 * 匹配通知拦截规则
 */
function matchNotificationRule(
	message: string,
	rules: InterceptNotificationRule[],
): InterceptNotificationRule | undefined {
	for (const rule of rules) {
		if (!rule || !rule.match) continue;
		if (rule.match.startsWith("regex:")) {
			try {
				const reg = new RegExp(rule.match.slice(6));
				if (reg.test(message)) return rule;
			} catch {}
		} else if (message.includes(rule.match)) {
			return rule;
		}
	}
	return undefined;
}

/**
 * 原生动态组件：支持点击展开详情、滚动展示与剪贴板复制
 */
class RollingToolsWidgetComponent implements Component {
	private tui: any;
	private theme: any;
	private state: WidgetState;
	private lineMap: RenderedLineInfo[] = [];
	private copyFeedbackTimer: any = null;

	constructor(tui: any, theme: any, state: WidgetState) {
		this.tui = tui;
		this.theme = theme;
		this.state = state;
	}

	render(_width: number): string[] {
		this.lineMap = [];
		const lines: string[] = [];
		const theme = this.theme;

		const pushLine = (
			text: string,
			item: ToolItem | null = null,
			kind: LineKind = "other",
			textToCopy?: string,
		) => {
			lines.push(text);
			this.lineMap.push({
				item,
				width: visibleWidth(text),
				kind,
				textToCopy,
			});
		};

		// 1. 顶层状态行（等待服务器响应 ➔ 思考中 ➔ 思考完成，共用一行平滑过渡）
		if (this.state.headerStatus.type === "waiting_server") {
			const elapsedSec = ((Date.now() - this.state.headerStatus.startTime) / 1000).toFixed(1);
			const spinner = SPINNER_FRAMES[Math.floor(Date.now() / 150) % SPINNER_FRAMES.length];
			pushLine(
				` ${theme.fg("accent", "🌐")} ${theme.bold(theme.fg("toolTitle", `${spinner} 等待服务器响应...`))} ${theme.fg("muted", `(${elapsedSec}s)`)}`,
			);
		} else if (this.state.headerStatus.type === "thinking") {
			const elapsedSec = ((Date.now() - this.state.headerStatus.startTime) / 1000).toFixed(1);
			const spinner = SPINNER_FRAMES[Math.floor(Date.now() / 150) % SPINNER_FRAMES.length];
			pushLine(
				` ${theme.fg("accent", "💡")} ${theme.bold(theme.fg("toolTitle", `${spinner} 思考中...`))} ${theme.fg("muted", `(${elapsedSec}s)`)}`,
			);
		} else if (this.state.headerStatus.type === "thinking_completed") {
			const elapsedSec = (this.state.headerStatus.durationMs / 1000).toFixed(1);
			pushLine(
				` ${theme.fg("accent", "💡")} ${theme.bold(theme.fg("toolTitle", "思考完成"))} ${theme.fg("muted", `(${elapsedSec}s)`)}`,
			);
		}

		// 2. 滚动工具列表
		for (const t of this.state.recentTools) {
			const isExpanded = this.state.expandedItemId === t.id;
			let icon = theme.fg("accent", "⏳");
			if (t.status === "done") icon = theme.fg("success", "✓");
			if (t.status === "error") icon = theme.fg("error", "✗");

			const arrow = isExpanded ? theme.fg("accent", "▾") : theme.fg("dim", "▸");
			const badge = theme.fg("dim", `[${t.index}]`);
			const labelName = t.displayName || t.name;
			const name = theme.bold(theme.fg("toolTitle", labelName));
			const summary = theme.fg("dim", t.summaryDisplay);
			const time = t.durationMs !== undefined ? theme.fg("muted", ` (${t.durationMs}ms)`) : "";

			pushLine(` ${icon} ${arrow} ${badge} ${name} ${summary}${time}`, t, "header");

			// 点击展开详情：展示完整路径/完整命令以及输出结果
			if (isExpanded) {
				if (t.fullPath) {
					pushLine(`   ${theme.fg("accent", `↳ ${t.fullPath}`)}`, t, "detail_copyable", t.fullPath);
				} else if (t.fullCommand) {
					const cmdLines = t.fullCommand.split("\n").slice(0, 8);
					for (const cmdLine of cmdLines) {
						pushLine(`   ${theme.fg("accent", `↳ $ ${cmdLine}`)}`, t, "detail_copyable", t.fullCommand);
					}
					if (t.fullCommand.split("\n").length > 8) {
						pushLine(
							`   ${theme.fg("dim", `  ... (${t.fullCommand.split("\n").length - 8} more command lines)`)}`,
							t,
							"detail_info",
						);
					}
				}

				if (t.output !== undefined && t.output !== null) {
					const cleanOutput = t.output.trim();
					if (cleanOutput.length === 0) {
						pushLine(`   ${theme.fg("muted", "↳ (no output)")}`, t, "detail_info");
					} else {
						const outLines = cleanOutput.split("\n");
						const maxShow = 6;
						const shown = outLines.slice(0, maxShow);
						for (const outLine of shown) {
							pushLine(
								`   ${theme.fg("muted", `↳ ${truncate(outLine, 80)}`)}`,
								t,
								"detail_copyable",
								cleanOutput,
							);
						}
						if (outLines.length > maxShow) {
							pushLine(
								`   ${theme.fg("dim", `  ... (${outLines.length - maxShow} more output lines)`)}`,
								t,
								"detail_info",
							);
						}
					}
				}
			}
		}

		// 3. 复制成功反馈（仅在 Widget 内部就地显示，绝对 0 污染）
		if (this.state.copyFeedbackMessage) {
			pushLine(`   ${theme.fg("success", `↳ ${this.state.copyFeedbackMessage}`)}`);
		}

		// 4. 独立临时报错 Alert 块
		if (this.state.activeError) {
			const errHeader = ` ${theme.fg("error", "🔴")} ${theme.bold(theme.fg("error", `[Error in #${this.state.activeError.index} ${this.state.activeError.toolName}]`))} ${theme.fg("dim", this.state.activeError.summary)}`;
			const errBody = `    ${theme.fg("error", truncate(this.state.activeError.message.replace(/\r?\n/g, " "), 100))}`;
			pushLine(errHeader);
			pushLine(errBody);
		}

		// 5. 主回复完成标识（仅在整个 Agent 回复完全生成完毕后才附带显示）
		if (this.state.completedMessage) {
			pushLine(` ${theme.fg("success", `✓ ${this.state.completedMessage}`)}`);
		}

		return lines;
	}

	private triggerCopy(textToCopy: string, label: string): void {
		copyToClipboard(textToCopy);
		this.state.copyFeedbackMessage = `✓ 已复制${label}至剪贴板: ${truncate(textToCopy, 45)}`;

		if (this.copyFeedbackTimer) clearTimeout(this.copyFeedbackTimer);
		this.copyFeedbackTimer = setTimeout(() => {
			this.state.copyFeedbackMessage = null;
			this.tui?.requestRender?.();
		}, 2500);

		this.tui?.requestRender?.();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const lineEntry = event.y >= 0 && event.y < this.lineMap.length ? this.lineMap[event.y] : null;
		const isWithinText = Boolean(lineEntry && event.x >= 0 && event.x <= lineEntry.width);
		const targetItem = isWithinText ? lineEntry?.item : null;

		if (event.type === "move") {
			return undefined;
		}

		if (event.type === "click" && isWithinText) {
			// 1. 点击了可复制行（包括 SoL-Pi 节省行或工具详情输出）
			if (lineEntry?.kind === "detail_copyable" && lineEntry.textToCopy) {
				const label = targetItem?.fullPath
					? "完整路径"
					: targetItem?.fullCommand
						? "完整命令"
						: targetItem
							? "输出内容"
							: "详情信息";
				this.triggerCopy(lineEntry.textToCopy, label);
				return { handled: true };
			}

			if (targetItem) {
				// 2. Ctrl + 左键：打开文件
				if (event.ctrl && targetItem.fullPath) {
					openFile(targetItem.fullPath);
					return { handled: true };
				}

				// 3. 右键点击：复制内容
				if (event.button === "right") {
					const textToCopy =
						lineEntry?.textToCopy ||
						targetItem.fullPath ||
						targetItem.fullCommand ||
						targetItem.output ||
						targetItem.summaryDisplay;
					if (textToCopy) {
						const label = targetItem.fullPath ? "完整路径" : targetItem.fullCommand ? "完整命令" : "内容";
						this.triggerCopy(textToCopy, label);
						return { handled: true };
					}
				}

				// 4. 左键点击标题行：切换展开/折叠状态
				this.state.expandedItemId = this.state.expandedItemId === targetItem.id ? null : targetItem.id;
				this.tui?.requestRender?.();
				return { handled: true };
			}
		}

		return undefined;
	}

	invalidate(): void {}
}

/**
 * 劫持 ToolExecutionComponent.prototype.render 实现正文工具静音
 * 当工具处于折叠状态且命中配置白名单时返回 0 行；Ctrl+O 展开时调用原生渲染器
 */
function installToolExecutionRenderHook(getConfig: () => RollingToolsConfig): void {
	const proto = ToolExecutionComponent.prototype as any;
	if (proto[TOOL_SILENCE_HOOK_INSTALLED]) return;
	proto[TOOL_SILENCE_HOOK_INSTALLED] = true;

	const originalRender = proto.render;
	proto.render = function (this: any, width: number): string[] {
		const config = getConfig();
		if (config.enabled && !this.expanded && shouldSilenceInTranscript(this.toolName, config)) {
			return [];
		}
		return originalRender.call(this, width);
	};
}

/**
 * 格式化底部状态栏的 SoL-Pi 提示信息，赋予与主题一致的原生配色并附带相对时间
 */
function formatColoredSolPiStatus(rawText: string, theme?: any, elapsedSec?: number): string {
	const match = rawText.match(/^⚡\s*(?:SoL-Pi\s*·\s*)?(.*?)\s*·\s*(.*)$/);
	const timeSuffix = elapsedSec !== undefined ? ` (${elapsedSec}s ago)` : "";
	if (match) {
		const mechanism = match[1] || "Observation Pack";
		const saving = match[2] || "";
		if (theme?.fg) {
			const yellowLightning = theme.fg("warning", "⚡");
			const cyanMechanism = theme.fg("accent", theme.bold(mechanism));
			const greenSaving = theme.fg("success", saving);
			const dimDot = theme.fg("dim", "·");
			const mutedTime = theme.fg("muted", timeSuffix);
			return `${yellowLightning} ${cyanMechanism} ${dimDot} ${greenSaving}${mutedTime}`;
		}
		return `\x1b[33m⚡\x1b[39m \x1b[1;36m${mechanism}\x1b[22;39m \x1b[90m·\x1b[39m \x1b[32m${saving}\x1b[39m \x1b[90m${timeSuffix}\x1b[39m`;
	}
	return rawText + (timeSuffix ? ` \x1b[90m${timeSuffix}\x1b[39m` : "");
}

const SOL_PI_STATUS_MAX_DURATION_MS = 30_000;
let solPiStatusInterval: any = null;
let solPiStartTime = 0;
let lastSolPiRawText = "";

/**
 * 劫持 InteractiveMode.prototype.showExtensionNotify 与 setExtensionStatus
 * 从全局 UI 根层级拦截通知与状态更新，实现 100% 可靠的静音与数据注入
 */
function installInteractiveModeNotificationHook(
	getConfig: () => RollingToolsConfig,
	onIntercept: (message: string) => void,
): void {
	const proto = InteractiveMode.prototype as any;
	if (proto[UI_HOOKS_INSTALLED]) return;
	proto[UI_HOOKS_INSTALLED] = true;

	const originalShowExtensionNotify = proto.showExtensionNotify;
	proto.showExtensionNotify = function (this: any, message: string, type?: string) {
		const config = getConfig();
		const matchedRule = matchNotificationRule(message, config.interceptNotifications);
		if (matchedRule) {
			if (matchedRule.rollIntoWidget) {
				onIntercept(message);
			}
			if (matchedRule.suppressToast) {
				return;
			}
		}
		return originalShowExtensionNotify.call(this, message, type);
	};

	const originalSetExtensionStatus = proto.setExtensionStatus;
	proto.setExtensionStatus = function (this: any, key: string, text: string | undefined) {
		if (key === "sol-pi") {
			if (text) {
				// 新提示到达：清除旧定时器，重置起始时间
				if (solPiStatusInterval) {
					clearInterval(solPiStatusInterval);
					solPiStatusInterval = null;
				}
				lastSolPiRawText = text;
				solPiStartTime = Date.now();

				const updateStatus = () => {
					const elapsedSec = Math.floor((Date.now() - solPiStartTime) / 1000);
					if (elapsedSec >= Math.floor(SOL_PI_STATUS_MAX_DURATION_MS / 1000)) {
						if (solPiStatusInterval) {
							clearInterval(solPiStatusInterval);
							solPiStatusInterval = null;
						}
						lastSolPiRawText = "";
						originalSetExtensionStatus.call(this, key, undefined);
						return;
					}
					const coloredText = formatColoredSolPiStatus(
						lastSolPiRawText,
						this.themeController?.currentTheme,
						elapsedSec,
					);
					originalSetExtensionStatus.call(this, key, coloredText);
				};

				updateStatus();
				solPiStatusInterval = setInterval(updateStatus, 1000);
				if (typeof solPiStatusInterval === "object" && "unref" in solPiStatusInterval) {
					solPiStatusInterval.unref();
				}
				return;
			} else {
				// SoL-Pi 内部定时器尝试提前清空：若 30 秒尚未到期，阻止提前擦除
				const remaining = solPiStartTime + SOL_PI_STATUS_MAX_DURATION_MS - Date.now();
				if (remaining > 0 && lastSolPiRawText) {
					return;
				}
			}
		}
		return originalSetExtensionStatus.call(this, key, text);
	};
}

export default function rollingTools(pi: ExtensionAPI): void {
	let currentConfig: RollingToolsConfig = loadConfig(process.cwd());
	let totalToolCount = 0;
	let statusTimer: any = null;
	let lastCtx: any = null;

	const state: WidgetState = {
		headerStatus: { type: "idle" },
		recentTools: [],
		activeError: null,
		expandedItemId: null,
		copyFeedbackMessage: null,
		completedMessage: null,
		solPiSavings: null,
	};

	// 1. 安装正文静音 Hook 与全局通知拦截 Hook
	installToolExecutionRenderHook(() => currentConfig);
	installInteractiveModeNotificationHook(
		() => currentConfig,
		(message) => {
			state.solPiSavings = parseSolPiSavings(message);
			if (lastCtx) syncWidget(lastCtx);
		},
	);

	function stopStatusTimer(): void {
		if (statusTimer) {
			clearInterval(statusTimer);
			statusTimer = null;
		}
	}

	function startStatusTimer(ctx: any): void {
		stopStatusTimer();
		statusTimer = setInterval(() => {
			syncWidget(ctx);
		}, 100);
	}

	function syncWidget(ctx: any): void {
		if (!ctx?.hasUI) return;

		const hasContent =
			currentConfig.enabled &&
			(state.headerStatus.type !== "idle" ||
				state.recentTools.length > 0 ||
				state.activeError !== null ||
				state.completedMessage !== null);

		if (!hasContent) {
			ctx.ui.setWidget("rolling-tools", undefined);
			return;
		}

		ctx.ui.setWidget(
			"rolling-tools",
			(tui: any, theme: any) => new RollingToolsWidgetComponent(tui, theme, state),
			{ placement: "aboveEditor" },
		);
	}

	/**
	 * 安装 UI 通知 Hook（用于拦截并静音 SoL-Pi 弹窗，将节省信息融入滚动条）
	 */
	function installUiHooks(ctx: ExtensionContext): void {
		if (!ctx?.hasUI || !ctx.ui) return;
		const ui = ctx.ui as any;
		if (ui[UI_HOOKS_INSTALLED]) return;
		ui[UI_HOOKS_INSTALLED] = true;

		const originalNotify = ui.notify?.bind(ui);
		if (originalNotify) {
			ui.notify = (message: string, type?: string) => {
				const matchedRule = matchNotificationRule(message, currentConfig.interceptNotifications);
				if (matchedRule) {
					if (matchedRule.rollIntoWidget) {
						state.solPiSavings = parseSolPiSavings(message);
						syncWidget(ctx);
					}
					if (matchedRule.suppressToast) {
						return;
					}
				}
				return originalNotify(message, type);
			};
		}

		const originalSetStatus = ui.setStatus?.bind(ui);
		if (originalSetStatus) {
			ui.setStatus = (key: string, text: string | undefined) => {
				if (key === "sol-pi" && text) {
					state.solPiSavings = parseSolPiSavings(text);
					syncWidget(ctx);
				}
				return originalSetStatus(key, text);
			};
		}
	}

	// 2. 会话启动
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		currentConfig = loadConfig(ctx?.cwd || process.cwd());
		installUiHooks(ctx);
		syncWidget(ctx);
	});

	// 3. 用户提问开始（新一轮 Agent 运行）时重置
	pi.on("agent_start", async (_event, ctx) => {
		lastCtx = ctx;
		installUiHooks(ctx);
		(ctx.ui as any)?.setToolsExpanded?.(false);

		stopStatusTimer();
		state.recentTools = [];
		totalToolCount = 0;
		state.headerStatus = { type: "idle" };
		state.activeError = null;
		state.expandedItemId = null;
		state.copyFeedbackMessage = null;
		state.completedMessage = null;
		state.solPiSavings = null;
		syncWidget(ctx);
	});

	// 4. 发起网络请求前：顶层状态行切换为“等待服务器响应”，开启动态计时
	pi.on("before_provider_request", (_event, ctx) => {
		state.headerStatus = { type: "waiting_server", startTime: Date.now() };
		startStatusTimer(ctx);
		syncWidget(ctx);
	});

	// 5. 消息流式事件
	pi.on("message_update", async (event, ctx) => {
		if (event.message?.role === "assistant" && Array.isArray(event.message.content)) {
			event.message.content = event.message.content.filter((c: any) => c.type !== "thinking");
		}

		const ev = (event as any).assistantMessageEvent;
		if (!ev) return;

		if (ev.type === "thinking_start" || ev.type === "thinking_delta") {
			if (state.headerStatus.type !== "thinking") {
				state.headerStatus = { type: "thinking", startTime: Date.now() };
				startStatusTimer(ctx);
				syncWidget(ctx);
			}
		} else if (ev.type === "thinking_end") {
			const thinkingStartTime =
				state.headerStatus.type === "thinking" ? state.headerStatus.startTime : Date.now();
			const actualDuration = Math.max(100, Date.now() - thinkingStartTime);
			stopStatusTimer();
			state.headerStatus = { type: "thinking_completed", durationMs: actualDuration };
			syncWidget(ctx);
		}

		// 正文流式输出时：顶层状态行正式退场让位给正文
		const isTextStreaming =
			ev.type === "text_start" ||
			(ev.type === "text_delta" && typeof ev.delta === "string" && ev.delta.trim().length > 0);

		if (isTextStreaming) {
			state.headerStatus = { type: "idle" };
			stopStatusTimer();
			state.activeError = null;
			syncWidget(ctx);
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message?.role === "assistant" && Array.isArray(event.message.content)) {
			return {
				message: {
					...event.message,
					content: event.message.content.filter((c: any) => c.type !== "thinking"),
				},
			};
		}
	});

	// 6. 整个 Agent 任务全部结束（正文生成完毕）后展示 Completed
	pi.on("agent_end", async (_event, ctx) => {
		stopStatusTimer();
		state.headerStatus = { type: "idle" };
		state.completedMessage = "Completed";
		syncWidget(ctx);
	});

	// 7. 工具调用开始：记录进 recentTools 并滚动
	pi.on("tool_call", async (event, ctx) => {
		if (state.headerStatus.type === "waiting_server") {
			state.headerStatus = { type: "idle" };
			stopStatusTimer();
		}

		if (!shouldIncludeInWidget(event.toolName, currentConfig)) {
			return;
		}

		totalToolCount++;
		const cwd = ctx?.cwd || process.cwd();
		const { summaryDisplay, fullPath, fullCommand, displayName } = extractSummaryAndMetadata(
			event.toolName,
			event.input,
			cwd,
			currentConfig,
		);

		state.recentTools.push({
			id: event.toolCallId,
			index: totalToolCount,
			name: event.toolName,
			displayName,
			summaryDisplay,
			fullPath,
			fullCommand,
			status: "running",
			startTime: Date.now(),
		});

		if (state.recentTools.length > currentConfig.maxRecentTools) {
			state.recentTools.shift();
		}

		if (state.expandedItemId && !state.recentTools.some((t) => t.id === state.expandedItemId)) {
			state.expandedItemId = null;
		}

		syncWidget(ctx);
	});

	// 8. 工具调用完成：记录耗时、状态与输出内容
	pi.on("tool_result", async (event, ctx) => {
		const item = state.recentTools.find((t) => t.id === event.toolCallId);
		if (item) {
			item.status = event.isError ? "error" : "done";
			item.durationMs = Date.now() - item.startTime;

			const textContent = (event.content as any[])?.find((c) => c && c.type === "text");
			if (textContent && typeof textContent.text === "string") {
				item.output = textContent.text;
			}
		}

		if (event.isError) {
			const textContent = (event.content as any[])?.find((c) => c && c.type === "text");
			const rawError = textContent?.text || "Tool execution failed";
			state.activeError = {
				toolName: event.toolName,
				index: item?.index ?? totalToolCount,
				summary: item?.summaryDisplay || "",
				message: rawError.trim(),
			};
		} else {
			state.activeError = null;
		}

		syncWidget(ctx);
	});

	// 9. 会话终止清理资源
	pi.on("session_shutdown", async () => {
		stopStatusTimer();
		if (solPiStatusInterval) {
			clearInterval(solPiStatusInterval);
			solPiStatusInterval = null;
		}
	});

	// 10. 管理控制命令
	pi.registerCommand("rolling-tools", {
		description: "Manage rolling tools widget mode, configuration, and reload",
		handler: async (args, ctx) => {
			const action = (args || "").trim();
			if (action === "reload") {
				currentConfig = loadConfig(ctx?.cwd || process.cwd());
				syncWidget(ctx);
				ctx.ui?.notify?.("✓ rolling-tools: 配置已重载", "info");
			} else if (action === "off") {
				currentConfig.enabled = false;
				syncWidget(ctx);
				ctx.ui?.notify?.("rolling-tools: 已禁用正文静音与滚动条", "info");
			} else if (action === "on") {
				currentConfig.enabled = true;
				syncWidget(ctx);
				ctx.ui?.notify?.("rolling-tools: 已启用正文静音与滚动条", "info");
			} else if (action === "status") {
				const info = [
					`rolling-tools 状态:`,
					`• 运行状态: ${currentConfig.enabled ? "已开启" : "已关闭"}`,
					`• 最大滚动数: ${currentConfig.maxRecentTools}`,
					`• 静音工具规则: ${currentConfig.managedTools.join(", ")}`,
					`• 通知拦截规则: ${currentConfig.interceptNotifications.length} 条`,
				].join("\n");
				ctx.ui?.notify?.(info, "info");
			} else {
				currentConfig.enabled = !currentConfig.enabled;
				syncWidget(ctx);
				ctx.ui?.notify?.(`rolling-tools: ${currentConfig.enabled ? "已开启" : "已关闭"}`, "info");
			}
		},
	});
}
