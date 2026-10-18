import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { visibleWidth } from "@earendil-works/pi-tui";
import askUser, { AskUserQuestionSchema } from "../extensions/ask-user.ts";

const theme = { fg: (_c, s) => s, style: s => s };
const tui = { requestRender() {} };
let tool; askUser({ registerTool(t) { tool = t; } });
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
console.log("All ask-user regressions passed.");
