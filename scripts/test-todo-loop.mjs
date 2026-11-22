import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import todoLoop from "../extensions/todo-loop.ts";

// In-memory sessions plus a temporary on-disk fork fixture; no user config, network or model calls.
const agentDir = mkdtempSync(join(tmpdir(), "pi-todo-loop-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.once("exit", () => rmSync(agentDir, { recursive: true, force: true }));
const legacyPrompt = "Continue working on the remaining todo items. Start with the first unfinished item, update the todo list as you progress, and do not stop while any todo remains unfinished. If you truly cannot continue, explicitly say that you cannot continue.";
const assistant = (text = "Ready.", stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: 1 });
const task = (id, extra = {}) => ({ id, subject: `Task ${id}`, status: "pending", ...extra });
function harness(sm = SessionManager.inMemory(process.cwd()), limit = "20") {
	const handlers = new Map(), tools = new Map(), commands = new Map(), notifications = [];
	const ctx = { cwd: process.cwd(), hasUI: false, mode: "json", hasPendingMessages: () => false, sessionManager: sm,
		ui: { notify: (...args) => notifications.push(args) } };
	todoLoop({
		on: (name, handler) => handlers.set(name, handler), registerFlag() {}, getFlag: () => limit,
		appendEntry: (type, data) => sm.appendCustomEntry(type, data),
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
const waitFor = (taskIds, ...runIds) => ({ action: "wait_for_background", taskIds, runIds });
const launch = (h, runId, mode = "single", extra = {}) => h.sm.appendMessage({
	role: "toolResult", toolName: "subagent", toolCallId: runId, content: [],
	details: { mode, runId, asyncId: runId }, timestamp: 1, ...extra,
});
const finish = (h, runId, status = "completed") => h.sm.appendCustomMessageEntry(
	"subagent-notify", "Native result", true, { runs: [{ runId, status }] },
);
const decision = result => result?.entries.findLast(entry => entry.customType === "todo-loop-decision")?.data;
function commit(h, result) {
	for (const e of result.entries) {
		if (e.type === "custom") h.sm.appendCustomEntry(e.customType, e.data);
		else h.sm.appendCustomMessageEntry(e.customType, e.content, e.display, e.details);
	}
}

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
	const review = h.boundary();
	assert.equal(review.continue, true);
	assert.equal(decision(review).reason, "review_external_blockers");
	commit(h, review);
	const pause = h.boundary();
	assert.equal(pause.continue, undefined);
	assert.deepEqual(decision(pause), { decision: "pause", reason: "all_remaining_tasks_blocked", remaining: 3, actionable: 2, blocked: 2, followups: 1, limit: 20 });
	assert.match(pause.entries.at(-1).content, /1\.1, 2 \[needs_user_input\]: Target environment address is missing\.\n  Resume when: User supplies the address\./);
	commit(h, pause);
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

// Waiting is a per-task dependency, not a stop switch for a running session.
{
	const h = harness(); h.snapshot([task("1"), task("2"), task("3")]);
	launch(h, "first", "single"); launch(h, "second", "workflow");
	assert.equal(h.boundary().continue, true, "an unbound launch must not stop any task");
	await h.call(waitFor(["1"], "first", "second"));
	await h.call(report("2"));
	assert.equal(h.boundary().continue, true, "task 3 remains runnable");
	await h.call(waitFor(["3"], "second"));
	const paused = h.boundary();
	assert.equal(paused.continue, undefined);
	assert.equal(paused.entries.some(e => e.customType === "todo-loop-followup"), false);
	assert.deepEqual(decision(paused), { decision: "pause", reason: "waiting_for_background", remaining: 3, actionable: 3, blocked: 1, waiting: 2, followups: 0, limit: 20 });
	assert.equal(decision(harness(h.sm).boundary()).reason, "waiting_for_background", "reload restores waits");
	h.sm.appendCustomMessageEntry("subagent-incremental-child-notify", "A child finished", true, { workflowRunId: "second", childRunId: "child", outcome: "completed" });
	finish(h, "unrelated"); finish(h, "first");
	const status = (await h.call({ action: "status" })).details;
	assert.deepEqual(status.activeRunIds, ["second"]);
	assert.deepEqual(status.waiting.map(w => [w.taskId, w.runIds]), [["1", ["second"]], ["3", ["second"]]]);
	assert.equal(decision(h.boundary()).reason, "waiting_for_background");
	finish(h, "second", "failed");
	assert.equal(decision(h.boundary()).blocked, 1, "a native wake must leave external blockers alone");
	assert.equal(h.boundary().continue, true, "a terminal failure releases the wait for parent recovery");
	console.log("✓ runnable work continues, mixed waits pause, and exact terminal workflow notices release only their waits");
}

{
	const h = harness(); const tasks = [task("1")]; h.snapshot(tasks);
	launch(h, "a"); launch(h, "failed-launch", "single", { isError: true });
	launch(h, "sync", "single", { details: { mode: "single", runId: "sync" } });
	for (const bad of [waitFor(["unknown"], "a"), waitFor(["1"], "unknown"), waitFor(["1"], "failed-launch"),
		waitFor(["1"], "sync"), waitFor(["1"], "a", "a"), waitFor(["1"])]) {
		assert.equal((await h.call(bad)).isError, true);
	}
	await h.call(waitFor(["1"], "a"), { persist: false });
	await h.call(waitFor(["1"], "a"), { isError: true });
	assert.equal(h.boundary().continue, true, "only committed successful waits pause");
	await h.call(waitFor(["1"], "a"));
	h.sm.appendMessage({ role: "user", content: "Status?", timestamp: 1 });
	assert.equal(decision(h.boundary()).reason, "waiting_for_background", "user questions do not change native run lifetime");
	await h.call({ action: "clear_background_wait", taskIds: ["1"] });
	assert.equal(h.boundary().continue, true);
	await h.call(waitFor(["1"], "a"));
	h.snapshot([{ ...tasks[0], subject: "Replaced task" }]);
	h.snapshot(tasks);
	assert.equal(h.boundary().continue, true, "changed then restored task does not resurrect its wait");
	await h.call(waitFor(["1"], "a"));
	const beforeCompletion = h.sm.getLeafId();
	const draft = { type: "custom_message", customType: "subagent-notify", content: "Native result", display: true,
		details: { runs: [{ runId: "a", status: "stopped" }] } };
	assert.equal(h.boundary({ entries: [draft] }).continue, true);
	assert.equal(decision(h.boundary()).reason, "waiting_for_background", "preview does not mutate persisted state");
	finish(h, "a", "stopped");
	h.sm.branch(beforeCompletion);
	assert.equal(h.boundary().continue, true, "completion on a sibling path releases that run in this session");
	assert.equal((await h.call(waitFor(["1"], "a"))).isError, true, "finished runs cannot be waited again");
	launch(h, "new"); await h.call(waitFor(["1"], "new"));
	h.handlers.get("session_start")({ reason: "fork" }, h.ctx);
	assert.equal(h.boundary().continue, true, "new fork does not inherit a wake routed to its original session");
	assert.equal((await h.call(waitFor(["1"], "new"))).isError, true);
	console.log("✓ atomic wait validation, user input, task replacement, manual clearing, completion races and branch isolation");
}

// A native handoff followed by a blanket report must still get one actionable review.
{
	const h = harness(), tasks = Array.from({ length: 14 }, (_, i) => task(String(i + 1)));
	const ids = tasks.map(t => t.id);
	h.snapshot(tasks); launch(h, "handoff");
	await h.call(waitFor(["1"], "handoff")); finish(h, "handoff");
	await h.call(report(...ids));
	const prior = h.sm.getLeafId(), review = h.boundary();
	assert.equal(review.continue, true);
	assert.match(review.entries.at(-1).content, /recent subagent results.*implementation, design and testing.*clear blockers/i);
	assert.equal(review.entries.at(-1).display, true);
	assert.equal(decision(h.boundary({ outcome: "aborted" })).reason, "outcome_aborted");
	assert.equal(decision(h.boundary({ continue: true })).reason, "continuation_already_requested");
	commit(h, review);
	await h.call({ ...report("1"), reason: "Missing fixture", resumeWhen: "Fixture arrives" });
	h.snapshot([...tasks].reverse());
	const pause = harness(h.sm).boundary();
	assert.equal(pause.continue, undefined);
	const summary = pause.entries.at(-1);
	assert.equal(summary.customType, "todo-loop-blocker-summary");
	assert.equal(summary.display, true);
	assert.match(summary.content, /1 \[needs_user_input\]: Missing fixture\n  Resume when: Fixture arrives/);
	assert.equal(summary.content.split("Target environment address is missing.").length, 2);
	assert.equal(summary.content.split("Resume when:").length, 3);
	commit(h, pause);
	assert.deepEqual(h.boundary().entries.map(e => e.customType), ["todo-loop-decision"]);
	h.sm.branch(prior);
	assert.equal(decision(h.boundary()).reason, "review_external_blockers", "sibling branch did not receive the review");
	commit(h, h.boundary());
	await h.call({ action: "clear_blocker", taskIds: ["1"] });
	assert.equal(decision(h.boundary()).reason, "unfinished_tasks", "a local step resumes normal work");
	h.sm.appendMessage({ role: "user", content: "Reassess", timestamp: 1 });
	await h.call(report(...ids));
	assert.equal(decision(h.boundary()).reason, "review_external_blockers");
	const disabled = harness(h.sm, "0").boundary();
	assert.equal(disabled.continue, undefined);
	assert.equal(disabled.entries.at(-1).customType, "todo-loop-blocker-summary", "zero budget still explains the pause");
	assert.equal(harness(h.sm, "1").boundary().continue, undefined, "a previous review spent the one available follow-up");
	console.log("✓ native handoff, 14 blocked leaves, one budgeted review, grouped visible reasons, reload/branch isolation and runnable recovery");
}

// CLI --fork uses forkFrom + startup, not the interactive fork event.
{
	const dir = join(agentDir, "synthetic-sessions"), cwd = process.cwd();
	const parent = harness(SessionManager.create(cwd, dir));
	parent.sm.appendMessage({ role: "user", content: "Synthetic fork fixture", timestamp: 1 });
	parent.snapshot([task("1")]);
	const stampLaunch = (h, runId) => {
		const details = { mode: "single", runId, asyncId: runId, results: [] };
		const stamped = h.handlers.get("tool_result")({ toolName: "subagent", isError: false, details }, h.ctx).details;
		assert.deepEqual(stamped, { ...details, todoLoopSessionId: h.sm.getSessionId() });
		launch(h, runId, "single", { details: stamped });
	};
	launch(parent, "legacy-parent"); stampLaunch(parent, "owned-parent");
	await parent.call(waitFor(["1"], "legacy-parent", "owned-parent"));
	const child = harness(SessionManager.forkFrom(parent.sm.getSessionFile(), cwd, dir));
	child.handlers.get("session_start")({ reason: "startup" }, child.ctx);
	const status = (await child.call({ action: "status" })).details;
	assert.deepEqual(status.activeRunIds, []); assert.deepEqual(status.waiting, []);
	for (const id of ["legacy-parent", "owned-parent"]) assert.equal((await child.call(waitFor(["1"], id))).isError, true);
	stampLaunch(child, "child-run"); await child.call(waitFor(["1"], "child-run"));
	assert.equal(decision(child.boundary()).reason, "waiting_for_background");
	finish(child, "child-run"); assert.equal(child.boundary().continue, true);
	assert.equal(decision(parent.boundary()).reason, "waiting_for_background");
	console.log("✓ CLI fork rejects inherited native IDs and accepts its own stamped launches");
}

// Alternate todo formats and authoritative resets remain supported.
{
	for (const source of ["todo", "todos", "plan-mode"]) {
		const h = harness();
		if (source === "plan-mode") h.sm.appendCustomEntry(source, { executing: true, todos: [{ text: "Example task", completed: false }] });
		else h.sm.appendMessage({ role: "toolResult", toolName: source, toolCallId: "example", content: [], details: { todos: [{ id: 7, text: "Example task", done: false }] }, timestamp: 1 });
		const id = source === "plan-mode" ? "@1" : "7";
		assert.equal((await h.call(report(id))).isError, undefined);
		assert.equal(decision(h.boundary()).reason, "review_external_blockers");
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
	const rehydrated = harness(h.sm);
	rehydrated.handlers.get("session_start")({ reason: "startup" }, rehydrated.ctx);
	assert.equal(decision(rehydrated.boundary()).reason, "followup_limit", "automatic startup preserves budget");
	assert.equal(decision(harness(h.sm, "0").boundary()).reason, "followup_limit");
	assert.equal(decision(harness(h.sm, "invalid").boundary()).limit, 20);
	for (const done of [{ status: "cancelled" }, { status: "completed" }, { status: "deleted" }, { status: "done" }, { done: true }, { completed: true }]) {
		const empty = harness(); empty.snapshot([task("1", done)]);
		assert.equal(decision(empty.boundary()).reason, "no_unfinished_tasks");
	}
	console.log("✓ structural stop reasons, pending work, composed boundaries, persisted limits and decisions");
}

// Explicit session transitions reset only the budget, persisting the reset in the active branch.
{
	for (const reason of ["reload", "resume", "new", "fork"]) {
		const h = harness(SessionManager.inMemory(process.cwd()), "2");
		h.snapshot([task("1"), task("2")]);
		await h.call(report("1"));
		h.sm.appendCustomMessageEntry("todo-loop-followup", "old follow-up", true);
		h.sm.appendMessage({ role: "user", content: legacyPrompt, timestamp: 1 });
		const oldLeaf = h.sm.getLeafId();
		assert.equal(decision(h.boundary()).reason, "followup_limit");
		h.handlers.get("session_start")({ reason }, h.ctx);
		assert.deepEqual(decision(h.boundary()), { decision: "continue", reason: "unfinished_tasks", remaining: 2, actionable: 2, blocked: 1, followups: 0, limit: 2 });
		h.sm.appendCustomMessageEntry("todo-loop-followup", "first follow-up after reset", true);
		const newLeaf = h.sm.getLeafId();
		const rehydrated = harness(h.sm, "2");
		rehydrated.handlers.get("session_start")({ reason: "startup" }, rehydrated.ctx);
		assert.equal(decision(rehydrated.boundary()).followups, 1);
		h.sm.branch(oldLeaf);
		rehydrated.handlers.get("session_tree")();
		assert.equal(decision(rehydrated.boundary()).reason, "followup_limit");
		h.sm.branch(newLeaf);
		assert.equal(decision(rehydrated.boundary()).followups, 1);
	}
	console.log("✓ explicit session transitions renew the active branch budget and preserve todo state");
}

// The local setting takes precedence over Pi's carried runtime flag on reload.
{
	const folder = join(agentDir, "todo-loop");
	mkdirSync(folder);
	const config = join(folder, "config.json"), sm = SessionManager.inMemory(process.cwd());
	const h = harness(sm, "20");
	h.snapshot([task("1")]);
	writeFileSync(config, '{"maxFollowups":100}');
	assert.equal(decision(h.boundary()).limit, 20, "local config is read at extension load");
	const reloaded = harness(sm, "20");
	reloaded.handlers.get("session_start")({ reason: "reload" }, reloaded.ctx);
	assert.equal(decision(reloaded.boundary()).limit, 100);
	assert.equal(decision(reloaded.boundary()).followups, 0);
	writeFileSync(config, '{"maxFollowups":0}');
	assert.equal(decision(harness(sm, "50").boundary()).reason, "followup_limit");
	for (const invalid of ['{"maxFollowups":"100"}', '{"maxFollowups":-1}', '{"maxFollowups":1.5}', 'not JSON']) {
		writeFileSync(config, invalid);
		assert.equal(decision(harness(sm, "50").boundary()).limit, 50);
	}
	console.log("✓ the local limit is loaded on reload, supports zero and falls back for invalid config");
}

// Status is a modal in the TUI and never a long, potentially muted info notification.
{
	const h = harness(); h.snapshot([task("1")]); await h.call(report("1"));
	commit(h, h.boundary()); // review
	commit(h, h.boundary()); // visible pause
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
