import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { showStatusModal } from "./lib/status-modal.ts";

const DEFAULT_MAX_FOLLOWUPS = 20;
const MAX_FOLLOWUPS_FLAG = "todo-loop-max-followups";
const CONTROL_TOOL = "todo_loop_control";
const DECISION_ENTRY = "todo-loop-decision";
const BUDGET_RESET_ENTRY = "todo-loop-budget-reset";
const FOLLOWUP = "todo-loop-followup";
const BLOCKER_SUMMARY = "todo-loop-blocker-summary";
const REVIEW_PROMPT = "Review every remaining leaf using any recent subagent results. Separate locally feasible implementation, design and testing from acceptance work that requires external access or approval. Update the todo tree, clear blockers for runnable tasks, and do that work first. If all leaves still require external help, report the specific missing prerequisite and resume condition for each task (group only identical prerequisites).";

// Keep recognizing old user-message follow-ups without inspecting assistant prose.
const LEGACY_CONTINUE_PROMPT =
	"Continue working on the remaining todo items. Start with the first unfinished item, update the todo list as you progress, and do not stop while any todo remains unfinished. If you truly cannot continue, explicitly say that you cannot continue.";
const CONTINUE_PROMPT =
	"Continue working on the remaining actionable todo items and update the todo list as you progress. " +
	"Use todo_loop_control status to inspect actionable task IDs and registered blockers. " +
	"Use todo_loop_control wait_for_background with taskIds and runIds when the only next step depends on a running native subagent. " +
	"For genuine user input, access, or external dependencies, use report_blocker with taskIds, category, reason and resumeWhen. Continue other runnable tasks; leave waiting and blocked tasks unfinished.";

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

interface BackgroundWait {
	taskId: string;
	revision: string;
	runIds: string[];
}

interface TodoState {
	tasks: Task[];
	blockers: Map<string, Blocker>;
	waiting: Map<string, BackgroundWait>;
	activeRunIds: Set<string>;
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

// A run can finish while the operator visits a different branch of the same
// session. Its terminal notice is still authoritative for that exact run ID.
function finishedRuns(ctx: ExtensionContext, drafts: readonly SessionBoundaryDraft[]): Set<string> {
	const finished = new Set<string>();
	for (const entry of [...ctx.sessionManager.getEntries(), ...drafts]) {
		if (entry.type !== "custom_message" || entry.customType !== "subagent-notify" ||
			!isRecord(entry.details) || !Array.isArray(entry.details.runs)) continue;
		for (const run of entry.details.runs) {
			if (isRecord(run) && typeof run.runId === "string" &&
				(run.status === "completed" || run.status === "failed" || run.status === "paused" || run.status === "stopped")) {
				finished.add(run.runId);
			}
		}
	}
	return finished;
}

function isAsyncLaunch(details: Record<string, unknown>): boolean {
	return details.mode !== "management" && typeof details.runId === "string" && details.runId === details.asyncId;
}

// Controls and launches belong to the active branch. Successful tool results,
// not quoted JSON or ordinary messages, carry the durable control state.
function latestTodoState(ctx: ExtensionContext, drafts: readonly SessionBoundaryDraft[] = []): TodoState | undefined {
	const activeRunIds = new Set<string>();
	const finished = finishedRuns(ctx, drafts);
	const sessionId = ctx.sessionManager.getSessionId();
	const allowLegacyLaunch = !ctx.sessionManager.getHeader()?.parentSession;
	let state: TodoState | undefined;
	for (const entry of [...ctx.sessionManager.getBranch(), ...drafts]) {
		if (entry.type === "custom" && entry.customType === BUDGET_RESET_ENTRY &&
			isRecord(entry.data) && entry.data.reason === "fork") {
			activeRunIds.clear();
			state?.waiting.clear();
		}
		let tasks: Task[] | undefined;
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "user" && userText(message) !== LEGACY_CONTINUE_PROMPT) state?.blockers.clear();
			if (message.role !== "toolResult" || message.isError) continue;
			const details = isRecord(message.details) ? message.details : undefined;
			if (message.toolName === "subagent" && details && isAsyncLaunch(details) && typeof details.runId === "string" &&
				(details.todoLoopSessionId === undefined ? allowLegacyLaunch : details.todoLoopSessionId === sessionId) && !finished.has(details.runId)) {
				activeRunIds.add(details.runId);
			}
			if (message.toolName === "todo" || message.toolName === "todos") {
				tasks = parseTasks(details?.tasks ?? details?.todos, "todo");
			}
			if (message.toolName === CONTROL_TOOL && details?.version === 1 && state) {
				if (details.action === "clear_blocker" && Array.isArray(details.taskIds)) {
					for (const id of details.taskIds) if (typeof id === "string") state.blockers.delete(id);
				}
				if (details.action === "clear_background_wait" && Array.isArray(details.taskIds)) {
					for (const id of details.taskIds) if (typeof id === "string") state.waiting.delete(id);
				}
				if (details.action === "wait_for_background" && details.sessionId === sessionId && Array.isArray(details.waiting)) {
					for (const wait of details.waiting) {
						if (!isRecord(wait) || typeof wait.taskId !== "string" || typeof wait.revision !== "string" ||
							!Array.isArray(wait.runIds) || !wait.runIds.every(id => typeof id === "string")) continue;
						if (!state.tasks.some(task => task.id === wait.taskId && task.revision === wait.revision)) continue;
						// A later declaration replaces the prior wait, including when it has already settled.
						state.waiting.delete(wait.taskId);
						const runIds = wait.runIds.filter(id => activeRunIds.has(id));
						if (runIds.length) state.waiting.set(wait.taskId, { taskId: wait.taskId, revision: wait.revision, runIds });
					}
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
			const waiting = state?.waiting ?? new Map<string, BackgroundWait>();
			for (const controls of [blockers, waiting]) {
				for (const [id, control] of controls) {
					if (!tasks.some(task => task.id === id && task.revision === control.revision)) controls.delete(id);
				}
			}
			state = { tasks, blockers, waiting, activeRunIds };
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

// Only committed prompts (not diagnostic decisions) spend a review. The most recent
// review also covers refined blocker wording for the same leaves in its response.
function blockerReview(ctx: ExtensionContext, drafts: readonly SessionBoundaryDraft[], blockers: Blocker[]) {
	blockers.sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
	const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const sessionId = ctx.sessionManager.getSessionId();
	const leafKey = digest(blockers.map(b => [b.taskId, b.revision]));
	const blockerKey = digest(blockers.map(b => [b.taskId, b.revision, b.category, b.reason, b.resumeWhen]));
	let latest = true, reviewed = false, summarized = false;
	for (const entry of [...ctx.sessionManager.getBranch(), ...drafts].reverse()) {
		if (entry.type === "message" && entry.message.role === "user" && userText(entry.message) !== LEGACY_CONTINUE_PROMPT) break;
		if (entry.type !== "custom_message" || (entry.customType !== FOLLOWUP && entry.customType !== BLOCKER_SUMMARY)) continue;
		const meta = entry.details;
		if (isRecord(meta) && meta.sessionId === sessionId) {
			if (entry.customType === FOLLOWUP && (meta.blockerKey === blockerKey || (latest && meta.leafKey === leafKey))) reviewed = true;
			if (entry.customType === BLOCKER_SUMMARY && meta.blockerKey === blockerKey) {
				if (latest) summarized = true;
				if (meta.reviewed === true) reviewed = true;
			}
		}
		latest = false;
	}
	const groups = new Map<string, { ids: string[]; blocker: Blocker }>();
	for (const blocker of blockers) {
		const key = JSON.stringify([blocker.category, blocker.reason, blocker.resumeWhen]);
		const group = groups.get(key) ?? { ids: [], blocker };
		group.ids.push(blocker.taskId);
		groups.set(key, group);
	}
	const summary = ["Todo-loop paused. Remaining tasks and their external prerequisites:", ...Array.from(groups.values(),
		({ ids, blocker }) => `- ${ids.join(", ")} [${blocker.category}]: ${blocker.reason}\n  Resume when: ${blocker.resumeWhen}`)].join("\n");
	return { details: { sessionId, blockerKey, leafKey }, reviewed, summarized, summary };
}

function followupCount(ctx: ExtensionContext): number {
	let used = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === BUDGET_RESET_ENTRY) used = 0;
		else if ((entry.type === "message" && userText(entry.message) === LEGACY_CONTINUE_PROMPT) ||
			(entry.type === "custom_message" && entry.customType === FOLLOWUP)) used++;
	}
	return used;
}

function readConfiguredLimit(): number | undefined {
	try {
		const config: unknown = JSON.parse(readFileSync(join(getAgentDir(), "todo-loop", "config.json"), "utf8"));
		const limit = isRecord(config) ? config.maxFollowups : undefined;
		if (typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0) return limit;
	} catch {
		// A missing or invalid local config leaves the invocation/default budget in effect.
	}
	return undefined;
}

export default function todoLoop(pi: ExtensionAPI): void {
	const configuredLimit = readConfiguredLimit();
	pi.registerFlag(MAX_FOLLOWUPS_FLAG, {
		description: "Maximum automatic todo follow-ups without local config (default 20; 0 disables)",
		type: "string",
	});
	const maxFollowups = () => {
		if (configuredLimit !== undefined) return configuredLimit;
		const value = pi.getFlag(MAX_FOLLOWUPS_FLAG);
		const limit = typeof value === "string" ? Number(value) : Number.NaN;
		return Number.isSafeInteger(limit) && limit >= 0 ? limit : DEFAULT_MAX_FOLLOWUPS;
	};

	pi.registerTool({
		name: CONTROL_TOOL,
		label: "Todo Loop Control",
		description: "Inspect task IDs, external blockers and native background waits (status). Use report_blocker or clear_blocker for external prerequisites. Use wait_for_background with taskIds and runIds only when no next step on those tasks is useful until the specified native subagents finish. Completion notices release waits automatically; clear_background_wait releases them manually. Continue other runnable tasks.",
		promptGuidelines: ["Use todo_loop_control wait_for_background after launching native async subagents if the specified tasks must now await their handoff. Register genuine external prerequisites separately with report_blocker and continue all other runnable tasks."],
		// Nested tools do not have standalone persisted tool-result entries.
		exposure: "model-only",
		executionMode: "sequential",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("status"), Type.Literal("report_blocker"), Type.Literal("clear_blocker"),
				Type.Literal("wait_for_background"), Type.Literal("clear_background_wait")]),
			taskIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true, description: "Task IDs from status; use unfinished leaves when registering blockers or waits." })),
			runIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true, description: "Exact active native async run IDs from status; required for wait_for_background." })),
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
					actionable, blockers: [...(state?.blockers.values() ?? [])],
					waiting: [...(state?.waiting.values() ?? [])], activeRunIds: [...(state?.activeRunIds ?? [])] };
				return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
			}
			const ids = params.taskIds;
			if (!ids?.length || new Set(ids).size !== ids.length) return fail("Provide distinct taskIds. Use status to inspect current actionable IDs.");
			const tasks = state?.tasks ?? [];
			if (new Set(tasks.map(task => task.id)).size !== tasks.length) return fail("Todo IDs are ambiguous; give every task a unique ID.");
			const clearing = params.action === "clear_blocker" || params.action === "clear_background_wait";
			const targets = clearing ? tasks : actionable;
			if (ids.some(id => !targets.some(task => task.id === id))) return fail("Unknown, finished or non-actionable task ID. Use status; register unfinished children, not their parent.");
			if (clearing) return {
				content: [{ type: "text", text: `Cleared ${params.action === "clear_blocker" ? "blockers" : "background waits"} for ${ids.join(", ")}.` }],
				details: { version: 1, action: params.action, taskIds: ids },
			};
			if (params.action === "wait_for_background") {
				const runIds = params.runIds;
				if (!runIds?.length || new Set(runIds).size !== runIds.length ||
					runIds.some(id => !state?.activeRunIds.has(id))) {
					return fail("Provide distinct active native async run IDs from status. A completed run should be handled now.");
				}
				const waiting = ids.map(taskId => ({ taskId, revision: targets.find(task => task.id === taskId)!.revision, runIds }));
				return {
					content: [{ type: "text", text: `Waiting for native completion on ${ids.join(", ")}. Continue other runnable tasks, then yield for the completion notification.` }],
					details: { version: 1, action: params.action, sessionId: ctx.sessionManager.getSessionId(), waiting },
				};
			}
			if (!params.category || !params.reason?.trim() || !params.resumeWhen?.trim()) {
				return fail("report_blocker requires category, a concrete reason and resumeWhen. No state was changed.");
			}
			const blockers: Blocker[] = ids.map(id => ({
				taskId: id, revision: targets.find(task => task.id === id)!.revision,
				category: params.category!, reason: params.reason!.trim(), resumeWhen: params.resumeWhen!.trim(),
			}));
			const runnable = actionable.filter(task => !ids.includes(task.id) && !state?.blockers.has(task.id) && !state?.waiting.has(task.id)).length;
			return {
				content: [{ type: "text", text: `Registered blockers for ${ids.join(", ")}. ${runnable} task(s) remain runnable.` }],
				details: { version: 1, action: params.action, blockers },
			};
		},
	});

	pi.registerCommand("todo-loop", {
		description: "Inspect todo-loop blockers, background waits, budget and latest decision (/todo-loop status)",
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
				`Unfinished: ${state?.tasks.length ?? 0}; actionable: ${actionable.length}; blocked: ${actionable.filter(task => state?.blockers.has(task.id)).length}; waiting: ${actionable.filter(task => state?.waiting.has(task.id)).length}`,
				`Automatic follow-ups: ${followupCount(ctx)}/${maxFollowups()} (since last reset on this branch)`,
				`Last boundary decision (historical): ${latestDecision?.type === "custom" ? JSON.stringify(latestDecision.data) : "none"}`,
				...actionable.map(task => {
					const blocker = state?.blockers.get(task.id);
					const wait = state?.waiting.get(task.id);
					const notes = [blocker && `[${blocker.category}] ${blocker.reason}; resume: ${blocker.resumeWhen}`,
						wait && `waiting for ${wait.runIds.join(", ")}`].filter(Boolean);
					return `${task.id}: ${task.subject} — ${notes.join("; ") || "actionable"}`;
				}),
			]);
		},
	});

	// CLI forks copy launch results but native completion remains routed to the parent.
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName === "subagent" && !event.isError && isRecord(event.details) && isAsyncLaunch(event.details)) {
			return { details: { ...event.details, todoLoopSessionId: ctx.sessionManager.getSessionId() } };
		}
	});

	let limitNotified = false;
	pi.on("session_start", ({ reason }) => {
		limitNotified = false;
		// Explicit runtime transitions renew the budget, without changing tasks or blockers.
		if (reason === "reload" || reason === "resume" || reason === "new" || reason === "fork") {
			pi.appendEntry(BUDGET_RESET_ENTRY, { reason });
		}
	});
	pi.on("session_tree", () => { limitNotified = false; });

	// Only act after core retries, compaction and queued work. Do not infer
	// control intent from text: even our own old prompt says "cannot continue".
	pi.on("agent_before_settle", (event, ctx) => {
		const state = latestTodoState(ctx, event.entries);
		if (!state) return;
		const actionable = actionableTasks(state);
		const blocked = actionable.filter(task => state.blockers.has(task.id)).length;
		const waiting = actionable.filter(task => !state.blockers.has(task.id) && state.waiting.has(task.id)).length;
		const used = followupCount(ctx);
		const limit = maxFollowups();
		const lastAssistant = [...event.context.contextMessages].reverse().find(message => message.role === "assistant");
		let review: ReturnType<typeof blockerReview> | undefined;
		let reason: string;
		if (event.outcome !== "completed") reason = `outcome_${event.outcome}`;
		else if (ctx.hasPendingMessages()) reason = "pending_messages";
		else if (lastAssistant?.role === "assistant" && (lastAssistant.stopReason === "aborted" || lastAssistant.stopReason === "error")) reason = `assistant_${lastAssistant.stopReason}`;
		else if (state.tasks.length === 0) reason = "no_unfinished_tasks";
		else if (event.continue) reason = "continuation_already_requested";
		else if (actionable.length > 0 && blocked === actionable.length) {
			review = blockerReview(ctx, event.entries, actionable.map(task => state.blockers.get(task.id)!));
			reason = !review.reviewed && used < limit ? "review_external_blockers" : "all_remaining_tasks_blocked";
		}
		else if (waiting > 0 && blocked + waiting === actionable.length) reason = "waiting_for_background";
		else if (used >= limit) reason = "followup_limit";
		else reason = "unfinished_tasks";
		const shouldContinue = reason === "unfinished_tasks" || reason === "review_external_blockers";
		const paused = reason === "all_remaining_tasks_blocked" || reason === "waiting_for_background" || reason === "followup_limit";
		const decision = {
			decision: shouldContinue ? "continue" : paused ? "pause" : "skip", reason,
			remaining: state.tasks.length, actionable: actionable.length, blocked, ...(waiting ? { waiting } : {}), followups: used, limit,
		};
		if (reason === "followup_limit" && !limitNotified) {
			ctx.ui.notify(`todo-loop paused with ${state.tasks.length} unfinished items after ${limit} automatic follow-ups.`, "warning");
			limitNotified = true;
		}
		const entries: SessionBoundaryDraft[] = [...event.entries, { type: "custom", customType: DECISION_ENTRY, data: decision }];
		if (!shouldContinue) {
			if (review && !review.summarized) entries.push({ type: "custom_message", customType: BLOCKER_SUMMARY,
				content: review.summary, display: true, details: { ...review.details, reviewed: review.reviewed } });
			return { entries };
		}
		// Keep the context message last, and commit atomically at the boundary.
		return {
			entries: [...entries, { type: "custom_message" as const, customType: FOLLOWUP, content: review ? REVIEW_PROMPT : CONTINUE_PROMPT,
				display: true, ...(review && { details: review.details }) }],
			continue: true,
		};
	});
}
