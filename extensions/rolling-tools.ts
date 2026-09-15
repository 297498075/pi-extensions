import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

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
	summary: string;
	status: "running" | "done" | "error";
	durationMs?: number;
	startTime: number;
}

const MAX_RECENT_TOOLS = 3;

export default function rollingTools(pi: ExtensionAPI): void {
	const recentTools: ToolItem[] = [];
	let totalToolCount = 0;
	let enabled = true;

	function extractSummary(name: string, input: any): string {
		if (!input || typeof input !== "object") return "";
		switch (name) {
			case "bash":
				return input.command?.split("\n")[0] || "";
			case "read":
			case "edit":
			case "write":
				return input.path || "";
			case "grep":
				return `"${input.pattern || ""}" in ${input.path || "."}`;
			case "find":
				return input.pattern || "";
			case "ls":
				return input.path || ".";
			default:
				return JSON.stringify(input);
		}
	}

	function truncate(str: string, maxLen = 60): string {
		if (!str) return "";
		if (str.length <= maxLen) return str;
		return str.slice(0, maxLen - 3) + "...";
	}

	function updateWidget(ctx: any): void {
		if (!ctx.hasUI) return;

		if (!enabled || recentTools.length === 0) {
			ctx.ui.setWidget("rolling-tools", undefined);
			return;
		}

		const theme = ctx.ui.theme;
		const lines = recentTools.map((t) => {
			let icon = theme.fg("accent", "⏳");
			if (t.status === "done") icon = theme.fg("success", "✓");
			if (t.status === "error") icon = theme.fg("error", "✗");

			const badge = theme.fg("dim", `[${t.index}]`);
			const name = theme.bold(theme.fg("toolTitle", t.name));
			const summary = theme.fg("dim", truncate(t.summary));
			const time = t.durationMs !== undefined ? theme.fg("muted", ` (${t.durationMs}ms)`) : "";

			return `${icon} ${badge} ${name} ${summary}${time}`;
		});

		ctx.ui.setWidget("rolling-tools", lines, { placement: "aboveEditor" });
	}

	pi.on("agent_start", async (_event, ctx) => {
		recentTools.length = 0;
		totalToolCount = 0;
		updateWidget(ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		const ev = (event as any).assistantMessageEvent;
		if (!ev) return;

		const isTextStreaming =
			ev.type === "text_start" ||
			(ev.type === "text_delta" && typeof ev.delta === "string" && ev.delta.trim().length > 0);

		if (isTextStreaming && recentTools.length > 0) {
			recentTools.length = 0;
			updateWidget(ctx);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		totalToolCount++;
		const summary = extractSummary(event.toolName, event.input);

		recentTools.push({
			id: event.toolCallId,
			index: totalToolCount,
			name: event.toolName,
			summary,
			status: "running",
			startTime: Date.now(),
		});

		if (recentTools.length > MAX_RECENT_TOOLS) {
			recentTools.shift();
		}

		updateWidget(ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		const item = recentTools.find((t) => t.id === event.toolCallId);
		if (item) {
			item.status = event.isError ? "error" : "done";
			item.durationMs = Date.now() - item.startTime;
		}
		updateWidget(ctx);
	});

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

	const readAndExecTools = ["read", "bash", "grep", "find", "ls"] as const;

	for (const name of readAndExecTools) {
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
				if (!context.expanded) {
					return new EmptyComponent();
				}
				const title = theme.fg("toolTitle", theme.bold(name));
				const summary = extractSummary(name, args);
				return new Text(`${title} ${theme.fg("accent", summary)}`, 0, 0);
			},

			renderResult(result, { expanded }, theme) {
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
