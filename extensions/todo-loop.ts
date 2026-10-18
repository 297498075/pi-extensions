import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_MAX_FOLLOWUPS = 20;
const MAX_FOLLOWUPS_FLAG = "todo-loop-max-followups";

const CONTINUE_PROMPT =
	"Continue working on the remaining todo items. Start with the first unfinished item, update the todo list as you progress, and do not stop while any todo remains unfinished. If you truly cannot continue, explicitly say that you cannot continue.";

interface TodoState {
	remaining: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function remainingTodos(value: unknown): number | undefined {
	if (!Array.isArray(value) || value.some((item) => !isRecord(item))) return undefined;

	return value.filter((item) => {
		return (
			item.status !== "deleted" &&
			item.done !== true &&
			item.completed !== true &&
			item.status !== "done" &&
			item.status !== "completed" &&
			item.status !== "cancelled"
		);
	}).length;
}

function latestTodoState(ctx: ExtensionContext): TodoState | undefined {
	let state: TodoState | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "toolResult") {
			if (entry.message.toolName !== "todo" && entry.message.toolName !== "todos") continue;
			const details = isRecord(entry.message.details) ? entry.message.details : undefined;
			const remaining = remainingTodos(details?.tasks ?? details?.todos);
			if (remaining !== undefined) state = { remaining };
		}

		if (entry.type === "custom" && entry.customType === "todo-tree-state") {
			const data = isRecord(entry.data) ? entry.data : undefined;
			const remaining = remainingTodos(data?.tasks);
			if (remaining !== undefined) state = { remaining: data?.enabled === false ? 0 : remaining };
		}

		if (entry.type === "custom" && entry.customType === "plan-mode") {
			const data = isRecord(entry.data) ? entry.data : undefined;
			if (data?.executing !== true) continue;
			const remaining = remainingTodos(data.todos);
			if (remaining !== undefined) state = { remaining };
		}
	}

	return state;
}

function assistantText(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;

	return message.content
		.filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.join("\n");
}

function userText(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return undefined;

	return message.content
		.filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.join("\n");
}

function followupCount(ctx: ExtensionContext): number {
	return [...ctx.sessionManager.getBranch()].filter(
		(entry) => (entry.type === "message" && userText(entry.message) === CONTINUE_PROMPT) ||
			(entry.type === "custom_message" && entry.customType === "todo-loop-followup"),
	).length;
}

function maxFollowups(pi: ExtensionAPI): number {
	const value = pi.getFlag(MAX_FOLLOWUPS_FLAG);
	const max = typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isSafeInteger(max) && max >= 0 ? max : DEFAULT_MAX_FOLLOWUPS;
}

function operationAborted(message: unknown): boolean {
	if (!isRecord(message) || message.role !== "assistant") return false;
	if (message.stopReason === "aborted") return true;

	const details = [assistantText(message), message.errorMessage]
		.filter((value): value is string => typeof value === "string")
		.join("\n");
	return /\boperation aborted\b/i.test(details);
}

function explicitlyCannotContinue(message: unknown): boolean {
	const text = assistantText(message);
	if (!text) return false;

	return (
		/\b(?:i\s+)?(?:can(?:not|'t)|am\s+unable\s+to|unable\s+to)\s+(?:continue|proceed|complete|finish)\b/i.test(text) ||
		/(?:无法|不能|没法|做不到)\s*(?:再)?\s*(?:继续|完成|推进|进行(?:下去)?)/.test(text)
	);
}

export default function todoLoop(pi: ExtensionAPI): void {
	pi.registerFlag(MAX_FOLLOWUPS_FLAG, {
		description: "Maximum automatic todo follow-ups (0 disables)",
		type: "string",
		default: String(DEFAULT_MAX_FOLLOWUPS),
	});

	let limitNotified = false;

	pi.on("session_start", () => { limitNotified = false; });

	// This actionable boundary runs only AFTER core retries, compaction and
	// queued work. agent_end's extension event does not contain willRetry.
	pi.on("agent_before_settle", (event, ctx) => {
		if (event.outcome !== "completed" || ctx.hasPendingMessages()) return;

		const state = latestTodoState(ctx);
		if (!state || state.remaining === 0) return;

		const lastAssistant = [...event.context.contextMessages].reverse().find((message) => assistantText(message) !== undefined);
		if (operationAborted(lastAssistant) || (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "error")) return;
		if (explicitlyCannotContinue(lastAssistant)) return;

		const used = followupCount(ctx);
		const limit = maxFollowups(pi);
		if (used >= limit) {
			if (!limitNotified) {
				ctx.ui.notify(`todo-loop stopped after ${limit} automatic follow-ups`, "warning");
				limitNotified = true;
			}
			return;
		}

		// Commit the prompt at the boundary, rather than fire-and-forget an async
		// input pipeline. Adding a context message makes an assistant-ended
		// transcript continuable (canContinue is normally false before this).
		return {
			entries: [...event.entries, {
				type: "custom_message" as const,
				customType: "todo-loop-followup",
				content: CONTINUE_PROMPT,
				display: true,
			}],
			continue: true,
		};
	});
}
