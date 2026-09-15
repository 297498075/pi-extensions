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
import { Box, Container, MouseRegion, Text } from "@earendil-works/pi-tui";

/**
 * 空组件：在正文中占用 0 行
 */
class EmptyComponent {
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

const MAX_RECENT_TOOLS = 3;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MIN_THINKING_DISPLAY_MS = 1500; // 保证思考状态最少可见 1.5 秒

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

export default function rollingTools(pi: ExtensionAPI): void {
	const recentTools: ToolItem[] = [];
	let totalToolCount = 0;
	let enabled = true;

	// Thinking 状态
	let isThinking = false;
	let thinkingStartTime = 0;
	let thinkingTimer: any = null;

	// 临时报错状态
	let activeError: ActiveError | null = null;

	// 悬停交互与复制提示状态
	let hoveredItemId: string | null = null;
	let copyFeedbackMessage: string | null = null;
	let copyFeedbackTimer: any = null;

	function stopThinkingTimer(): void {
		if (thinkingTimer) {
			clearInterval(thinkingTimer);
			thinkingTimer = null;
		}
	}

	function updateWidget(ctx: any): void {
		if (!ctx?.hasUI) return;

		const hasContent =
			enabled &&
			(isThinking || recentTools.length > 0 || activeError !== null);

		if (!hasContent) {
			ctx.ui.setWidget("rolling-tools", undefined);
			return;
		}

		ctx.ui.setWidget(
			"rolling-tools",
			(tui: any, theme: any) => {
				const container = new Container();

				// 1. Thinking 状态块：仅在进行中展示动画与秒表，思考结束后不展示任何完成标签
				if (isThinking) {
					const elapsedSec = ((Date.now() - thinkingStartTime) / 1000).toFixed(1);
					const spinner = SPINNER_FRAMES[Math.floor(Date.now() / 150) % SPINNER_FRAMES.length];
					const thinkingLine = `${theme.fg("accent", "💡")} ${theme.bold(theme.fg("toolTitle", `${spinner} 思考中...`))} ${theme.fg("muted", `(${elapsedSec}s)`)}`;
					container.addChild(new Text(thinkingLine, 1, 0));
				}

				// 2. 滚动工具列表（移除所有颜色高亮，保持文字外观稳定）
				const hoveredItem = hoveredItemId ? recentTools.find((t) => t.id === hoveredItemId) : null;

				for (const t of recentTools) {
					let icon = theme.fg("accent", "⏳");
					if (t.status === "done") icon = theme.fg("success", "✓");
					if (t.status === "error") icon = theme.fg("error", "✗");

					const badge = theme.fg("dim", `[${t.index}]`);
					const name = theme.bold(theme.fg("toolTitle", t.name));
					const summary = theme.fg("dim", t.summaryDisplay);
					const time = t.durationMs !== undefined ? theme.fg("muted", ` (${t.durationMs}ms)`) : "";

					const lineText = `${icon} ${badge} ${name} ${summary}${time}`;
					const textComponent = new Text(lineText, 1, 0);

					const mouseRegion = new MouseRegion(textComponent, (event) => {
						// 鼠标移入：仅展示 Tips 提示行，不改变本行颜色高亮
						if (event.type === "move") {
							if (hoveredItemId !== t.id) {
								hoveredItemId = t.id;
								tui.requestRender();
							}
							return { handled: true };
						}

						// 鼠标点击
						if (event.type === "click") {
							// Ctrl + 左键：打开文件
							if (event.ctrl && t.fullPath) {
								openFile(t.fullPath);
								ctx.ui.setStatus("clipboard", theme.fg("accent", `正在打开文件: ${truncate(t.fullPath, 40)}`));
								setTimeout(() => ctx.ui.setStatus("clipboard", undefined), 2500);
								return { handled: true };
							}

							// 左右键点击：复制文件完整路径或完整命令（绝不向正文输出任何文字！）
							const textToCopy = t.fullPath || t.fullCommand;
							if (textToCopy) {
								copyToClipboard(textToCopy);
								const label = t.fullPath ? "完整路径" : "完整命令";
								copyFeedbackMessage = `✓ 已复制${label}至剪贴板: ${truncate(textToCopy, 45)}`;

								ctx.ui.setStatus("clipboard", theme.fg("success", `✓ 已复制${label}到剪贴板`));

								if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
								copyFeedbackTimer = setTimeout(() => {
									copyFeedbackMessage = null;
									ctx.ui.setStatus("clipboard", undefined);
									tui.requestRender();
								}, 2500);

								tui.requestRender();
								return { handled: true };
							}
						}

						return undefined;
					});

					container.addChild(mouseRegion);
				}

				// 3. 悬停提示面板（仅在鼠标移入时展开展示完整路径或完整多行命令）
				if (hoveredItem) {
					if (hoveredItem.fullPath) {
						container.addChild(new Text(theme.fg("dim", "  ↳ 提示: [左右键点击] 复制路径 · [Ctrl+左键] 打开文件"), 1, 0));
						container.addChild(new Text(theme.fg("accent", `    ${hoveredItem.fullPath}`), 1, 0));
					} else if (hoveredItem.fullCommand) {
						container.addChild(new Text(theme.fg("dim", "  ↳ 提示: [左右键点击] 复制完整命令:"), 1, 0));
						const cmdLines = hoveredItem.fullCommand.split("\n").slice(0, 8);
						for (const cmdLine of cmdLines) {
							container.addChild(new Text(theme.fg("accent", `    ${cmdLine}`), 1, 0));
						}
					}
				}

				// 4. 复制成功内嵌反馈（在 Widget 内部优雅淡入淡出，0 污染正文）
				if (copyFeedbackMessage) {
					container.addChild(new Text(theme.fg("success", `  ↳ ${copyFeedbackMessage}`), 1, 0));
				}

				// 5. 独立临时报错 Alert 块
				if (activeError) {
					const errHeader = `${theme.fg("error", "🔴")} ${theme.bold(theme.fg("error", `[Error in #${activeError.index} ${activeError.toolName}]`))} ${theme.fg("dim", activeError.summary)}`;
					const errBody = `   ${theme.fg("error", truncate(activeError.message.replace(/\r?\n/g, " "), 100))}`;
					container.addChild(new Text(errHeader, 1, 0));
					container.addChild(new Text(errBody, 1, 0));
				}

				return container;
			},
			{ placement: "aboveEditor" },
		);
	}

	// 1. 用户提问（新一轮交互开始）时重置所有状态
	pi.on("agent_start", async (_event, ctx) => {
		stopThinkingTimer();
		recentTools.length = 0;
		totalToolCount = 0;
		isThinking = false;
		thinkingStartTime = 0;
		activeError = null;
		hoveredItemId = null;
		copyFeedbackMessage = null;
		updateWidget(ctx);
	});

	// 2. 消息流式事件：
	// - 保证思考过程最少可见 1.5 秒，结束后不展示任何完成标签
	// - 过滤正文中的 thinking 块，消除占位符与空行
	pi.on("message_update", async (event, ctx) => {
		if (event.message?.role === "assistant" && Array.isArray(event.message.content)) {
			event.message.content = event.message.content.filter((c: any) => c.type !== "thinking");
		}

		const ev = (event as any).assistantMessageEvent;
		if (!ev) return;

		// 收到思考事件：开启状态与 100ms 刷新时钟
		if (ev.type === "thinking_start" || ev.type === "thinking_delta") {
			if (!isThinking) {
				isThinking = true;
				thinkingStartTime = Date.now();
				stopThinkingTimer();
				thinkingTimer = setInterval(() => {
					updateWidget(ctx);
				}, 100);
				updateWidget(ctx);
			}
		} else if (ev.type === "thinking_end") {
			// 保证思考动画至少展示 MIN_THINKING_DISPLAY_MS，避免一闪而过
			const elapsed = Date.now() - thinkingStartTime;
			const remaining = Math.max(0, MIN_THINKING_DISPLAY_MS - elapsed);
			setTimeout(() => {
				isThinking = false;
				stopThinkingTimer();
				updateWidget(ctx);
			}, remaining);
		}

		// 正文流式输出时：停止思考，不显示思考完成，工具列表保持常驻
		const isTextStreaming =
			ev.type === "text_start" ||
			(ev.type === "text_delta" && typeof ev.delta === "string" && ev.delta.trim().length > 0);

		if (isTextStreaming) {
			isThinking = false;
			stopThinkingTimer();
			activeError = null;
			updateWidget(ctx);
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

	// 3. 工具调用开始：停止思考状态，工具入队
	pi.on("tool_call", async (event, ctx) => {
		totalToolCount++;
		isThinking = false;
		stopThinkingTimer();

		const cwd = ctx?.cwd || process.cwd();
		const { summaryDisplay, fullPath, fullCommand } = extractSummaryAndMetadata(event.toolName, event.input, cwd);

		recentTools.push({
			id: event.toolCallId,
			index: totalToolCount,
			name: event.toolName,
			summaryDisplay,
			fullPath,
			fullCommand,
			status: "running",
			startTime: Date.now(),
		});

		if (recentTools.length > MAX_RECENT_TOOLS) {
			recentTools.shift();
		}

		updateWidget(ctx);
	});

	// 4. 工具调用结束
	pi.on("tool_result", async (event, ctx) => {
		const item = recentTools.find((t) => t.id === event.toolCallId);
		if (item) {
			item.status = event.isError ? "error" : "done";
			item.durationMs = Date.now() - item.startTime;
		}

		if (event.isError) {
			const textContent = (event.content as any[])?.find((c) => c.type === "text");
			const rawError = textContent?.text || "Tool execution failed";
			activeError = {
				toolName: event.toolName,
				index: item?.index ?? totalToolCount,
				summary: item?.summaryDisplay || "",
				message: rawError.trim(),
			};
		} else {
			activeError = null;
		}

		updateWidget(ctx);
	});

	// 5. 开关控制命令
	pi.registerCommand("rolling-tools", {
		description: "Toggle or check rolling tools widget mode",
		handler: async (args, ctx) => {
			if (args === "off") {
				enabled = false;
				updateWidget(ctx);
				ctx.ui.setStatus("rolling-tools", "Rolling tools disabled");
				setTimeout(() => ctx.ui.setStatus("rolling-tools", undefined), 2000);
			} else if (args === "on") {
				enabled = true;
				updateWidget(ctx);
				ctx.ui.setStatus("rolling-tools", "Rolling tools enabled");
				setTimeout(() => ctx.ui.setStatus("rolling-tools", undefined), 2000);
			} else {
				enabled = !enabled;
				updateWidget(ctx);
				ctx.ui.setStatus("rolling-tools", `Rolling tools: ${enabled ? "enabled" : "disabled"}`);
				setTimeout(() => ctx.ui.setStatus("rolling-tools", undefined), 2000);
			}
		},
	});

	// 6. 注册管理工具：read, bash, grep, find, ls
	// edit 和 write 绝不注册，100% 留给 pi-tool-display 呈现 OpenCode 风格！
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
					// 非只读/变更型 Bash：以标准 Box 包裹呈现 OpenCode 风格
					const box = new Box(1, 1, (s) => theme.bg("toolPendingBg", s));
					const title = theme.fg("toolTitle", theme.bold("$"));
					const cmdDisplay = args?.command?.trim() || "";
					box.addChild(new Text(`${title} ${theme.fg("accent", truncate(cmdDisplay, 80))}`, 0, 0));
					return box;
				}

				if (!context.expanded) {
					return new EmptyComponent();
				}
				const title = theme.fg("toolTitle", theme.bold(name));
				const { summaryDisplay } = extractSummaryAndMetadata(name, args, process.cwd());
				return new Text(`${title} ${theme.fg("accent", summaryDisplay)}`, 0, 0);
			},

			renderResult(result, { expanded }, theme, context) {
				// 报错绝不写入正文永久块（全由 Widget 临时 Alert 负责）
				if (!expanded && result.isError) {
					return new EmptyComponent();
				}

				if (name === "bash") {
					const isSafe = isSafeReadOnlyBashCommand(context?.args?.command);
					if (!expanded && isSafe) {
						return new EmptyComponent();
					}

					// 变更型命令执行结果：以标准 Box 呈现 OpenCode 样式
					const box = new Box(1, 1, (s) => theme.bg("toolSuccessBg", s));
					const title = theme.fg("toolTitle", theme.bold("$"));
					const cmdDisplay = context?.args?.command?.trim() || "";
					box.addChild(new Text(`${title} ${theme.fg("accent", truncate(cmdDisplay, 80))}`, 0, 0));

					const textContent = result.content?.find((c: any) => c.type === "text");
					const raw = textContent?.text || "";
					const maxLines = expanded ? 40 : 5;
					const lines = raw.split("\n").slice(0, maxLines);
					let text = lines.map((l: string) => theme.fg("toolOutput", l)).join("\n");
					if (raw.split("\n").length > maxLines) {
						text += `\n${theme.fg("muted", `... (${raw.split("\n").length - maxLines} more lines)`)}`;
					}
					box.addChild(new Text(text, 0, 0));
					return box;
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
