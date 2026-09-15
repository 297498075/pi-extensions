import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
} from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, Text } from "@earendil-works/pi-tui";

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
	let thinkingStatus: "idle" | "thinking" | "completed" = "idle";
	let thinkingStartTime = 0;
	let thinkingDurationMs = 0;

	// 临时报错状态
	let activeError: ActiveError | null = null;

	// 鼠标悬停聚焦的 Tool ID
	let hoveredItemId: string | null = null;

	function updateWidget(ctx: any): void {
		if (!ctx?.hasUI) return;

		const hasContent =
			enabled &&
			(thinkingStatus !== "idle" || recentTools.length > 0 || activeError !== null);

		if (!hasContent) {
			ctx.ui.setWidget("rolling-tools", undefined);
			return;
		}

		ctx.ui.setWidget(
			"rolling-tools",
			(tui: any, theme: any) => {
				const container = new Container();

				// 1. Thinking 块（使用温和的 💡 图标与动态状态）
				if (thinkingStatus === "thinking") {
					const elapsedSec = ((Date.now() - thinkingStartTime) / 1000).toFixed(1);
					const spinner = SPINNER_FRAMES[Math.floor(Date.now() / 150) % SPINNER_FRAMES.length];
					const thinkingLine = `${theme.fg("accent", "💡")} ${theme.bold(theme.fg("toolTitle", `${spinner} 思考中...`))} ${theme.fg("muted", `(${elapsedSec}s)`)}`;
					container.addChild(new Text(thinkingLine, 1, 0));
				} else if (thinkingStatus === "completed") {
					const elapsedSec = (thinkingDurationMs / 1000).toFixed(1);
					const completedLine = `${theme.fg("accent", "💡")} ${theme.bold(theme.fg("toolTitle", "思考完成"))} ${theme.fg("muted", `(${elapsedSec}s)`)}`;
					container.addChild(new Text(completedLine, 1, 0));
				}

				// 找到当前悬停的项目
				const hoveredItem = hoveredItemId ? recentTools.find((t) => t.id === hoveredItemId) : null;

				// 2. 滚动工具队列（每行包裹专属 MouseRegion，支持悬停高亮与点击）
				for (const t of recentTools) {
					const isHovered = t.id === hoveredItemId;
					let icon = theme.fg("accent", "⏳");
					if (t.status === "done") icon = theme.fg("success", "✓");
					if (t.status === "error") icon = theme.fg("error", "✗");

					const badge = theme.fg("dim", `[${t.index}]`);
					const name = isHovered
						? theme.bold(theme.fg("accent", t.name))
						: theme.bold(theme.fg("toolTitle", t.name));
					const summary = isHovered
						? theme.underline(theme.fg("accent", t.summaryDisplay))
						: theme.fg("dim", t.summaryDisplay);
					const time = t.durationMs !== undefined ? theme.fg("muted", ` (${t.durationMs}ms)`) : "";

					const lineText = `${icon} ${badge} ${name} ${summary}${time}`;
					const textComponent = new Text(lineText, 1, 0);

					const mouseRegion = new MouseRegion(textComponent, (event) => {
						// 鼠标移动到当前项：设置悬停并触发局部重绘
						if (event.type === "move") {
							if (hoveredItemId !== t.id) {
								hoveredItemId = t.id;
								tui.requestRender();
							}
							return { handled: true };
						}

						// 鼠标点击（左键或右键）
						if (event.type === "click") {
							// Ctrl + 左键：打开文件
							if (event.ctrl && t.fullPath) {
								openFile(t.fullPath);
								ctx.ui.notify(`正在打开文件: ${t.fullPath}`, "info");
								return { handled: true };
							}

							// 左右键点击：复制文件路径或完整命令
							const textToCopy = t.fullPath || t.fullCommand;
							if (textToCopy) {
								copyToClipboard(textToCopy);
								const label = t.fullPath ? "完整路径" : "完整命令";
								ctx.ui.notify(`已复制${label}至剪贴板`, "info");
								return { handled: true };
							}
						}

						return undefined;
					});

					container.addChild(mouseRegion);
				}

				// 3. 悬停专属 Tips 展开面板（展示完整路径或多行完整命令）
				if (hoveredItem) {
					if (hoveredItem.fullPath) {
						container.addChild(new Text(theme.fg("dim", "  ↳ 提示: [左右键点击] 复制路径 · [Ctrl+左键] 打开文件"), 1, 0));
						container.addChild(new Text(theme.fg("accent", `    ${hoveredItem.fullPath}`), 1, 0));
					} else if (hoveredItem.fullCommand) {
						container.addChild(new Text(theme.fg("dim", "  ↳ 提示: [左右键点击] 复制完整命令:"), 1, 0));
						const cmdLines = hoveredItem.fullCommand.split("\n").slice(0, 10);
						for (const cmdLine of cmdLines) {
							container.addChild(new Text(theme.fg("accent", `    ${cmdLine}`), 1, 0));
						}
					}
				}

				// 4. 独立临时报错 Alert 块
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

	// 1. 新用户交互开始时重置
	pi.on("agent_start", async (_event, ctx) => {
		recentTools.length = 0;
		totalToolCount = 0;
		thinkingStatus = "idle";
		thinkingStartTime = 0;
		thinkingDurationMs = 0;
		activeError = null;
		hoveredItemId = null;
		updateWidget(ctx);
	});

	// 2. 消息流式事件：
	// - 驱动 Thinking 状态机
	// - 【核心修复】过滤掉正文中的 thinking 块，彻底消除占位符与空行！
	pi.on("message_update", async (event, ctx) => {
		// 过滤正文中的 thinking content 块，让正文彻底不生成 Thinking 占位与空白行
		if (event.message?.role === "assistant" && Array.isArray(event.message.content)) {
			event.message.content = event.message.content.filter((c: any) => c.type !== "thinking");
		}

		const ev = (event as any).assistantMessageEvent;
		if (!ev) return;

		// 思考生命周期
		if (ev.type === "thinking_start") {
			thinkingStatus = "thinking";
			thinkingStartTime = Date.now();
			updateWidget(ctx);
		} else if (ev.type === "thinking_delta") {
			if (thinkingStatus !== "thinking") {
				thinkingStatus = "thinking";
				thinkingStartTime = thinkingStartTime || Date.now();
			}
			updateWidget(ctx);
		} else if (ev.type === "thinking_end") {
			thinkingStatus = "completed";
			thinkingDurationMs = Date.now() - (thinkingStartTime || Date.now());
			updateWidget(ctx);
		}

		// 正文文字开始输出：淡出收起所有 Widget 面板
		const isTextStreaming =
			ev.type === "text_start" ||
			(ev.type === "text_delta" && typeof ev.delta === "string" && ev.delta.trim().length > 0);

		if (isTextStreaming) {
			thinkingStatus = "idle";
			activeError = null;
			hoveredItemId = null;
			if (recentTools.length > 0) {
				recentTools.length = 0;
			}
			updateWidget(ctx);
		}
	});

	// 消息结束时，同样保持正文清洁，过滤掉 thinking content 块
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

	// 3. 工具开始调用
	pi.on("tool_call", async (event, ctx) => {
		totalToolCount++;

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

	// 4. 工具调用完成
	pi.on("tool_result", async (event, ctx) => {
		const item = recentTools.find((t) => t.id === event.toolCallId);
		if (item) {
			item.status = event.isError ? "error" : "done";
			item.durationMs = Date.now() - item.startTime;
		}

		if (event.isError) {
			// 临时报错块：仅在 Widget 中弹红框
			const textContent = (event.content as any[])?.find((c) => c.type === "text");
			const rawError = textContent?.text || "Tool execution failed";
			activeError = {
				toolName: event.toolName,
				index: item?.index ?? totalToolCount,
				summary: item?.summaryDisplay || "",
				message: rawError.trim(),
			};
		} else {
			// 下一个工具成功时，报错块自愈销毁
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
				ctx.ui.notify("Rolling tools disabled", "info");
			} else if (args === "on") {
				enabled = true;
				updateWidget(ctx);
				ctx.ui.notify("Rolling tools enabled", "info");
			} else {
				enabled = !enabled;
				updateWidget(ctx);
				ctx.ui.notify(`Rolling tools: ${enabled ? "enabled" : "disabled"}`, "info");
			}
		},
	});

	// 6. 仅在正文中静音枯燥只读的 read, grep, find, ls！
	// 【注意】：bash, edit, write 绝不接管！100% 交还给 pi-tool-display 进行原汁原味的 OpenCode 渲染！
	const toolCache = new Map<string, any>();
	function getTools(cwd: string) {
		let tools = toolCache.get(cwd);
		if (!tools) {
			tools = {
				read: createReadTool(cwd),
				grep: createGrepTool(cwd),
				find: createFindTool(cwd),
				ls: createLsTool(cwd),
			};
			toolCache.set(cwd, tools);
		}
		return tools;
	}

	const readOnlyTools = ["read", "grep", "find", "ls"] as const;

	for (const name of readOnlyTools) {
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
				// 折叠状态下占用 0 行
				if (!context.expanded) {
					return new EmptyComponent();
				}
				const title = theme.fg("toolTitle", theme.bold(name));
				const { summaryDisplay } = extractSummaryAndMetadata(name, args, process.cwd());
				return new Text(`${title} ${theme.fg("accent", summaryDisplay)}`, 0, 0);
			},

			renderResult(result, { expanded }, theme) {
				// 折叠状态下哪怕报错也不在正文留永久卡片（报错全由 Widget 负责）
				if (!expanded) {
					return new EmptyComponent();
				}

				// 展开时正常查看详情
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
