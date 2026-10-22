import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { showStatusModal } from "./lib/status-modal.ts";

const DEFAULT_MAX_FOLLOWUPS = 20;
const MAX_FOLLOWUPS_FLAG = "todo-loop-max-followups";
const CONTROL_TOOL = "todo_loop_control";
const DECISION_ENTRY = "todo-loop-decision";

// Keep recognizing old user-message follow-ups without inspecting assistant prose.
const LEGACY_CONTINUE_PROMPT =
	"Continue working on the remaining todo items. Start with the first unfinished item, update the todo list as you progress, and do not stop while any todo remains unfinished. If you truly cannot continue, explicitly say that you cannot continue.";
const CONTINUE_PROMPT =
	"Continue working on the remaining actionable todo items and update the todo list as you progress. " +
	"Use todo_loop_control status to inspect actionable task IDs and registered blockers. " +
	"If a task truly requires user input, access, or an external dependency, use todo_loop_control report_blocker with taskIds, category, reason and resumeWhen; continue other unblocked tasks. " +
	"Do not mark blocked tasks completed or cancelled. A summary or a statement that you cannot continue does not pause the loop.";

interface Task {
	id: string;
	parentId?: string;
	subject: string;
	revision: string;
}

interface Blocker {
	taskId: string;
	revision: string;
	category: string;
	reason: string;
	resumeWhen: string;
}

interface TodoState {
	tasks: Task[];
	blockers: Map<string, Blocker>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function unfinished(item: Record<string, unknown>): boolean {
	return item.status !== "deleted" && item.done !== true && item.completed !== true &&
		item.status !== "done" && item.status !== "completed" && item.status !== "cancelled";
}

function taskId(value: unknown): string | undefined {
	return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function taskRevision(item: Record<string, unknown>, source: string): string {
	const record = { ...item };
	// todo-tree tool results add these aliases, while custom snapshots omit
	// them. All records here are already unfinished, so the aliases are redundant.
	delete record.done;
	delete record.completed;
	const canonical = JSON.stringify([source, record], (_key, value: unknown) =>
		isRecord(value) && !Array.isArray(value)
			? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
			: value,
	);
	return createHash("sha256").update(canonical).digest("hex");
}

function parseTasks(value: unknown, source: string): Task[] | undefined {
	if (!Array.isArray(value) || value.some((item) => !isRecord(item))) return undefined;
	return value.flatMap((item: Record<string, unknown>, index) => unfinished(item) ? [{
		id: taskId(item.id) ?? `@${index + 1}`,
		parentId: taskId(item.parentId),
		subject: String(item.subject ?? item.text ?? item.description ?? "Untitled task"),
		revision: taskRevision(item, source),
	}] : []);
}

function userText(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return undefined;
	return message.content
		.filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
		.map((block) => typeof block.text === "string" ? block.text : "")
		.join("\n");
}

// Reconstruct exclusively from the active branch. Successful tool-result details
// are the durable control protocol; quoted JSON, assistant text and failed calls
// cannot mutate it. No in-memory blocker cache can leak across forks or reloads.
function latestTodoState(ctx: ExtensionContext, drafts: readonly SessionBoundaryDraft[] = []): TodoState | undefined {
	let state: TodoState | undefined;
	for (const entry of [...ctx.sessionManager.getBranch(), ...drafts]) {
		let tasks: Task[] | undefined;
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "user" && userText(message) !== LEGACY_CONTINUE_PROMPT) state?.blockers.clear();
			if (message.role !== "toolResult" || message.isError) continue;
			const details = isRecord(message.details) ? message.details : undefined;
			if (message.toolName === "todo" || message.toolName === "todos") {
				tasks = parseTasks(details?.tasks ?? details?.todos, "todo");
			}
			if (message.toolName === CONTROL_TOOL && details?.version === 1 && state) {
				if (details.action === "clear_blocker" && Array.isArray(details.taskIds)) {
					for (const id of details.taskIds) if (typeof id === "string") state.blockers.delete(id);
				}
				if (details.action === "report_blocker" && Array.isArray(details.blockers)) {
					for (const blocker of details.blockers) {
						if (!isRecord(blocker) || typeof blocker.taskId !== "string" ||
							typeof blocker.revision !== "string" || typeof blocker.category !== "string" ||
							typeof blocker.reason !== "string" || !blocker.reason.trim() ||
							typeof blocker.resumeWhen !== "string" || !blocker.resumeWhen.trim()) continue;
						if (state.tasks.some(task => task.id === blocker.taskId && task.revision === blocker.revision)) {
							state.blockers.set(blocker.taskId, {
								taskId: blocker.taskId, revision: blocker.revision, category: blocker.category,
								reason: blocker.reason, resumeWhen: blocker.resumeWhen,
							});
						}
					}
				}
			}
		}
		if (entry.type === "custom" && entry.customType === "todo-tree-state") {
			const data = isRecord(entry.data) ? entry.data : undefined;
			tasks = data?.enabled === false ? [] : parseTasks(data?.tasks, "todo");
		}
		if (entry.type === "custom" && entry.customType === "plan-mode") {
			const data = isRecord(entry.data) ? entry.data : undefined;
			if (data?.executing === false) tasks = [];
			else if (data?.executing === true) tasks = parseTasks(data.todos, "plan-mode");
		}
		if (tasks !== undefined) {
			const blockers = state?.blockers ?? new Map<string, Blocker>();
			for (const [id, blocker] of blockers) {
				if (!tasks.some(task => task.id === id && task.revision === blocker.revision)) blockers.delete(id);
			}
			state = { tasks, blockers };
		}
	}
	return state;
}

function actionableTasks(state: TodoState | undefined): Task[] {
	const tasks = state?.tasks ?? [];
	const parents = new Set(tasks.map(task => task.parentId));
	const leaves = tasks.filter(task => !parents.has(task.id));
	// Malformed cyclic trees must not produce a vacuous "all blocked" pause.
	return leaves.length ? leaves : tasks;
}

function followupCount(ctx: ExtensionContext): number {
	return ctx.sessionManager.getBranch().filter(entry =>
		(entry.type === "message" && userText(entry.message) === LEGACY_CONTINUE_PROMPT) ||
		(entry.type === "custom_message" && entry.customType === "todo-loop-followup"),
	).length;
}

function maxFollowups(pi: ExtensionAPI): number {
	const value = pi.getFlag(MAX_FOLLOWUPS_FLAG);
	const max = typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isSafeInteger(max) && max >= 0 ? max : DEFAULT_MAX_FOLLOWUPS;
}

export default function todoLoop(pi: ExtensionAPI): void {
	pi.registerFlag(MAX_FOLLOWUPS_FLAG, {
		description: "Maximum automatic todo follow-ups (0 disables)",
		type: "string",
		default: String(DEFAULT_MAX_FOLLOWUPS),
	});

	pi.registerTool({
		name: CONTROL_TOOL,
		label: "Todo Loop Control",
		description: "Inspect actionable todo IDs (status), register genuine task blockers (report_blocker), or clear blockers (clear_blocker). Report only tasks that require user input, access, or an external dependency; continue other tasks. Reporting does not complete/cancel tasks. New user messages and task changes invalidate blockers. State is stored in successful tool results, not assistant prose.",
		promptGuidelines: ["When unfinished todos truly cannot proceed, use todo_loop_control report_blocker with task IDs, a concrete reason and resume condition. Continue unblocked tasks; prose alone does not pause todo-loop."],
		// Nested tools do not have standalone persisted tool-result entries.
		exposure: "model-only",
		executionMode: "sequential",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("status"), Type.Literal("report_blocker"), Type.Literal("clear_blocker")]),
			taskIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true, description: "Actionable IDs from status; required for report_blocker and clear_blocker. ID-less todos use @1, @2, etc." })),
			category: Type.Optional(Type.Union([Type.Literal("needs_user_input"), Type.Literal("missing_access"), Type.Literal("external_dependency")])),
			reason: Type.Optional(Type.String({ minLength: 1, description: "Concrete blocker evidence; required for report_blocker." })),
			resumeWhen: Type.Optional(Type.String({ minLength: 1, description: "What must change to resume; required for report_blocker." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const state = latestTodoState(ctx);
			const actionable = actionableTasks(state);
			const fail = (error: string) => ({
				isError: true, content: [{ type: "text" as const, text: error }], details: { version: 1, error },
			});
			if (params.action === "status") {
				const details = { version: 1, action: "status", remaining: state?.tasks.length ?? 0,
					actionable, blockers: [...(state?.blockers.values() ?? [])] };
				return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
			}
			const ids = params.taskIds;
			if (!ids?.length || new Set(ids).size !== ids.length) return fail("Provide distinct taskIds. Use status to inspect current actionable IDs.");
			const tasks = state?.tasks ?? [];
			if (new Set(tasks.map(task => task.id)).size !== tasks.length) return fail("Todo IDs are ambiguous; give every task a unique ID before registering blockers.");
			const targets = params.action === "report_blocker" ? actionable : tasks;
			if (ids.some(id => !targets.some(task => task.id === id))) return fail("Unknown, finished or non-actionable task ID. Use status; register unfinished children, not their parent.");
			if (params.action === "clear_blocker") return {
				content: [{ type: "text", text: `Cleared blockers for ${ids.join(", ")}.` }],
				details: { version: 1, action: params.action, taskIds: ids },
			};
			if (!params.category || !params.reason?.trim() || !params.resumeWhen?.trim()) {
				return fail("report_blocker requires category, a concrete reason and resumeWhen. No state was changed.");
			}
			const blockers: Blocker[] = ids.map(id => ({
				taskId: id, revision: targets.find(task => task.id === id)!.revision,
				category: params.category!, reason: params.reason!.trim(), resumeWhen: params.resumeWhen!.trim(),
			}));
			const runnable = actionable.filter(task => !ids.includes(task.id) && !state?.blockers.has(task.id)).length;
			return {
				content: [{ type: "text", text: `Registered blockers for ${ids.join(", ")}. ${runnable} actionable task(s) remain unblocked. Explain the blockers to the user; do not complete/cancel blocked tasks.` }],
				details: { version: 1, action: params.action, blockers },
			};
		},
	});

	pi.registerCommand("todo-loop", {
		description: "Inspect todo-loop blockers, budget and latest decision (/todo-loop status)",
		async handler(args, ctx) {
			if (args.trim() && args.trim() !== "status") {
				ctx.ui.notify("Usage: /todo-loop status", "warning");
				return;
			}
			const state = latestTodoState(ctx);
			const actionable = actionableTasks(state);
			const latestDecision = [...ctx.sessionManager.getBranch()].reverse().find(entry =>
				entry.type === "custom" && entry.customType === DECISION_ENTRY,
			);
			await showStatusModal(ctx, "Todo Loop", [
				`Unfinished: ${state?.tasks.length ?? 0}; actionable: ${actionable.length}; blocked: ${actionable.filter(task => state?.blockers.has(task.id)).length}`,
				`Automatic follow-ups: ${followupCount(ctx)}/${maxFollowups(pi)} (current branch)`,
				`Last boundary decision (historical): ${latestDecision?.type === "custom" ? JSON.stringify(latestDecision.data) : "none"}`,
				...actionable.map(task => {
					const blocker = state?.blockers.get(task.id);
					return `${task.id}: ${task.subject}${blocker ? ` — [${blocker.category}] ${blocker.reason}; resume: ${blocker.resumeWhen}` : " — actionable"}`;
				}),
			]);
		},
	});

	let limitNotified = false;
	const resetNotification = () => { limitNotified = false; };
	pi.on("session_start", resetNotification);
	pi.on("session_tree", resetNotification);

	// Only act after core retries, compaction and queued work. Do not infer
	// control intent from text: even our own old prompt says "cannot continue".
	pi.on("agent_before_settle", (event, ctx) => {
		const state = latestTodoState(ctx, event.entries);
		if (!state) return;
		const actionable = actionableTasks(state);
		const blocked = actionable.filter(task => state.blockers.has(task.id)).length;
		const used = followupCount(ctx);
		const limit = maxFollowups(pi);
		const lastAssistant = [...event.context.contextMessages].reverse().find(message => message.role === "assistant");
		let reason: string;
		if (event.outcome !== "completed") reason = `outcome_${event.outcome}`;
		else if (ctx.hasPendingMessages()) reason = "pending_messages";
		else if (lastAssistant?.role === "assistant" && (lastAssistant.stopReason === "aborted" || lastAssistant.stopReason === "error")) reason = `assistant_${lastAssistant.stopReason}`;
		else if (state.tasks.length === 0) reason = "no_unfinished_tasks";
		else if (event.continue) reason = "continuation_already_requested";
		else if (actionable.length > 0 && blocked === actionable.length) reason = "all_remaining_tasks_blocked";
		else if (used >= limit) reason = "followup_limit";
		else reason = "unfinished_tasks";
		const shouldContinue = reason === "unfinished_tasks";
		const decision = {
			decision: shouldContinue ? "continue" : reason === "all_remaining_tasks_blocked" || reason === "followup_limit" ? "pause" : "skip", reason,
			remaining: state.tasks.length, actionable: actionable.length, blocked, followups: used, limit,
		};
		if (reason === "followup_limit" && !limitNotified) {
			ctx.ui.notify(`todo-loop paused with ${state.tasks.length} unfinished items after ${limit} automatic follow-ups.`, "warning");
			limitNotified = true;
		}
		if (reason === "all_remaining_tasks_blocked") {
			ctx.ui.notify(`todo-loop paused: all ${actionable.length} actionable tasks are blocked. Use /todo-loop status for reasons and resume conditions.`, "warning");
		}
		const entries = [...event.entries, { type: "custom" as const, customType: DECISION_ENTRY, data: decision }];
		if (!shouldContinue) return { entries };
		// Keep the context message last, and commit atomically at the boundary.
		return {
			entries: [...entries, { type: "custom_message" as const, customType: "todo-loop-followup", content: CONTINUE_PROMPT, display: true }],
			continue: true,
		};
	});
}
