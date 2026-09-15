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
import { Text } from "@earendil-works/pi-tui";

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

interface WidgetState {
	thinkingStatus: "idle" | "thinking" | "completed";
	thinkingStartTime: number;
	thinkingDurationMs: number;
	recentTools: ToolItem[];
	activeError: ActiveError | null;
	hoveredItemId: string | null;
	copyFeedbackMessage: string | null;
	completedMessage: string | null;
}

const MAX_RECENT_TOOLS = 3;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MIN_THINKING_DISPLAY_MS = 1500; // 保证思考动画至少展示 1.5 秒

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
 * 原生动态组件：每一帧实时感知状态与鼠标位置，0ms 响应悬停展开与左右键复制
 */
class RollingToolsWidgetComponent implements Component {
	private tui: any;
	private theme: any;
	private state: WidgetState;
	private ctx: any;
	private lineMap: (ToolItem | null)[] = [];
	private copyFeedbackTimer: any = null;

	constructor(tui: any, theme: any, state: WidgetState, ctx: any) {
		this.tui = tui;
		this.theme = theme;
		this.state = state;
		this.ctx = ctx;
	}

	render(_width: number): string[] {
		this.lineMap = [];
		const lines: string[] = [];
		const theme = this.theme;

		// 1. Thinking 状态（思考中动态转轮；思考完成保持常驻，直到正文流式输出）
		if (this.state.thinkingStatus === "thinking") {
			const elapsedSec = ((Date.now() - this.state.thinkingStartTime) / 1000).toFixed(1);
			const spinner = SPINNER_FRAMES[Math.floor(Date.now() / 150) % SPINNER_FRAMES.length];
			lines.push(` ${theme.fg("accent", "💡")} ${theme.bold(theme.fg("toolTitle", `${spinner} 思考中...`))} ${theme.fg("muted", `(${elapsedSec}s)`)}`);
			this.lineMap.push(null);
		} else if (this.state.thinkingStatus === "completed") {
			const elapsedSec = (this.state.thinkingDurationMs / 1000).toFixed(1);
			lines.push(` ${theme.fg("accent", "💡")} ${theme.bold(theme.fg("toolTitle", "思考完成"))} ${theme.fg("muted", `(${elapsedSec}s)`)}`);
			this.lineMap.push(null);
		}

		// 2. 滚动工具列表（完全无高亮突变，纯净平稳）
		for (const t of this.state.recentTools) {
			let icon = theme.fg("accent", "⏳");
			if (t.status === "done") icon = theme.fg("success", "✓");
			if (t.status === "error") icon = theme.fg("error", "✗");

			const badge = theme.fg("dim", `[${t.index}]`);
			const name = theme.bold(theme.fg("toolTitle", t.name));
			const summary = theme.fg("dim", t.summaryDisplay);
			const time = t.durationMs !== undefined ? theme.fg("muted", ` (${t.durationMs}ms)`) : "";

			lines.push(` ${icon} ${badge} ${name} ${summary}${time}`);
			this.lineMap.push(t);

			// 鼠标悬停展开：直接展示完整路径或完整命令，绝无“提示：[左右键...”教学行
			if (this.state.hoveredItemId === t.id) {
				if (t.fullPath) {
					lines.push(`   ${theme.fg("accent", `↳ ${t.fullPath}`)}`);
					this.lineMap.push(t);
				} else if (t.fullCommand) {
					const cmdLines = t.fullCommand.split("\n").slice(0, 8);
					for (const cmdLine of cmdLines) {
						lines.push(`   ${theme.fg("accent", `↳ ${cmdLine}`)}`);
						this.lineMap.push(t);
					}
				}
			}
		}

		// 3. 复制成功反馈（在组件内部优雅淡入淡出，0 污染正文）
		if (this.state.copyFeedbackMessage) {
			lines.push(`   ${theme.fg("success", `↳ ${this.state.copyFeedbackMessage}`)}`);
			this.lineMap.push(null);
		}

		// 4. 独立临时报错 Alert 块
		if (this.state.activeError) {
			const errHeader = ` ${theme.fg("error", "🔴")} ${theme.bold(theme.fg("error", `[Error in #${this.state.activeError.index} ${this.state.activeError.toolName}]`))} ${theme.fg("dim", this.state.activeError.summary)}`;
			const errBody = `    ${theme.fg("error", truncate(this.state.activeError.message.replace(/\r?\n/g, " "), 100))}`;
			lines.push(errHeader);
			this.lineMap.push(null);
			lines.push(errBody);
			this.lineMap.push(null);
		}

		// 5. 主要回复完成标识（仅在整个回合结束时附加展示）
		if (this.state.completedMessage) {
			lines.push(` ${theme.fg("success", `✓ ${this.state.completedMessage}`)}`);
			this.lineMap.push(null);
		}

		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// 鼠标移动：根据 y 坐标精准匹配工具项，0ms 立即更新悬停项并重绘
		if (event.type === "move") {
			const target = event.y >= 0 && event.y < this.lineMap.length ? this.lineMap[event.y] : null;
			const targetId = target ? target.id : null;
			if (this.state.hoveredItemId !== targetId) {
				this.state.hoveredItemId = targetId;
				this.tui?.requestRender?.();
				return { handled: true };
			}
			return undefined;
		}

		// 鼠标点击（左键或右键）
		if (event.type === "click") {
			const target = event.y >= 0 && event.y < this.lineMap.length ? this.lineMap[event.y] : null;
			if (!target) return undefined;

			// Ctrl + 左键：打开文件
			if (event.ctrl && target.fullPath) {
				openFile(target.fullPath);
				this.ctx.ui.setStatus("clipboard", this.theme.fg("accent", `正在打开文件: ${truncate(target.fullPath, 40)}`));
				setTimeout(() => this.ctx.ui.setStatus("clipboard", undefined), 2500);
				return { handled: true };
			}

			// 左右键点击：复制文件完整路径或完整命令（绝不向正文输出任何提示文字！）
			const textToCopy = target.fullPath || target.fullCommand;
			if (textToCopy) {
				copyToClipboard(textToCopy);
				const label = target.fullPath ? "完整路径" : "完整命令";
				this.state.copyFeedbackMessage = `✓ 已复制${label}至剪贴板: ${truncate(textToCopy, 45)}`;

				this.ctx.ui.setStatus("clipboard", this.theme.fg("success", `✓ 已复制${label}到剪贴板`));

				if (this.copyFeedbackTimer) clearTimeout(this.copyFeedbackTimer);
				this.copyFeedbackTimer = setTimeout(() => {
					this.state.copyFeedbackMessage = null;
					this.ctx.ui.setStatus("clipboard", undefined);
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
	let thinkingTimer: any = null;

	const state: WidgetState = {
		thinkingStatus: "idle",
		thinkingStartTime: 0,
		thinkingDurationMs: 0,
		recentTools: [],
		activeError: null,
		hoveredItemId: null,
		copyFeedbackMessage: null,
		completedMessage: null,
	};

	function stopThinkingTimer(): void {
		if (thinkingTimer) {
			clearInterval(thinkingTimer);
			thinkingTimer = null;
		}
	}

	function syncWidget(ctx: any): void {
		if (!ctx?.hasUI) return;

		const hasContent =
			enabled &&
			(state.thinkingStatus !== "idle" ||
				state.recentTools.length > 0 ||
				state.activeError !== null ||
				state.completedMessage !== null);

		if (!hasContent) {
			ctx.ui.setWidget("rolling-tools", undefined);
			return;
		}

		ctx.ui.setWidget(
			"rolling-tools",
			(tui: any, theme: any) => new RollingToolsWidgetComponent(tui, theme, state, ctx),
			{ placement: "aboveEditor" },
		);
	}

	// 1. 用户提问（新一轮交互开始）时重置所有状态
	pi.on("agent_start", async (_event, ctx) => {
		stopThinkingTimer();
		state.recentTools = [];
		totalToolCount = 0;
		state.thinkingStatus = "idle";
		state.thinkingStartTime = 0;
		state.thinkingDurationMs = 0;
		state.activeError = null;
		state.hoveredItemId = null;
		state.copyFeedbackMessage = null;
		state.completedMessage = null;
		syncWidget(ctx);
	});

	// 2. 消息流式事件：
	// - 保证思考动画最少可见 1.5 秒
	// - 思考完成更新为“思考完成”并常驻，直到正文流式输出才退场
	// - 彻底过滤正文中的 thinking 块，消除占位符与空行！
	pi.on("message_update", async (event, ctx) => {
		if (event.message?.role === "assistant" && Array.isArray(event.message.content)) {
			event.message.content = event.message.content.filter((c: any) => c.type !== "thinking");
		}

		const ev = (event as any).assistantMessageEvent;
		if (!ev) return;

		if (ev.type === "thinking_start" || ev.type === "thinking_delta") {
			if (state.thinkingStatus !== "thinking") {
				state.thinkingStatus = "thinking";
				state.thinkingStartTime = Date.now();
				stopThinkingTimer();
				thinkingTimer = setInterval(() => {
					syncWidget(ctx);
				}, 100);
				syncWidget(ctx);
			}
		} else if (ev.type === "thinking_end") {
			// 保证思考动画至少展示 MIN_THINKING_DISPLAY_MS，避免一闪而过
			const elapsed = Date.now() - state.thinkingStartTime;
			const remaining = Math.max(0, MIN_THINKING_DISPLAY_MS - elapsed);
			setTimeout(() => {
				stopThinkingTimer();
				// 思考结束更新为“思考完成”，绝不提前退场，继续在 Widget 顶部常驻
				state.thinkingStatus = "completed";
				state.thinkingDurationMs = Date.now() - (state.thinkingStartTime || Date.now());
				syncWidget(ctx);
			}, remaining);
		}

		// 正文流式输出时：思考状态才正式退场让位！
		const isTextStreaming =
			ev.type === "text_start" ||
			(ev.type === "text_delta" && typeof ev.delta === "string" && ev.delta.trim().length > 0);

		if (isTextStreaming) {
			state.thinkingStatus = "idle";
			stopThinkingTimer();
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

	// 3. 回合执行结束：主要回复已全部生成完成，展示 Completed
	pi.on("turn_end", async (_event, ctx) => {
		stopThinkingTimer();
		state.thinkingStatus = "idle";
		state.completedMessage = "Completed";
		syncWidget(ctx);
	});

	// 4. 工具调用开始：工具常驻加入队列，如果有下一次思考，后续事件会再次激活思考中
	pi.on("tool_call", async (event, ctx) => {
		totalToolCount++;

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

	// 5. 工具调用完成
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

	// 6. 开关控制命令
	pi.registerCommand("rolling-tools", {
		description: "Toggle or check rolling tools widget mode",
		handler: async (args, ctx) => {
			if (args === "off") {
				enabled = false;
				syncWidget(ctx);
				ctx.ui.setStatus("rolling-tools", "Rolling tools disabled");
				setTimeout(() => ctx.ui.setStatus("rolling-tools", undefined), 2000);
			} else if (args === "on") {
				enabled = true;
				syncWidget(ctx);
				ctx.ui.setStatus("rolling-tools", "Rolling tools enabled");
				setTimeout(() => ctx.ui.setStatus("rolling-tools", undefined), 2000);
			} else {
				enabled = !enabled;
				syncWidget(ctx);
				ctx.ui.setStatus("rolling-tools", `Rolling tools: ${enabled ? "enabled" : "disabled"}`);
				setTimeout(() => ctx.ui.setStatus("rolling-tools", undefined), 2000);
			}
		},
	});

	// 7. 注册流控工具：read, bash, grep, find, ls
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

			renderCall(args, theme, context) {
				if (name === "bash") {
					const isSafe = isSafeReadOnlyBashCommand(args?.command);
					if (!context.expanded && isSafe) {
						return new EmptyComponent();
					}
					// 仅渲染单行调用头，绝不包装冗余独立 Box
					const title = theme.fg("toolTitle", theme.bold("$"));
					const cmdDisplay = args?.command?.trim() || "";
					return new Text(`${title} ${theme.fg("accent", truncate(cmdDisplay, 80))}`, 1, 0);
				}

				if (!context.expanded) {
					return new EmptyComponent();
				}
				const title = theme.fg("toolTitle", theme.bold(name));
				const { summaryDisplay } = extractSummaryAndMetadata(name, args, process.cwd());
				return new Text(`${title} ${theme.fg("accent", summaryDisplay)}`, 0, 0);
			},

			renderResult(result, { expanded }, theme, context) {
				// 报错绝不在正文留永久卡片（报错全由 Widget 临时 Alert 负责）
				if (!expanded && result.isError) {
					return new EmptyComponent();
				}

				if (name === "bash") {
					const isSafe = isSafeReadOnlyBashCommand(context?.args?.command);
					if (!expanded && isSafe) {
						return new EmptyComponent();
					}

					// 仅渲染单次输出内容，与 renderCall 顺畅衔接在同一块区域，彻底杜绝重复打两次框！
					const textContent = result.content?.find((c: any) => c.type === "text");
					const raw = textContent?.text || "";
					const maxLines = expanded ? 40 : 5;
					const lines = raw.split("\n").slice(0, maxLines);
					let text = lines.map((l: string) => theme.fg("toolOutput", l)).join("\n");
					if (raw.split("\n").length > maxLines) {
						text += `\n${theme.fg("muted", `... (${raw.split("\n").length - maxLines} more lines)`)}`;
					}
					return new Text(text, 1, 0);
				}

				if (!expanded) {
					return new EmptyComponent();
				}

				const textContent = result.content?.find((c: any) => c.type === "text");
				const raw = textContent?.text || "";
				const lines = raw.split("\n").slice(0, 20);
				let text = lines.map((l: string) => theme.fg("toolOutput", l)).join("\n");
				if (raw.split("\n").length > 20) {
					text += `\n${theme.fg("muted", "... (truncated in expanded view)")}`;
				}
				return new Text(`\n${text}`, 0, 0);
			},
		});
	}
}
