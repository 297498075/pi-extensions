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
}

type LineKind = "header" | "detail_copyable" | "detail_info" | "other";

interface RenderedLineInfo {
	item: ToolItem | null;
	width: number;
	kind: LineKind;
	textToCopy?: string;
}

const MAX_RECENT_TOOLS = 3;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
			pushLine(` ${theme.fg("accent", "🌐")} ${theme.bold(theme.fg("toolTitle", `${spinner} 等待服务器响应...`))} ${theme.fg("muted", `(${elapsedSec}s)`)}`);
		} else if (this.state.headerStatus.type === "thinking") {
			const elapsedSec = ((Date.now() - this.state.headerStatus.startTime) / 1000).toFixed(1);
			const spinner = SPINNER_FRAMES[Math.floor(Date.now() / 150) % SPINNER_FRAMES.length];
			pushLine(` ${theme.fg("accent", "💡")} ${theme.bold(theme.fg("toolTitle", `${spinner} 思考中...`))} ${theme.fg("muted", `(${elapsedSec}s)`)}`);
		} else if (this.state.headerStatus.type === "thinking_completed") {
			const elapsedSec = (this.state.headerStatus.durationMs / 1000).toFixed(1);
			pushLine(` ${theme.fg("accent", "💡")} ${theme.bold(theme.fg("toolTitle", "思考完成"))} ${theme.fg("muted", `(${elapsedSec}s)`)}`);
		}

		// 2. 滚动工具列表
		for (const t of this.state.recentTools) {
			const isExpanded = this.state.expandedItemId === t.id;
			let icon = theme.fg("accent", "⏳");
			if (t.status === "done") icon = theme.fg("success", "✓");
			if (t.status === "error") icon = theme.fg("error", "✗");

			const arrow = isExpanded ? theme.fg("accent", "▾") : theme.fg("dim", "▸");
			const badge = theme.fg("dim", `[${t.index}]`);
			const name = theme.bold(theme.fg("toolTitle", t.name));
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
						pushLine(`   ${theme.fg("dim", `  ... (${t.fullCommand.split("\n").length - 8} more command lines)`)}`, t, "detail_info");
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
							pushLine(`   ${theme.fg("muted", `↳ ${truncate(outLine, 80)}`)}`, t, "detail_copyable", cleanOutput);
						}
						if (outLines.length > maxShow) {
							pushLine(`   ${theme.fg("dim", `  ... (${outLines.length - maxShow} more output lines)`)}`, t, "detail_info");
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
		// 精准判定：必须命中当前行，且 X 坐标落在实际文字渲染宽度之内
		const lineEntry = event.y >= 0 && event.y < this.lineMap.length ? this.lineMap[event.y] : null;
		const isWithinText = Boolean(lineEntry && event.x >= 0 && event.x <= lineEntry.width);
		const targetItem = isWithinText ? lineEntry?.item : null;

		// 鼠标移动不展开详情，杜绝误触发跳变
		if (event.type === "move") {
			return undefined;
		}

		// 鼠标点击（左键或右键）
		if (event.type === "click" && isWithinText && targetItem) {
			// 1. Ctrl + 左键：如果有文件路径，打开文件
			if (event.ctrl && targetItem.fullPath) {
				openFile(targetItem.fullPath);
				return { handled: true };
			}

			// 2. 右键点击：复制内容
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

			// 3. 左键点击详情中的可复制行：复制该内容
			if (lineEntry?.kind === "detail_copyable") {
				const textToCopy =
					lineEntry.textToCopy ||
					targetItem.fullPath ||
					targetItem.fullCommand ||
					targetItem.output;
				if (textToCopy) {
					const label = targetItem.fullPath ? "完整路径" : targetItem.fullCommand ? "完整命令" : "输出内容";
					this.triggerCopy(textToCopy, label);
					return { handled: true };
				}
			}

			// 4. 左键点击标题行（或普通行）：切换展开/折叠状态！
			this.state.expandedItemId = this.state.expandedItemId === targetItem.id ? null : targetItem.id;
			this.tui?.requestRender?.();
			return { handled: true };
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
		expandedItemId: null,
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
		(ctx.ui as any)?.setToolsExpanded?.(false);

		stopStatusTimer();
		state.recentTools = [];
		totalToolCount = 0;
		state.headerStatus = { type: "idle" };
		state.activeError = null;
		state.expandedItemId = null;
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

	// 3. 消息流式事件
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

	// 4. 整个 Agent 任务全部结束（正文生成完毕）后展示 Completed
	pi.on("agent_end", async (_event, ctx) => {
		stopStatusTimer();
		state.headerStatus = { type: "idle" };
		state.completedMessage = "Completed";
		syncWidget(ctx);
	});

	// 5. 工具调用开始：记录进 recentTools 并滚动
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

		if (state.expandedItemId && !state.recentTools.some((t) => t.id === state.expandedItemId)) {
			state.expandedItemId = null;
		}

		syncWidget(ctx);
	});

	// 6. 工具调用完成：记录耗时、状态与输出内容
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
	// 将包括 bash 在内的全部流控工具纳入滚动条机制；edit 与 write 则交由正文 diff 渲染
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
				// 正文中流控工具调用头占用 0 行，完全交由 rolling 滚动条承载
				return new EmptyComponent();
			},

			renderResult(result: any, { expanded }: { expanded: boolean }, theme: any, context?: any) {
				// 折叠状态（默认）：正文中占用 0 行，完全纳入滚动条展示与点击展开
				if (!expanded) {
					return new EmptyComponent();
				}

				// 展开状态（例如用户按 Ctrl+O 展开正文所有工具调用时）
				if (name === "bash") {
					const bgFn = (text: string) =>
						result?.isError ? theme.bg("toolErrorBg", text) : theme.bg("toolSuccessBg", text);
					const box = new Box(1, 1, bgFn);

					const title = theme.fg("toolTitle", theme.bold("$"));
					const rawCmd = typeof context?.args?.command === "string" ? context.args.command.trim() : "";
					box.addChild(new Text(`${title} ${theme.fg("accent", truncate(rawCmd, 80))}`, 0, 0));

					const textContent = (result?.content as any[])?.find((c: any) => c?.type === "text");
					const raw = textContent?.text || "";
					const lines = raw.split("\n").filter((l: string, idx: number, arr: string[]) => idx < arr.length - 1 || l.trim().length > 0);

					if (lines.length === 0) {
						box.addChild(new Text(theme.fg("muted", "↳ (no output)"), 0, 0));
					} else {
						const text = lines.map((l: string) => theme.fg("toolOutput", l)).join("\n");
						box.addChild(new Text(text, 0, 0));
					}

					return box;
				}

				const textContent = (result?.content as any[])?.find((c: any) => c?.type === "text");
				const raw = textContent?.text || "";
				const lines = raw.split("\n").slice(0, 30);
				let text = lines.map((l: string) => theme.fg("toolOutput", l)).join("\n");
				if (raw.split("\n").length > 30) {
					text += `\n${theme.fg("muted", "... (truncated in expanded view)")}`;
				}
				return new Text(`\n${text}`, 0, 0);
			},
		});
	}
}
