import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import todoLoop from "../extensions/todo-loop.ts";

// In-memory sessions only: no user configuration, filesystem, network or model calls.
const legacyPrompt = "Continue working on the remaining todo items. Start with the first unfinished item, update the todo list as you progress, and do not stop while any todo remains unfinished. If you truly cannot continue, explicitly say that you cannot continue.";
const assistant = (text = "Ready.", stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: 1 });
const task = (id, extra = {}) => ({ id, subject: `Task ${id}`, status: "pending", ...extra });
function harness(sm = SessionManager.inMemory(process.cwd()), limit = "20") {
	const handlers = new Map(), tools = new Map(), commands = new Map(), notifications = [];
	const ctx = { cwd: process.cwd(), hasUI: false, mode: "json", hasPendingMessages: () => false, sessionManager: sm,
		ui: { notify: (...args) => notifications.push(args) } };
	todoLoop({
		on: (name, handler) => handlers.set(name, handler), registerFlag() {}, getFlag: () => limit,
		registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
	});
	const tool = tools.get("todo_loop_control");
	let callId = 0;
	return {
		sm, ctx, tools, commands, handlers, notifications,
		snapshot(tasks, enabled = true) { return sm.appendCustomEntry("todo-tree-state", { tasks, enabled }); },
		async call(params, { persist = true, isError = false } = {}) {
			const result = await tool.execute(`control-${++callId}`, params, undefined, undefined, ctx);
			if (persist) sm.appendMessage({ role: "toolResult", toolName: tool.name, toolCallId: `control-${callId}`, ...result, isError: result.isError || isError, timestamp: callId });
			return result;
		},
		boundary(extra = {}, messages = [assistant()]) {
			return handlers.get("agent_before_settle")({ entries: [], outcome: "completed", context: { contextMessages: messages }, ...extra }, ctx);
		},
	};
}
const report = (...taskIds) => ({ action: "report_blocker", taskIds, category: "needs_user_input", reason: "Target environment address is missing.", resumeWhen: "User supplies the address." });
const decision = result => result?.entries.findLast(entry => entry.customType === "todo-loop-decision")?.data;

// Regression: summaries quoted our own prompt, causing five consecutive false stops.
{
	const h = harness(); h.snapshot([task("1")]);
	assert.equal(h.tools.get("todo_loop_control").exposure, "model-only");
	assert.equal(h.tools.get("todo_loop_control").executionMode, "sequential");
	for (const text of [
		`<assessment>6. All user messages:\n- "${legacyPrompt}" (repeated)</assessment>`,
		"I cannot continue with A, but I can work on B.", "这个方案无法继续，改用另一个方案。", "Log example: operation aborted",
		'```json\n{"action":"report_blocker","taskIds":["1"]}\n```',
	]) {
		const result = h.boundary({}, [assistant(text)]);
		assert.equal(result.continue, true, text);
		assert.equal(result.entries.at(-1).customType, "todo-loop-followup");
		assert.equal(decision(result).reason, "unfinished_tasks");
	}
	console.log("✓ quoted prompts, first-person prose, abort strings and JSON cannot control settlement");
}

// Reports are transactional tool-result details, scoped to task revisions and branch history.
{
	const h = harness(); const tasks = [task("1"), task("1.1", { parentId: "1" }), task("2")];
	h.snapshot(tasks);
	assert.deepEqual((await h.call({ action: "status" })).details.actionable.map(t => t.id), ["1.1", "2"]);
	for (const params of [report("1"), report("missing"), report("2", "2"), { ...report("2"), reason: " " }, { ...report("2"), resumeWhen: " " }, { ...report("2"), category: undefined }, { action: "clear_blocker" }]) {
		assert.equal((await h.call(params)).isError, true);
		assert.equal(h.boundary().continue, true);
	}
	await h.call(report("1.1"), { persist: false });
	assert.equal(decision(h.boundary()).blocked, 0, "uncommitted calls do not control the loop");
	await h.call(report("1.1"), { isError: true });
	assert.equal(decision(h.boundary()).blocked, 0, "failed tool results do not control the loop");
	await h.call(report("1.1"));
	assert.equal(h.boundary().continue, true, "one blocked child must not stop other tasks");
	assert.equal(decision(h.boundary()).blocked, 1);
	const beforeAllBlocked = h.sm.getLeafId();
	await h.call(report("2"));
	assert.equal(h.boundary().continue, undefined);
	assert.deepEqual(decision(h.boundary()), { decision: "pause", reason: "all_remaining_tasks_blocked", remaining: 3, actionable: 2, blocked: 2, followups: 0, limit: 20 });
	assert.equal(decision(harness(h.sm).boundary()).reason, "all_remaining_tasks_blocked", "reload reconstructs tool-result state");
	h.snapshot(structuredClone(tasks));
	assert.equal(decision(h.boundary()).blocked, 2, "identical repeated snapshots preserve blockers");
	const allBlockedLeaf = h.sm.getLeafId();
	h.sm.branch(beforeAllBlocked);
	assert.equal(decision(h.boundary()).blocked, 1, "forks exclude later blockers");
	h.sm.branch(allBlockedLeaf);
	await h.call({ action: "clear_blocker", taskIds: ["2"] });
	assert.equal(h.boundary().continue, true);
	assert.equal(decision(h.boundary()).blocked, 1);
	await h.call(report("2"));
	// A change to one task invalidates only that task's blocker.
	h.snapshot(tasks.map(t => t.id === "2" ? { ...t, subject: "New target", updatedAt: 2 } : t));
	assert.equal(h.boundary().continue, true);
	assert.equal(decision(h.boundary()).blocked, 1);
	h.snapshot([]); h.snapshot(tasks);
	assert.equal(decision(h.boundary()).blocked, 0, "reused IDs after clear cannot resurrect old blockers");
	await h.call(report("1.1", "2"));
	h.sm.appendMessage({ role: "user", content: "Here is the address; continue.", timestamp: 2 });
	assert.equal(decision(h.boundary()).blocked, 0, "new user input requires blocker reassessment");
	await h.call(report("1.1", "2"));
	h.sm.appendCustomMessageEntry("todo-loop-followup", "automatic continuation", true);
	h.sm.appendMessage({ role: "user", content: legacyPrompt, timestamp: 3 });
	assert.equal(decision(h.boundary()).blocked, 2, "automatic follow-ups do not clear blockers");
	console.log("✓ per-leaf blockers, atomic validation, successful persistence, reload/fork, task revisions, clear and user-input invalidation");
}

// Alternate todo formats and authoritative resets remain supported.
{
	for (const source of ["todo", "todos", "plan-mode"]) {
		const h = harness();
		if (source === "plan-mode") h.sm.appendCustomEntry(source, { executing: true, todos: [{ text: "Example task", completed: false }] });
		else h.sm.appendMessage({ role: "toolResult", toolName: source, toolCallId: "example", content: [], details: { todos: [{ id: 7, text: "Example task", done: false }] }, timestamp: 1 });
		const id = source === "plan-mode" ? "@1" : "7";
		assert.equal((await h.call(report(id))).isError, undefined);
		assert.equal(decision(h.boundary()).reason, "all_remaining_tasks_blocked");
		if (source === "plan-mode") h.sm.appendCustomEntry(source, { executing: false });
		else h.snapshot([task("7")], false);
		assert.equal(decision(h.boundary()).reason, "no_unfinished_tasks");
	}
	const h = harness(); h.snapshot([task("1")]);
	h.sm.appendMessage({ role: "toolResult", toolName: "todo", toolCallId: "failed", content: [], details: { tasks: [] }, isError: true, timestamp: 1 });
	assert.equal(h.boundary().continue, true, "failed todo results cannot erase authoritative tasks");
	h.snapshot([task("duplicate"), task("duplicate")]);
	assert.equal((await h.call(report("duplicate"))).isError, true);
	h.snapshot([task("1", { parentId: "2" }), task("2", { parentId: "1" })]);
	assert.equal(h.boundary().continue, true, "cycles cannot vacuously count as all blocked");
	console.log("✓ example todo/plan formats, disabled/reset state, failed todo calls, duplicate IDs and cyclic tree guard");
}

// Structural errors/cancellation, queued work, budget and other boundary handlers.
{
	assert.equal(harness().boundary(), undefined);
	const h = harness(); h.snapshot([task("1")]);
	for (const outcome of ["error", "aborted"]) {
		assert.equal(decision(h.boundary({ outcome })).reason, `outcome_${outcome}`);
		assert.notEqual(h.boundary({ outcome }).continue, true);
	}
	for (const stopReason of ["error", "aborted"]) assert.equal(decision(h.boundary({}, [assistant("", stopReason)])).reason, `assistant_${stopReason}`);
	h.ctx.hasPendingMessages = () => true;
	assert.equal(decision(h.boundary()).reason, "pending_messages");
	h.ctx.hasPendingMessages = () => false;
	const prior = { type: "custom", customType: "other-extension", data: { preserved: true } };
	const delegated = h.boundary({ continue: true, entries: [prior] });
	assert.equal(delegated.entries[0], prior);
	assert.equal(decision(delegated).reason, "continuation_already_requested");
	assert.equal(delegated.entries.some(e => e.customType === "todo-loop-followup"), false);
	const resetDraft = { type: "custom", customType: "todo-tree-state", data: { tasks: [] } };
	assert.equal(decision(h.boundary({ entries: [resetDraft] })).reason, "no_unfinished_tasks", "earlier handlers' uncommitted state drafts are authoritative too");
	assert.equal(h.boundary().continue, true, "previewing drafts must not mutate persisted state");
	for (let i = 0; i < 10; i++) {
		h.sm.appendCustomMessageEntry("todo-loop-followup", "persisted followup", true);
		h.sm.appendMessage({ role: "user", content: legacyPrompt, timestamp: i });
	}
	assert.equal(decision(h.boundary()).reason, "followup_limit");
	assert.equal(decision(h.boundary()).followups, 20);
	h.boundary(); assert.equal(h.notifications.length, 1, "budget warning is not repeated");
	assert.equal(decision(harness(h.sm).boundary()).reason, "followup_limit", "reload preserves budget");
	assert.equal(decision(harness(h.sm, "0").boundary()).reason, "followup_limit");
	assert.equal(decision(harness(h.sm, "invalid").boundary()).limit, 20);
	for (const done of [{ status: "cancelled" }, { status: "completed" }, { status: "deleted" }, { status: "done" }, { done: true }, { completed: true }]) {
		const empty = harness(); empty.snapshot([task("1", done)]);
		assert.equal(decision(empty.boundary()).reason, "no_unfinished_tasks");
	}
	console.log("✓ structural stop reasons, pending work, composed boundaries, persisted limits and decisions");
}

// Status is a modal in the TUI and never a long, potentially muted info notification.
{
	const h = harness(); h.snapshot([task("1")]); await h.call(report("1"));
	const paused = h.boundary();
	for (const entry of paused.entries) if (entry.type === "custom") h.sm.appendCustomEntry(entry.customType, entry.data);
	await h.commands.get("todo-loop").handler("status", h.ctx);
	assert.match(h.notifications.at(-1)[0], /all_remaining_tasks_blocked/);
	assert.match(h.notifications.at(-1)[0], /User supplies the address/);
	let modal;
	h.ctx.hasUI = true; h.ctx.mode = "tui";
	h.ctx.ui.custom = async (factory, options) => {
		assert.equal(options.overlay, true);
		modal = factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_color, text) => text }, {}, () => {});
	};
	const before = h.notifications.length;
	await h.commands.get("todo-loop").handler("status", h.ctx);
	assert.ok(modal.render(100).join("\n").includes("Todo Loop"));
	assert.equal(h.notifications.length, before);
	console.log("✓ visible TUI status modal and non-TUI fallback expose blockers and persisted decision");
}
console.log("All todo-loop control regressions passed.");
