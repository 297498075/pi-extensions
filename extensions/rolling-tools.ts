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
import { Container, MouseRegion, Text } from "@earendil-works/pi-tui";

/**
 * Empty TUI component that renders 0 lines in transcript.
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

/**
 * Commands allowed to be silenced (pure read-only queries with no side effects).
 */
const SAFE_READONLY_COMMANDS = new Set([
	"cat", "head", "tail", "more", "less",
	"ls", "dir", "pwd", "cd",
	"grep", "egrep", "fgrep", "find", "sort", "uniq", "wc", "cut",
	"which", "where", "type", "whoami", "uname", "date",
	"echo", "printf",
	"git", "node", "npm", "dotnet", "python", "python3", "pnpm", "yarn",
]);

/**
 * Safe read-only subcommands for git.
 */
const SAFE_GIT_SUBCOMMANDS = new Set([
	"status", "diff", "log", "branch", "show", "tag", "remote", "rev-parse", "describe",
]);

/**
 * Check if a bash command is strictly read-only and safe to silence.
 * Any command with file redirection, file modification, build, execution, or unknown binary will return false.
 */
function isSafeReadOnlyBashCommand(command?: string): boolean {
	if (!command) return false;
	const cmd = command.trim();

	// 1. Any file redirection (> or >> or | tee) is a write operation
	if (/>{1,2}/.test(cmd) || /\btee\b/.test(cmd)) {
		return false;
	}

	// 2. Split compound commands (&&, ||, ;, |)
	const subCommands = cmd.split(/&&|\|\||;|\|/).map((c) => c.trim()).filter(Boolean);
	if (subCommands.length === 0) return false;

	for (const sub of subCommands) {
		// Strip leading environment variable assignments (e.g. "VAR=val cmd")
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
 * Copy text to system clipboard across platforms.
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
 * Wrap text in terminal standard OSC 8 hyperlink escape sequence.
 */
function formatOsc8Link(url: string, text: string): string {
	return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

function truncate(str: string, maxLen = 50): string {
	if (!str) return "";
	if (str.length <= maxLen) return str;
	return str.slice(0, maxLen - 3) + "...";
}

/**
 * Extract display summary and resolve full path if applicable.
 */
function extractSummaryAndPath(
	name: string,
	input: any,
	cwd: string,
): { summaryDisplay: string; fullPath?: string } {
	if (!input || typeof input !== "object") return { summaryDisplay: "" };

	switch (name) {
		case "bash": {
			const cmd = input.command?.split("\n")[0] || "";
			return { summaryDisplay: truncate(cmd, 60) };
		}
		case "read":
		case "edit":
		case "write": {
			const rawPath = input.path || "";
			if (!rawPath) return { summaryDisplay: "" };
			const absPath = resolve(cwd, rawPath);
			const fileUrl = `file:///${absPath.replace(/\\/g, "/")}`;
			const display = truncate(rawPath, 50);
			const linkedDisplay = formatOsc8Link(fileUrl, display);
			return { summaryDisplay: linkedDisplay, fullPath: absPath };
		}
		case "grep": {
			const scope = input.path ? resolve(cwd, input.path) : cwd;
			const fileUrl = `file:///${scope.replace(/\\/g, "/")}`;
			const display = `"${input.pattern || ""}" in ${truncate(input.path || ".", 30)}`;
			return { summaryDisplay: formatOsc8Link(fileUrl, display), fullPath: scope };
		}
		case "find":
			return { summaryDisplay: truncate(input.pattern || "", 50) };
		case "ls": {
			const dirPath = input.path ? resolve(cwd, input.path) : cwd;
			const fileUrl = `file:///${dirPath.replace(/\\/g, "/")}`;
			return { summaryDisplay: formatOsc8Link(fileUrl, truncate(input.path || ".", 40)), fullPath: dirPath };
		}
		default:
			return { summaryDisplay: truncate(JSON.stringify(input), 50) };
	}
}

export default function rollingTools(pi: ExtensionAPI): void {
	const recentTools: ToolItem[] = [];
	let totalToolCount = 0;
	let enabled = true;

	// Thinking state
	let thinkingStatus: "idle" | "thinking" | "completed" = "idle";
	let thinkingStartTime = 0;
	let thinkingDurationMs = 0;

	// Dedicated error alert state
	let activeError: ActiveError | null = null;

	// Latest resolved path for right-click clipboard copy
	let latestFullPath: string | null = null;

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
			(_tui: any, theme: any) => {
				const container = new Container();

				// 1. Thinking block
				if (thinkingStatus === "thinking") {
					const elapsedSec = ((Date.now() - thinkingStartTime) / 1000).toFixed(1);
					const thinkingLine = `${theme.fg("accent", "🧠")} ${theme.bold(theme.fg("toolTitle", "Thinking..."))} ${theme.fg("muted", `(${elapsedSec}s)`)}`;
					container.addChild(new Text(thinkingLine, 1, 0));
				} else if (thinkingStatus === "completed") {
					const elapsedSec = (thinkingDurationMs / 1000).toFixed(1);
					const completedLine = `${theme.fg("accent", "🧠")} ${theme.bold(theme.fg("toolTitle", "Thinking completed"))} ${theme.fg("muted", `(${elapsedSec}s)`)}`;
					container.addChild(new Text(completedLine, 1, 0));
				}

				// 2. Rolling tools queue
				for (const t of recentTools) {
					let icon = theme.fg("accent", "⏳");
					if (t.status === "done") icon = theme.fg("success", "✓");
					if (t.status === "error") icon = theme.fg("error", "✗");

					const badge = theme.fg("dim", `[${t.index}]`);
					const name = theme.bold(theme.fg("toolTitle", t.name));
					const summary = theme.fg("dim", t.summaryDisplay);
					const time = t.durationMs !== undefined ? theme.fg("muted", ` (${t.durationMs}ms)`) : "";

					container.addChild(new Text(`${icon} ${badge} ${name} ${summary}${time}`, 1, 0));
				}

				// 3. Dedicated error alert block
				if (activeError) {
					const errHeader = `${theme.fg("error", "🔴")} ${theme.bold(theme.fg("error", `[Error in #${activeError.index} ${activeError.toolName}]`))} ${theme.fg("dim", activeError.summary)}`;
					const errBody = `   ${theme.fg("error", truncate(activeError.message.replace(/\r?\n/g, " "), 100))}`;
					container.addChild(new Text(errHeader, 1, 0));
					container.addChild(new Text(errBody, 1, 0));
				}

				// MouseRegion: right-click copies full path to clipboard
				return new MouseRegion(container, (event) => {
					if (event.type === "click" && event.button === "right") {
						if (latestFullPath) {
							copyToClipboard(latestFullPath);
							ctx.ui.notify(`已复制完整路径: ${latestFullPath}`, "info");
							return { handled: true };
						}
					}
					return undefined;
				});
			},
			{ placement: "aboveEditor" },
		);
	}

	// Silence the permanent thinking label in transcript completely
	pi.on("session_start", async (_event, ctx) => {
		(ctx.ui as any)?.setHiddenThinkingLabel?.("");
	});

	// 1. Reset on new user prompt
	pi.on("agent_start", async (_event, ctx) => {
		(ctx.ui as any)?.setHiddenThinkingLabel?.("");
		recentTools.length = 0;
		totalToolCount = 0;
		thinkingStatus = "idle";
		thinkingStartTime = 0;
		thinkingDurationMs = 0;
		activeError = null;
		updateWidget(ctx);
	});

	// 2. Stream message updates: track thinking & clear on body text arrival
	pi.on("message_update", async (event, ctx) => {
		const ev = (event as any).assistantMessageEvent;
		if (!ev) return;

		// Thinking lifecycle
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

		// Body text streaming: dismiss tools, thinking, and active errors
		const isTextStreaming =
			ev.type === "text_start" ||
			(ev.type === "text_delta" && typeof ev.delta === "string" && ev.delta.trim().length > 0);

		if (isTextStreaming) {
			thinkingStatus = "idle";
			activeError = null;
			if (recentTools.length > 0) {
				recentTools.length = 0;
			}
			updateWidget(ctx);
		}
	});

	// 3. Tool execution starts
	pi.on("tool_call", async (event, ctx) => {
		totalToolCount++;

		const cwd = ctx?.cwd || process.cwd();
		const { summaryDisplay, fullPath } = extractSummaryAndPath(event.toolName, event.input, cwd);
		if (fullPath) {
			latestFullPath = fullPath;
		}

		recentTools.push({
			id: event.toolCallId,
			index: totalToolCount,
			name: event.toolName,
			summaryDisplay,
			fullPath,
			status: "running",
			startTime: Date.now(),
		});

		if (recentTools.length > MAX_RECENT_TOOLS) {
			recentTools.shift();
		}

		updateWidget(ctx);
	});

	// 4. Tool execution completes
	pi.on("tool_result", async (event, ctx) => {
		const item = recentTools.find((t) => t.id === event.toolCallId);
		if (item) {
			item.status = event.isError ? "error" : "done";
			item.durationMs = Date.now() - item.startTime;
		}

		if (event.isError) {
			// Trigger dedicated error block
			const textContent = (event.content as any[])?.find((c) => c.type === "text");
			const rawError = textContent?.text || "Tool execution failed";
			activeError = {
				toolName: event.toolName,
				index: item?.index ?? totalToolCount,
				summary: item?.summaryDisplay || "",
				message: rawError.trim(),
			};
		} else {
			// Condition: "如果有下一个工具调用正常了，也隐藏掉"
			activeError = null;
		}

		updateWidget(ctx);
	});

	// 5. Command for manual toggle
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

	// 6. Silence pure read tools (read, grep, find, ls) and safe read-only bash commands in transcript.
	// edit and write are NOT registered here (100% handled by pi-tool-display for rich diffs!).
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

	const managedToolNames = ["read", "bash", "grep", "find", "ls"] as const;

	for (const name of managedToolNames) {
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
				// Bash: check allowlist
				if (name === "bash") {
					const isSafe = isSafeReadOnlyBashCommand(args?.command);
					if (!context.expanded && isSafe) {
						return new EmptyComponent();
					}
					// Non-safe mutating bash: OpenCode style call
					const title = theme.fg("toolTitle", theme.bold("$"));
					return new Text(`${title} ${theme.fg("accent", truncate(args?.command || "", 80))}`, 0, 0);
				}

				// Read-only tools (read, grep, find, ls)
				if (!context.expanded) {
					return new EmptyComponent();
				}
				const title = theme.fg("toolTitle", theme.bold(name));
				const { summaryDisplay } = extractSummaryAndPath(name, args, process.cwd());
				return new Text(`${title} ${theme.fg("accent", summaryDisplay)}`, 0, 0);
			},

			renderResult(result, { expanded }, theme, context) {
				// User requirement: Do NOT render errors to permanent transcript!
				// Only display errors temporarily in the rolling block.
				if (!expanded && result.isError) {
					return new EmptyComponent();
				}

				// Bash: check allowlist
				if (name === "bash") {
					const isSafe = isSafeReadOnlyBashCommand(context?.args?.command);
					if (!expanded && isSafe) {
						return new EmptyComponent();
					}
					// Mutating bash command: render output in transcript
					const textContent = result.content?.find((c: any) => c.type === "text");
					const raw = textContent?.text || "";
					const maxLines = expanded ? 40 : 10;
					const lines = raw.split("\n").slice(0, maxLines);
					let text = lines.map((l: string) => theme.fg("toolOutput", l)).join("\n");
					if (raw.split("\n").length > maxLines) {
						text += `\n${theme.fg("muted", `... (${raw.split("\n").length - maxLines} more lines, Ctrl+O to expand)`)}`;
					}
					return new Text(`\n${text}`, 0, 0);
				}

				// Read-only tools (read, grep, find, ls)
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
