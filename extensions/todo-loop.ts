import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
			item.status !== "completed"
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

function explicitlyCannotContinue(message: unknown): boolean {
	const text = assistantText(message);
	if (!text) return false;

	return (
		/\b(?:i\s+)?(?:can(?:not|'t)|am\s+unable\s+to|unable\s+to)\s+(?:continue|proceed|complete|finish)\b/i.test(text) ||
		/(?:无法|不能|没法|做不到)\s*(?:再)?\s*(?:继续|完成|推进|进行(?:下去)?)/.test(text)
	);
}

export default function todoLoop(pi: ExtensionAPI): void {
	pi.on("agent_end", (event, ctx) => {
		// Pi will handle its own retry or compaction retry; wait for that first.
		if ((event as typeof event & { willRetry?: boolean }).willRetry) return;
		if (ctx.hasPendingMessages()) return;

		const state = latestTodoState(ctx);
		if (!state || state.remaining === 0) return;

		const lastAssistant = [...event.messages].reverse().find((message) => assistantText(message) !== undefined);
		if (explicitlyCannotContinue(lastAssistant)) return;

		// ponytail: intentionally unbounded by request; add a retry budget if runaway loops become a problem.
		pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "followUp" });
	});
}
