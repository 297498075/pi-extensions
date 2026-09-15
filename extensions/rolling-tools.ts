import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
} from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Box, Text, visibleWidth } from "@earendil-works/pi-tui";

/**
 * 空组件：在正文中占用 0 行
 */
class EmptyComponent implements Component {
	render(_width: number): string[] {
		return [];
	}
	invalidate(): void {}
}

interface ToolItem {
	id: string;
	index: number;
	name: string;
	summaryDisplay: string;
	fullPath?: string;
	fullCommand?: string;
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

type HeaderStatus =
	| { type: "idle" }
	| { type: "waiting_server"; startTime: number }
	| { type: "thinking"; startTime: number }
	| { type: "thinking_completed"; durationMs: number };

interface WidgetState {
	headerStatus: HeaderStatus;
	recentTools: ToolItem[];
	activeError: ActiveError | null;
	hoveredItemId: string | null;
	copyFeedbackMessage: string | null;
	completedMessage: string | null;
}

interface RenderedLineInfo {
	item: ToolItem | null;
	width: number;
}

const MAX_RECENT_TOOLS = 3;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * 纯只读命令集合
 */
const SAFE_READONLY_COMMANDS = new Set([
	"cat", "head", "tail", "more", "less",
	"ls", "dir", "pwd", "cd",
	"grep", "egrep", "fgrep", "find", "sort", "uniq", "wc", "cut",
	"which", "where", "type", "whoami", "uname", "date",
	"echo", "printf",
	"git", "node", "npm", "dotnet", "python", "python3", "pnpm", "yarn",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
	"status", "diff", "log", "branch", "show", "tag", "remote", "rev-parse", "describe",
]);

/**
 * 判断 Bash 命令是否属于纯只读探测（按换行符和运算符全面拆解）
 */
function isSafeReadOnlyBashCommand(command?: string): boolean {
	if (!command) return false;
	const cmd = command.trim();

	// 1. 任何重定向（> 或 >> 或 | tee）均为写操作
	if (/>{1,2}/.test(cmd) || /\btee\b/.test(cmd)) {
		return false;
	}

	// 2. 切割所有运算符和多行换行符（&&, ||, ;, |, \n）
	const subCommands = cmd.split(/&&|\|\||;|\||\r?\n/).map((c) => c.trim()).filter(Boolean);
	if (subCommands.length === 0) return false;

	for (const sub of subCommands) {
		const parts = sub.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "").split(/\s+/);
		const mainBin = parts[0]?.toLowerCase();
		if (!mainBin || !SAFE_READONLY_COMMANDS.has(mainBin)) {
			return false;
		}

		if (mainBin === "git") {
			const gitSub = parts[1]?.toLowerCase();
			if (!gitSub || !SAFE_GIT_SUBCOMMANDS.has(gitSub)) {
				return false;
			}
		}

		if (["node", "npm", "dotnet", "python", "python3", "pnpm", "yarn"].includes(mainBin)) {
			const isVersionOrHelp = parts.some((p) => /^-{1,2}(v|version|h|help|info)$/i.test(p));
			if (!isVersionOrHelp) {
				return false;
			}
		}
	}

	return true;
}

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

/**
 * 提取简短摘要、完整路径与完整命令
 */
function extractSummaryAndMetadata(
	name: string,
	input: any,
	cwd: string,
): { summaryDisplay: string; fullPath?: string; fullCommand?: string } {
	if (!input || typeof input !== "object") return { summaryDisplay: "" };

	switch (name) {
		case "bash": {
			const rawCmd = typeof input.command === "string" ? input.command : "";
			const firstLine = rawCmd.split("\n")[0] || "";
			const isMultiline = rawCmd.includes("\n");
			const display = truncate(firstLine, 55) + (isMultiline ? " ↵" : "");
			return { summaryDisplay: display, fullCommand: rawCmd };
		}
		case "read":
		case "edit":
		case "write": {
			const rawPath = typeof input.path === "string" ? input.path : "";
			if (!rawPath) return { summaryDisplay: "" };
			const absPath = resolve(cwd, rawPath);
			return { summaryDisplay: truncate(rawPath, 50), fullPath: absPath };
		}
		case "grep": {
			const scope = input.path ? resolve(cwd, input.path) : cwd;
			const display = `"${input.pattern || ""}" in ${truncate(input.path || ".", 30)}`;
			return { summaryDisplay: display, fullPath: scope };
		}
		case "find":
			return { summaryDisplay: truncate(input.pattern || "", 50) };
		case "ls": {
			const dirPath = input.path ? resolve(cwd, input.path) : cwd;
			return { summaryDisplay: truncate(input.path || ".", 40), fullPath: dirPath };
		}
		default:
			return { summaryDisplay: truncate(JSON.stringify(input), 50) };
	}
}

/**
 * 原生动态组件：精准根据文字可见宽度（X轴边界）触发悬停，空白区域绝不触发！
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

		const pushLine = (text: string, item: ToolItem | null = null) => {
			lines.push(text);
			this.lineMap.push({ item, width: visibleWidth(text) });
		};

		// 1. 顶层状态行（等待服务器响应 ➔ 思考中 ➔ 思考完成，共用一行平滑过渡）
		if (this.state.headerStatus.type === "waiting_server") {
			const elapsedSec = ((Date.now() - this.state.headerStatus.startTime) / 1000).toFixed(1);
			const spinner = SPINNER_FRAMES[Math.floor(Date.now() / 150) % SPINNER_FRAMES.length];
			pushLine(` ${theme.fg("accent", "🌐")} ${theme.bold(theme.fg("toolTitle", `${spinner} 等待服务器响应...`))} ${theme.fg("muted", `(${elapsedSec}s)`)}`);
		} else if (this.state.headerStatus.type === "thinking") {
			const elapsedSec = ((Date.now() - this.state.headerStatus.startTime) / 1000).toFixed(1);
			const spinner = SPINNER_FRAMES[Math.floor(Date.now() / 150) % SPINNER_FRAMES.length];
			pushLine(` ${theme.fg("accent", "💡")} ${theme.bold(theme.fg("toolTitle", `${spinner} 思考中...`))} ${theme.fg("muted", `(${elapsedSec}s)`)}`);
		} else if (this.state.headerStatus.type === "thinking_completed") {
			const elapsedSec = (this.state.headerStatus.durationMs / 1000).toFixed(1);
			pushLine(` ${theme.fg("accent", "💡")} ${theme.bold(theme.fg("toolTitle", "思考完成"))} ${theme.fg("muted", `(${elapsedSec}s)`)}`);
		}

		// 2. 滚动工具列表（完全无高亮突变，纯净平稳）
		const hoveredItem = this.state.hoveredItemId
			? this.state.recentTools.find((t) => t.id === this.state.hoveredItemId)
			: null;

		for (const t of this.state.recentTools) {
			let icon = theme.fg("accent", "⏳");
			if (t.status === "done") icon = theme.fg("success", "✓");
			if (t.status === "error") icon = theme.fg("error", "✗");

			const badge = theme.fg("dim", `[${t.index}]`);
			const name = theme.bold(theme.fg("toolTitle", t.name));
			const summary = theme.fg("dim", t.summaryDisplay);
			const time = t.durationMs !== undefined ? theme.fg("muted", ` (${t.durationMs}ms)`) : "";

			pushLine(` ${icon} ${badge} ${name} ${summary}${time}`, t);

			// 鼠标悬停展开：仅当鼠标精准悬停在该文字上方时才展开
			if (hoveredItem && hoveredItem.id === t.id) {
				if (t.fullPath) {
					pushLine(`   ${theme.fg("accent", `↳ ${t.fullPath}`)}`, t);
				} else if (t.fullCommand) {
					const cmdLines = t.fullCommand.split("\n").slice(0, 8);
					for (const cmdLine of cmdLines) {
						pushLine(`   ${theme.fg("accent", `↳ ${cmdLine}`)}`, t);
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

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// 精准判定：必须命中当前行，且 X 坐标必须落在实际文字渲染宽度之内！空白区域绝不触发！
		const lineEntry = event.y >= 0 && event.y < this.lineMap.length ? this.lineMap[event.y] : null;
		const isWithinText = Boolean(lineEntry && event.x >= 0 && event.x <= lineEntry.width);
		const targetItem = isWithinText ? lineEntry?.item : null;
		const targetId = targetItem ? targetItem.id : null;

		// 鼠标移动
		if (event.type === "move") {
			if (this.state.hoveredItemId !== targetId) {
				this.state.hoveredItemId = targetId;
				this.tui?.requestRender?.();
				return { handled: true };
			}
			return undefined;
		}

		// 鼠标点击（左键或右键）：仅在点击到文字范围内时触发
		if (event.type === "click" && isWithinText && targetItem) {
			// Ctrl + 左键：打开文件
			if (event.ctrl && targetItem.fullPath) {
				openFile(targetItem.fullPath);
				return { handled: true };
			}

			// 左右键点击：复制完整路径或完整命令
			const textToCopy = targetItem.fullPath || targetItem.fullCommand;
			if (textToCopy) {
				copyToClipboard(textToCopy);
				const label = targetItem.fullPath ? "完整路径" : "完整命令";
				this.state.copyFeedbackMessage = `✓ 已复制${label}至剪贴板: ${truncate(textToCopy, 45)}`;

				if (this.copyFeedbackTimer) clearTimeout(this.copyFeedbackTimer);
				this.copyFeedbackTimer = setTimeout(() => {
					this.state.copyFeedbackMessage = null;
					this.tui?.requestRender?.();
				}, 2500);

				this.tui?.requestRender?.();
				return { handled: true };
			}
		}

		return undefined;
	}

	invalidate(): void {}
}

export default function rollingTools(pi: ExtensionAPI): void {
	let totalToolCount = 0;
	let enabled = true;
	let statusTimer: any = null;

	const state: WidgetState = {
		headerStatus: { type: "idle" },
		recentTools: [],
		activeError: null,
		hoveredItemId: null,
		copyFeedbackMessage: null,
		completedMessage: null,
	};

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
			enabled &&
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

	// 1. 用户提问开始（新一轮 Agent 运行）时重置
	pi.on("agent_start", async (_event, ctx) => {
		// 确保工具默认处于折叠状态，避免误进入全展开模式导致 5 行限制失效
		(ctx.ui as any)?.setToolsExpanded?.(false);

		stopStatusTimer();
		state.recentTools = [];
		totalToolCount = 0;
		state.headerStatus = { type: "idle" };
		state.activeError = null;
		state.hoveredItemId = null;
		state.copyFeedbackMessage = null;
		state.completedMessage = null;
		syncWidget(ctx);
	});

	// 2. 发起网络请求前：顶层状态行切换为“等待服务器响应”，开启动态计时
	pi.on("before_provider_request", (_event, ctx) => {
		state.headerStatus = { type: "waiting_server", startTime: Date.now() };
		startStatusTimer(ctx);
		syncWidget(ctx);
	});

	// 3. 消息流式事件：
	// - 驱动 Thinking 状态（与等待服务器响应共用同一行，无缝过渡）
	// - 彻底过滤正文中的 thinking 块，消除占位符与空行！
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
			const thinkingStartTime = state.headerStatus.type === "thinking" ? state.headerStatus.startTime : Date.now();
			const actualDuration = Math.max(100, Date.now() - thinkingStartTime);
			stopStatusTimer();
			state.headerStatus = { type: "thinking_completed", durationMs: actualDuration };
			syncWidget(ctx);
		}

		// 正文流式输出时：顶层状态行（等待/思考）正式退场让位给正文！
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

	// 4. 只有当整个 Agent 任务全部结束（正文生成完毕）后，才在底部展示 Completed！
	pi.on("agent_end", async (_event, ctx) => {
		stopStatusTimer();
		state.headerStatus = { type: "idle" };
		state.completedMessage = "Completed";
		syncWidget(ctx);
	});

	// 5. 工具调用开始
	pi.on("tool_call", async (event, ctx) => {
		totalToolCount++;
		if (state.headerStatus.type === "waiting_server") {
			state.headerStatus = { type: "idle" };
			stopStatusTimer();
		}

		const cwd = ctx?.cwd || process.cwd();
		const { summaryDisplay, fullPath, fullCommand } = extractSummaryAndMetadata(event.toolName, event.input, cwd);

		state.recentTools.push({
			id: event.toolCallId,
			index: totalToolCount,
			name: event.toolName,
			summaryDisplay,
			fullPath,
			fullCommand,
			status: "running",
			startTime: Date.now(),
		});

		if (state.recentTools.length > MAX_RECENT_TOOLS) {
			state.recentTools.shift();
		}

		syncWidget(ctx);
	});

	// 6. 工具调用完成
	pi.on("tool_result", async (event, ctx) => {
		const item = state.recentTools.find((t) => t.id === event.toolCallId);
		if (item) {
			item.status = event.isError ? "error" : "done";
			item.durationMs = Date.now() - item.startTime;
		}

		if (event.isError) {
			const textContent = (event.content as any[])?.find((c) => c.type === "text");
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

	// 7. 开关控制命令
	pi.registerCommand("rolling-tools", {
		description: "Toggle or check rolling tools widget mode",
		handler: async (args, ctx) => {
			if (args === "off") {
				enabled = false;
				syncWidget(ctx);
			} else if (args === "on") {
				enabled = true;
				syncWidget(ctx);
			} else {
				enabled = !enabled;
				syncWidget(ctx);
			}
		},
	});

	// 8. 注册流控工具：read, bash, grep, find, ls
	// edit 和 write 绝不在此覆写（由 pi-tool-display 进行 OpenCode 差分渲染）
	const toolCache = new Map<string, any>();
	function getTools(cwd: string) {
		let tools = toolCache.get(cwd);
		if (!tools) {
			tools = {
				read: createReadTool(cwd),
				bash: createBashTool(cwd),
				grep: createGrepTool(cwd),
				find: createFindTool(cwd),
				ls: createLsTool(cwd),
			};
			toolCache.set(cwd, tools);
		}
		return tools;
	}

	const managedTools = ["read", "bash", "grep", "find", "ls"] as const;

	for (const name of managedTools) {
		const initialTools = getTools(process.cwd());
		const original = initialTools[name];

		pi.registerTool({
			name,
			label: original.label || name,
			description: original.description,
			parameters: original.parameters,

			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const cwd = ctx?.cwd || process.cwd();
				const tools = getTools(cwd);
				return tools[name].execute(toolCallId, params, signal, onUpdate);
			},

			renderShell: "self",

			renderCall(_args, _theme, _context) {
				// 正文中无论是 read 还是 bash 的调用头，一律返回 0 行！由 renderResult 统一输出单一完整的 Box，杜绝两个框！
				return new EmptyComponent();
			},

			renderResult(result, { expanded }, theme, context) {
				// 【核心规则 1】：纯只读工具（read, grep, find, ls）在正文中永远 100% 占用 0 行！绝对不输出任何“自定义样式”！
				if (name !== "bash") {
					return new EmptyComponent();
				}

				// 【核心规则 2】：Bash 命中纯只读白名单（如 echo, pwd, node -v）➔ 正文永远 100% 占用 0 行！
				const isSafe = isSafeReadOnlyBashCommand(context?.args?.command);
				if (isSafe) {
					return new EmptyComponent();
				}

				// 【核心规则 3】：Bash 执行报错 ➔ 折叠时正文 0 行（错误全由 Widget Alert 负责，绝不留永久垃圾）
				if (!expanded && result.isError) {
					return new EmptyComponent();
				}

				// 【核心规则 4】：真实变更型 Bash 命令 ➔ 严格以正统 OpenCode 风格单个 Box 输出，最多显示 5 行！
				const bgFn = (text: string) =>
					result.isError ? theme.bg("toolErrorBg", text) : theme.bg("toolSuccessBg", text);
				const box = new Box(1, 1, bgFn);

				// 命令行头：$ command
				const title = theme.fg("toolTitle", theme.bold("$"));
				const rawCmd = typeof context?.args?.command === "string" ? context.args.command.trim() : "";
				box.addChild(new Text(`${title} ${theme.fg("accent", truncate(rawCmd, 80))}`, 0, 0));

				// 命令输出：严格最多显示 5 行折叠
				const textContent = result.content?.find((c: any) => c.type === "text");
				const raw = textContent?.text || "";
				const lines = raw.split("\n").filter((l: string, idx: number, arr: string[]) => idx < arr.length - 1 || l.trim().length > 0);

				if (lines.length === 0) {
					box.addChild(new Text(theme.fg("muted", "↳ (no output)"), 0, 0));
				} else {
					// 严格遵从折叠时最多 5 行的限制
					const maxLines = expanded ? lines.length : 5;
					const shown = lines.slice(0, maxLines);
					const remaining = lines.length - shown.length;

					let text = shown.map((l: string) => theme.fg("toolOutput", l)).join("\n");
					if (remaining > 0) {
						text += `\n${theme.fg("muted", `... (${remaining} more lines • Ctrl+O to expand)`)}`;
					}
					box.addChild(new Text(text, 0, 0));
				}

				return box;
			},
		});
	}
}
