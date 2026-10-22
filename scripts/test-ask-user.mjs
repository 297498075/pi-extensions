import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { visibleWidth } from "@earendil-works/pi-tui";
import askUser, { AskUserQuestionSchema, AnswerRequestSchema } from "../extensions/ask-user.ts";

const theme = { fg: (_c, s) => s, style: s => s };
const tui = { requestRender() {} };
function harness() {
	const tools = new Map(), events = new Map(), notifications = [], entries = [];
	askUser({
		registerTool(t) { tools.set(t.name, t); },
		on(name, handler) { events.set(name, handler); },
		appendEntry(customType, data) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
		sendMessage(message, options) { notifications.push({ message, options }); },
	});
	return { tools, events, notifications, entries };
}
const initial = harness();
const tool = initial.tools.get("ask_user_question");
const params = { questions: [{ question: "Why ".repeat(70) + "?", header: "测试".repeat(12), options: [{ label: "界".repeat(40), description: "Detailed explanation ".repeat(30) }] }] };
assert.equal(Check(AskUserQuestionSchema, params), true);
assert.equal(Check(AskUserQuestionSchema, { questions: [] }), false);
assert.equal(Check(AskUserQuestionSchema, { questions: [{ question: "?", options: [] }] }), false);
assert.equal(Check(AskUserQuestionSchema, { questions: [{ question: "?", options: Array.from({ length: 13 }, () => ({ label: "x" })) }] }), false);
assert.equal(Check(AskUserQuestionSchema, { questions: [{ question: "?", options: [{ label: "x".repeat(81) }] }] }), false);
console.log("✓ schemas validate legal and illegal inputs");

let captured = "";
const stdoutWrite = process.stdout.write;
process.stdout.write = chunk => { captured += String(chunk); return true; };
try {
	for (const mode of ["json", "print"]) {
		const result = await tool.execute("headless", params, undefined, undefined, { hasUI: false, mode, ui: { notify() {} } });
		assert.equal(result.details.cancelled, true);
	}
	const result = await tool.execute("rpc", { questions: [{ question: "?", options: [{ label: "yes" }] }] }, undefined, undefined,
		{ hasUI: true, mode: "rpc", ui: { notify() {}, select: async () => "yes" } });
	assert.deepEqual(result.details.answers[0].selected, ["yes"]);
	assert.equal(captured, "", "JSON/RPC/print protocols must not receive terminal control bytes");
} finally { process.stdout.write = stdoutWrite; }
console.log("✓ no stdout pollution in non-terminal modes");

let component, close;
process.stdout.write = () => true;
let pending;
try {
	pending = tool.execute("tui", params, undefined, undefined, { hasUI: true, mode: "tui", ui: {
		notify() {}, custom(factory) { return new Promise(resolve => { close = resolve; component = factory(tui, theme, {}, resolve); }); },
	} });
} finally { process.stdout.write = stdoutWrite; }
for (const width of [8, 20, 40, 80, 120]) {
	for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `rendered line must fit ${width} columns`);
}
component.handleInput("\t"); // Review must also wrap long question/answers.
for (const width of [20, 40, 80]) {
	for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
}
component.handleInput("\x1d"); // Minimized state must remain width safe.
for (const line of component.render(20)) assert.ok(visibleWidth(line) <= 20);
close({ answers: [], cancelled: true });
assert.equal((await pending).details.cancelled, true);
console.log("✓ TUI question/review/minimized layouts fit narrow and wide terminals");

const controller = new AbortController();
process.stdout.write = () => true;
try {
	pending = tool.execute("abort", params, controller.signal, undefined, { hasUI: true, mode: "tui", ui: {
		notify() {}, custom(factory) { return new Promise(resolve => { component = factory(tui, theme, {}, resolve); }); },
	} });
} finally { process.stdout.write = stdoutWrite; }
controller.abort();
let deadline;
try {
	const result = await Promise.race([pending, new Promise((_, reject) => { deadline = setTimeout(() => reject(Error("dialog did not close on abort")), 500); })]);
	assert.equal(result.details.cancelled, true);
} finally { clearTimeout(deadline); }
component.dispose();
const already = new AbortController(); already.abort();
let uiOpened = false;
const cancelled = await tool.execute("preabort", params, already.signal, undefined, { hasUI: true, mode: "tui", ui: { custom() { uiOpened = true; } } });
assert.equal(cancelled.details.cancelled, true); assert.equal(uiOpened, false);
console.log("✓ tool cancellation dismisses custom UI and preflight cancellation opens no UI");

const rpcCustom = await tool.execute("rpc-cancel", { questions: [{ question: "?", options: [{ label: "yes" }] }] }, undefined, undefined, {
	hasUI: true, mode: "rpc", ui: { select: async () => "Type something (custom answer)...", input: async () => undefined },
});
assert.equal(rpcCustom.details.cancelled, true, "cancelled free-form input is not an empty answer");
let rpcStep = 0;
const rpcMulti = await tool.execute("rpc-multi", { questions: [{ question: "choose", multiSelect: true, options: [{ label: "one" }, { label: "two" }] }] }, undefined, undefined, {
	hasUI: true, mode: "rpc", ui: { select: async (_title, choices) => choices[[0, 1, 3][rpcStep++]] },
});
assert.deepEqual(rpcMulti.details.answers[0].selected, ["one", "two"], "RPC multi-select must retain both choices");
// Detached questionnaire lifecycle and the model-facing prompt contract.
assert.equal(Check(AskUserQuestionSchema, { ...params, blocking: false }), true);
assert.equal(Check(AskUserQuestionSchema, { ...params, blocking: "false" }), false);
assert.equal(Check(AnswerRequestSchema, { requestId: "" }), false);
assert.match(tool.description, /description for EVERY option/);
assert.match(tool.description, /WHY it fits this user's current goals/);
assert.match(tool.description, /disclose its downside/);
assert.match(AskUserQuestionSchema.properties.questions.items.properties.options.items.properties.description.description, /为什么.*代价|代价.*为什么/);
const tick = () => new Promise(resolve => setImmediate(resolve));
const simple = { questions: [{ question: "Which approach?", options: [{ label: "one", description: "Keep the current behavior; fewer changes, but no new capabilities." }, { label: "two" }] }] };
const answer = { answers: [{ question: "Which approach?", selected: ["one"] }], cancelled: false };

function interactive() {
	const dialogs = [];
	let active = 0, maxActive = 0;
	return {
		dialogs, get active() { return active; }, get maxActive() { return maxActive; },
		ctx: { hasUI: true, mode: "tui", ui: { notify() {}, custom(factory) {
			return new Promise((resolve, reject) => {
				active++; maxActive = Math.max(active, maxActive);
				let finished = false, component;
				const close = result => {
					if (finished) return;
					finished = true; active--; component?.dispose(); resolve(result);
				};
				component = factory(tui, theme, {}, close);
				dialogs.push({ close, component, fail(error) {
					if (finished) return;
					finished = true; active--; component.dispose(); reject(error);
				} });
			});
		} } },
	};
}
function call(h, name, args, ctx, signal) { return h.tools.get(name).execute(name, args, signal, undefined, ctx); }
function toolEntry(details) {
	return { type: "message", message: { role: "toolResult", toolName: "ask_user_question", details } };
}

process.stdout.write = () => true;
try {
	const h = harness(), ui = interactive();
	const origin = new AbortController();
	const started = await call(h, "ask_user_question", { ...simple, blocking: false }, ui.ctx, origin.signal);
	const requestId = started.details.requestId;
	assert.equal(started.details.status, "pending", "non-blocking ask returns before any answer");
	assert.ok(requestId);
	origin.abort();
	assert.equal(ui.active, 1, "originating tool lifetime must not cancel the detached question");
	assert.equal((await call(h, "get_user_answer", { requestId }, ui.ctx)).details.status, "pending");
	let waited = false;
	const waiting = call(h, "wait_user_answer", { requestId }, ui.ctx).then(r => { waited = true; return r; });
	await tick();
	assert.equal(waited, false, "wait blocks only while the question is unanswered");
	ui.dialogs[0].close(answer);
	assert.equal((await waiting).details.status, "answered");
	await tick();
	assert.deepEqual((await call(h, "get_user_answer", { requestId }, ui.ctx)).details.answers, answer.answers);
	assert.equal((await call(h, "wait_user_answer", { requestId }, ui.ctx)).details.status, "answered");
	assert.equal(h.notifications.length, 1);
	assert.deepEqual(h.notifications[0].options, { triggerTurn: true, deliverAs: "followUp" }, "do not steer/skip executing tool calls");
	assert.equal(h.notifications[0].message.details.requestId, requestId);
	assert.equal(h.entries[0].data.status, "answered", "answer is durable before queued notification delivery");
	assert.equal(started.details.status, "pending", "returned snapshots must not be mutated later");
	const unknown = await call(h, "get_user_answer", { requestId: "missing" }, ui.ctx);
	assert.equal(unknown.details.status, "not_found"); assert.equal(unknown.isError, true);

	// Only one ask-user dialog may own the editor, including mixed blocking/non-blocking calls.
	const first = await call(h, "ask_user_question", { ...simple, blocking: false }, ui.ctx);
	const second = await call(h, "ask_user_question", { ...simple, blocking: false }, ui.ctx);
	let blockingDone = false;
	const blocking = call(h, "ask_user_question", simple, ui.ctx).then(r => { blockingDone = true; return r; });
	await tick();
	assert.equal(ui.dialogs.length, 2); assert.equal(blockingDone, false);
	ui.dialogs[1].close({ answers: [], cancelled: true });
	await tick();
	assert.equal(ui.dialogs.length, 3);
	assert.equal((await call(h, "wait_user_answer", { requestId: first.details.requestId }, ui.ctx)).details.status, "cancelled");
	ui.dialogs[2].close(answer);
	await tick();
	assert.equal(ui.dialogs.length, 4);
	ui.dialogs[3].close(answer);
	assert.equal((await blocking).details.status, "answered");
	await tick();
	assert.equal(ui.maxActive, 1);
	assert.equal(h.notifications.length, 3, "blocking calls do not generate duplicate background notifications");

	// Cancelling the wait does not consume or cancel the question.
	const third = await call(h, "ask_user_question", { ...simple, blocking: false }, ui.ctx);
	const waitAbort = new AbortController();
	const abandoned = call(h, "wait_user_answer", { requestId: third.details.requestId }, ui.ctx, waitAbort.signal);
	waitAbort.abort();
	await assert.rejects(abandoned, /question remains available/);
	assert.equal((await call(h, "get_user_answer", { requestId: third.details.requestId }, ui.ctx)).details.status, "pending");
	await assert.rejects(call(h, "wait_user_answer", { requestId: third.details.requestId }, ui.ctx, waitAbort.signal), /aborted/);
	ui.dialogs[4].fail(new Error("UI failed"));
	await tick();
	const failed = await call(h, "wait_user_answer", { requestId: third.details.requestId }, ui.ctx);
	assert.equal(failed.details.status, "error"); assert.equal(failed.isError, true);
	assert.match(failed.content[0].text, /UI failed/);

	// Rebuild only from the active branch, preserving answered requests even if a stale pending result follows.
	const restored = harness();
	const branch = [h.entries[0], toolEntry(started.details), toolEntry(second.details),
		{ type: "custom", customType: "ask-user-answer", data: { kind: "ask-user/v1", requestId: "broken" } }];
	const restoreCtx = { ...ui.ctx, sessionManager: { getBranch: () => branch } };
	restored.events.get("session_start")({}, restoreCtx);
	assert.equal((await call(restored, "get_user_answer", { requestId }, restoreCtx)).details.status, "answered");
	const interrupted = await call(restored, "wait_user_answer", { requestId: second.details.requestId }, restoreCtx);
	assert.equal(interrupted.details.status, "cancelled");
	assert.match(interrupted.details.reason, /interrupted/);
	assert.equal(restored.notifications.length, 0, "restoring history must not notify again");
	restored.events.get("session_tree")({}, { ...restoreCtx, sessionManager: { getBranch: () => [] } });
	assert.equal((await call(restored, "get_user_answer", { requestId }, restoreCtx)).details.status, "not_found");

	// Shutdown closes active UI, drops queued dialogs, releases waiters, and suppresses late delivery.
	const closing = harness(), closingUI = interactive();
	const a = await call(closing, "ask_user_question", { ...simple, blocking: false }, closingUI.ctx);
	await call(closing, "ask_user_question", { ...simple, blocking: false }, closingUI.ctx);
	const waiter = call(closing, "wait_user_answer", { requestId: a.details.requestId }, closingUI.ctx);
	closing.events.get("session_shutdown")();
	assert.equal((await waiter).details.status, "cancelled");
	await tick();
	assert.equal(closingUI.active, 0); assert.equal(closingUI.dialogs.length, 1);
	assert.equal(closing.notifications.length, 0); assert.equal(closing.entries.length, 0);
	closingUI.dialogs[0].close(answer);
	closing.events.get("session_shutdown")();
	await tick();
	assert.equal(closing.notifications.length, 0);

	// RPC remains detached, and late RPC results cannot leak across a session replacement.
	const rpc = harness(); let selectAnswer;
	const rpcCtx = { hasUI: true, mode: "rpc", ui: { select: () => new Promise(resolve => { selectAnswer = resolve; }) } };
	const rpcPending = await call(rpc, "ask_user_question", { ...simple, blocking: false }, rpcCtx);
	assert.equal(rpcPending.details.status, "pending");
	selectAnswer("one"); await tick();
	assert.equal(rpc.notifications[0].message.details.status, "answered");
	await call(rpc, "ask_user_question", { ...simple, blocking: false }, rpcCtx);
	rpc.events.get("session_shutdown")();
	selectAnswer("one"); await tick();
	assert.equal(rpc.notifications.length, 1);

	const noUI = await call(h, "ask_user_question", { ...simple, blocking: false }, { hasUI: false });
	assert.equal(noUI.details.cancelled, true);
	assert.equal(noUI.details.requestId, undefined, "headless requests must not remain pending forever");
} finally { process.stdout.write = stdoutWrite; }
console.log("✓ non-blocking ask, query/wait, FIFO UI, automatic delivery, cancellation, persistence and session isolation");
console.log("✓ option prompts require concrete impacts, recommendation rationale and trade-offs");
console.log("All ask-user regressions passed.");
