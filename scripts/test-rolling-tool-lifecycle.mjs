import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import rollingTools from "../extensions/rolling-tools.ts";

const root = mkdtempSync(join(tmpdir(), "rolling-lifecycle-"));
const originalAgent = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const theme = { fg: (_c, s) => s, bold: s => s };
const tui = { requestRender() {} };
const realNow = Date.now;
let now = realNow();
Date.now = () => now;
function harness(initialBranch = []) {
	const handlers = new Map(), snapshots = []; let command, widget;
	const ctx = { cwd: root, mode: "tui", hasUI: true, sessionManager: { getBranch: () => initialBranch }, ui: {
		notify() {}, setStatus() {}, setToolsExpanded() {}, setWidget(_key, factory) { if (typeof factory === "function") widget = factory; },
	} };
	rollingTools({
		on(event, fn) { handlers.set(event, [...(handlers.get(event) || []), fn]); },
		registerCommand(_name, spec) { command = spec; },
		appendEntry(type, data) { snapshots.push({ type: "custom", customType: type, data: structuredClone(data) }); },
	});
	return {
		handlers, snapshots,
		async emit(type, event = {}) { for (const fn of handlers.get(type) || []) await fn(event, ctx); },
		command: args => command.handler(args, ctx),
		lines: () => widget(tui, theme).render(180),
		async snapshot() { await command.handler("mode fixed", ctx); return snapshots.at(-1).data; },
	};
}
const call = (id, name = "read") => ({ type: "toolCall", id, name, arguments: { path: `${id}.txt` } });
const draft = async (h, calls) => h.emit("message_update", { message: { role: "assistant", content: calls }, assistantMessageEvent: { type: "toolcall_delta", delta: "..." } });
const start = (h, id, name = "read", parentToolCallId) => h.emit("tool_execution_start", { toolCallId: id, toolName: name, args: { path: `${id}.txt` }, parentToolCallId });
const end = (h, id, name = "read", isError = false, durationMs = 2) => h.emit("tool_execution_end", { toolCallId: id, toolName: name, isError, durationMs, result: { content: [{ type: "text", text: isError ? "not permitted" : "complete" }], details: {} } });

try {
	const h = harness();
	try {
		await h.emit("session_start", { reason: "startup" });
		const failed = call("overloaded-read");
		await draft(h, [failed]);
		let item = (await h.snapshot()).items[0];
		assert.equal(item.status, "preparing");
		assert.ok(h.lines().some(line => line.includes("生成参数") && line.includes("✎")));
		now += 30_000;
		assert.ok(!h.lines().some(line => line.includes("30.0s")), "stream time is not read execution time");
		await h.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "The server is overloaded or not ready yet. Please try again later.", content: [failed] } });
		item = (await h.snapshot()).items[0];
		assert.equal(item.status, "error"); assert.match(item.output, /未执行/); assert.equal(item.durationMs, undefined);
		await h.emit("agent_end", { messages: [] });
		assert.equal(h.snapshots.at(-1).data.items[0].status, "error", "failed stream is never persisted as running");
		await start(h, "retry-read"); await end(h, "retry-read", "read", false, 7);
		now += 600_000;
		assert.ok(!h.lines().some(line => line.includes("⏳") && line.includes("overloaded-read")));
		await draft(h, [failed]);
		await h.emit("tool_call", { toolCallId: failed.id, toolName: "read", input: failed.arguments });
		assert.equal((await h.snapshot()).items.find(tool => tool.id === failed.id).status, "error", "late hook/stream metadata cannot resurrect a terminal draft");

		const aborted = call("aborted-read"); await draft(h, [aborted]);
		await h.emit("message_end", { message: { role: "assistant", stopReason: "aborted", content: [aborted] } });
		assert.match((await h.snapshot()).items.find(tool => tool.id === aborted.id).output, /未执行/);
		await draft(h, [call("lost-error-content")]);
		await h.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "stream ended", content: [] } });
		assert.equal((await h.snapshot()).items.find(tool => tool.id === "lost-error-content").status, "error", "empty final errors must retire their earlier partial previews");
		const withdrawn = call("withdrawn-draft"), kept = call("kept-draft");
		await draft(h, [withdrawn, kept]);
		await h.emit("message_end", { message: { role: "assistant", stopReason: "toolUse", content: [kept] } });
		const finalized = await h.snapshot();
		assert.equal(finalized.items.find(tool => tool.id === withdrawn.id).status, "error");
		assert.equal(finalized.items.find(tool => tool.id === kept.id).status, "preparing", "valid finalized calls remain ready for dispatch");
		await start(h, kept.id); await end(h, kept.id);
		console.log("✓ failed/aborted/retracted stream drafts close without fake execution clocks or resurrection");

		await draft(h, [call("real-read")]); now += 60_000;
		await start(h, "real-read"); const dispatchedAt = now; now += 100;
		await h.emit("tool_call", { toolCallId: "real-read", toolName: "read", input: { path: "real-read.txt" } });
		item = (await h.snapshot()).items.find(tool => tool.id === "real-read");
		assert.equal(item.startTime, dispatchedAt, "start/hook pair starts the execution clock exactly once");
		await end(h, "real-read", "read", false, 3);
		await h.emit("message_end", { message: { role: "toolResult", toolCallId: "real-read", toolName: "read", isError: false, durationMs: 3, content: [{ type: "text", text: "persisted result" }] } });
		item = (await h.snapshot()).items.find(tool => tool.id === "real-read");
		assert.equal(item.durationMs, 3); assert.equal(item.status, "done");
		await start(h, "blocked-read");
		await h.emit("tool_execution_end", { toolCallId: "blocked-read", toolName: "read", isError: true, result: { content: [{ type: "text", text: "not permitted" }] } });
		item = (await h.snapshot()).items.find(tool => tool.id === "blocked-read");
		assert.equal(item.status, "error"); assert.equal(item.durationMs, undefined, "a blocked call has no execute duration");
		await start(h, "message-only");
		await h.emit("message_end", { message: { role: "toolResult", toolCallId: "message-only", toolName: "read", isError: false, durationMs: 8, content: [] } });
		assert.equal((await h.snapshot()).items.find(tool => tool.id === "message-only").status, "done");
		await start(h, "parent", "codemode");
		await start(h, "parent/0", "read", "parent"); await end(h, "parent/0");
		const nested = await h.snapshot();
		assert.equal(nested.items.find(tool => tool.id === "parent").status, "running");
		assert.equal(nested.items.find(tool => tool.id === "parent/0").status, "done");
		await end(h, "parent", "codemode");
		console.log("✓ dispatch timing, native duration, nested IDs, blocked calls and persisted-result fallback");

		await start(h, "long-bash", "bash");
		const unrelated = call("other-failed-read"); await draft(h, [unrelated]);
		await h.emit("message_end", { message: { role: "assistant", stopReason: "error", content: [unrelated] } });
		now += 20 * 60 * 1000;
		for (let index = 0; index < 600; index++) { await start(h, `later-${index}`); await end(h, `later-${index}`); }
		item = (await h.snapshot()).items.find(tool => tool.id === "long-bash");
		assert.equal(item.status, "running", "a real long call is not expired by age or newer tool indices");
		await h.command("mode running");
		assert.ok(h.lines()[0].includes("long-bash") || h.lines()[0].includes("bash"));
		await end(h, "long-bash", "bash", false, 10);
		await h.command("clear");
		await end(h, "cleared-call");
		assert.equal((await h.snapshot()).items.length, 0, "late terminal events must not repopulate a cleared widget");
		console.log("✓ real long-running siblings survive errors, elapsed time and a 600-call history window");

		await draft(h, [call("unfinished-draft")]); await start(h, "missing-end");
		await h.emit("agent_end", { messages: [] });
		assert.ok(h.snapshots.at(-1).data.items.every(tool => tool.status === "error"));
		await draft(h, [call("settled-draft")]);
		await h.emit("agent_settled", { aborted: true });
		assert.equal(h.snapshots.at(-1).data.items.find(tool => tool.id === "settled-draft").status, "error");
		await draft(h, [call("shutdown-draft")]);
	} finally { await h.emit("session_shutdown"); }
	assert.ok(h.snapshots.at(-1).data.items.every(tool => tool.status !== "preparing" && tool.status !== "running"));
	console.log("✓ agent end/settlement/shutdown close unfinished records before persistence");

	const restored = harness([{ type: "custom", customType: "rolling-tools-history", data: { total: 2, items: [
		{ id: "legacy-ghost", index: 1, name: "read", status: "running", startTime: now },
		{ id: "new-draft", index: 2, name: "read", status: "preparing", startTime: now },
	] } }]);
	try { await restored.emit("session_start", { reason: "reload" }); assert.ok((await restored.snapshot()).items.every(tool => tool.status === "error")); }
	finally { await restored.emit("session_shutdown"); }

	// Exercise native Agent-core ordering, not just hand-written event mocks.
	const native = harness();
	const model = { id: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://not-used.invalid", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const message = (content, stopReason) => ({ role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id, usage: structuredClone(usage), timestamp: now });
	let requests = 0, reads = 0, releaseBash, readFinished;
	const bashWait = new Promise(resolve => { releaseBash = resolve; });
	const readDone = new Promise(resolve => { readFinished = resolve; });
	const agent = new Agent({ initialState: { model, tools: [
		{ name: "read", label: "Read", description: "fixture", parameters: Type.Object({ path: Type.String() }), execute: async () => { reads++; return { content: [{ type: "text", text: "read complete" }], details: {} }; } },
		{ name: "bash", label: "Bash", description: "fixture", parameters: Type.Object({ path: Type.String() }), execute: async () => { await bashWait; return { content: [{ type: "text", text: "bash complete" }], details: {} }; } },
	] }, streamFn: () => {
		requests++;
		if (requests > 3) throw Error("Native fixture exhausted its three scripted responses");
		const response = requests === 1
			? { ...message([call("native-ghost")], "error"), errorMessage: "The server is overloaded or not ready yet. Please try again later." }
			: requests === 2 ? message([call("native-read"), call("native-bash", "bash"), { ...call("native-invalid-read"), arguments: {} }], "toolUse")
			: message([{ type: "text", text: "complete" }], "stop");
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: response });
			if (response.content[0]?.type === "toolCall") stream.push({ type: "toolcall_start", contentIndex: 0, partial: response });
			stream.push(response.stopReason === "error" ? { type: "error", reason: "error", error: response } : { type: "done", reason: response.stopReason, message: response });
		});
		return stream;
	} });
	agent.subscribe(async event => {
		await native.emit(event.type, event);
		if (event.type === "tool_execution_end" && event.toolCallId === "native-read") readFinished();
	});
	let pending;
	try {
		await native.emit("session_start", { reason: "startup" });
		await agent.prompt("first request");
		assert.equal(reads, 0, "failed assistant draft is not actually executed by core");
		assert.equal((await native.snapshot()).items.find(tool => tool.id === "native-ghost").status, "error");
		pending = agent.prompt("retry request");
		let timer;
		try { await Promise.race([readDone, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("native read did not finish")), 5000); })]); }
		finally { clearTimeout(timer); }
		const snapshot = await native.snapshot();
		assert.equal(reads, 1);
		assert.equal(snapshot.items.find(tool => tool.id === "native-read").status, "done", "read must finish before the parallel bash/result-message batch completes");
		assert.equal(snapshot.items.find(tool => tool.id === "native-bash").status, "running");
		assert.equal(snapshot.items.find(tool => tool.id === "native-invalid-read").status, "error", "validation failures finish without a tool_call/tool_result hook");
		assert.equal(snapshot.items.find(tool => tool.id === "native-invalid-read").durationMs, undefined);
		releaseBash(); await pending; pending = undefined;
		assert.equal(requests, 3, "native fixture must terminate after its final stop response");
		assert.ok((await native.snapshot()).items.every(tool => tool.status === "error" || tool.status === "done"));
	} finally { releaseBash(); if (pending) await pending; await native.emit("session_shutdown"); }
	console.log("✓ native Agent-core stream failure and parallel execution-end/result ordering");

	const cancelled = harness();
	let entered, abortRequests = 0;
	const abortSignals = [];
	const enteredFirst = new Promise(resolve => { entered = resolve; });
	const abortAgent = new Agent({ initialState: { model, tools: [{
		name: "read", label: "Read", description: "fixture", parameters: Type.Object({ path: Type.String() }),
		execute: async (_id, _args, signal) => {
			if (signal.aborted) throw Error("Operation aborted");
			await new Promise((_, reject) => {
				signal.addEventListener("abort", () => reject(Error("Operation aborted")), { once: true });
				entered();
			});
			return { content: [], details: {} };
		},
	}] }, toolExecution: "sequential", streamFn: (_model, _context, options) => {
		if (++abortRequests > 2) throw Error("Cancellation fixture exceeded its two-response budget");
		const aborted = options?.signal?.aborted === true;
		abortSignals.push(aborted);
		if (abortRequests > 1 && !aborted) throw Error("Cancellation fixture expected an aborted follow-up request");
		const response = aborted
			? { ...message([], "aborted"), errorMessage: "Operation aborted" }
			: message([call("cancelled-execution"), call("never-dispatched")], "toolUse");
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: response });
			if (aborted) {
				stream.push({ type: "error", reason: "aborted", error: response });
			} else {
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: response });
				stream.push({ type: "done", reason: "toolUse", message: response });
			}
		});
		return stream;
	} });
	abortAgent.subscribe(event => cancelled.emit(event.type, event));
	let abortRun;
	try {
		await cancelled.emit("session_start", { reason: "startup" });
		abortRun = abortAgent.prompt("cancel sequential batch");
		let timer;
		try { await Promise.race([enteredFirst, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("first sequential tool did not start")), 5000); })]); }
		finally { clearTimeout(timer); }
		abortAgent.abort(); await abortRun; abortRun = undefined;
		assert.ok(abortRequests <= 2, "cancellation must terminate within the finite response budget");
		if (abortRequests === 2) assert.deepEqual(abortSignals, [false, true], "the follow-up stream must see the aborted signal and return an aborted response");
		const snapshot = await cancelled.snapshot();
		assert.equal(snapshot.items.find(tool => tool.id === "cancelled-execution").status, "error");
		assert.equal(snapshot.items.find(tool => tool.id === "never-dispatched").status, "error");
		assert.match(snapshot.items.find(tool => tool.id === "never-dispatched").output, /未执行/);
	} finally { abortAgent.abort(); if (abortRun) await abortRun; await cancelled.emit("session_shutdown"); }
	console.log("✓ native sequential cancellation closes later drafts that were never dispatched");
} finally {
	Date.now = realNow;
	if (originalAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgent;
	rmSync(root, { recursive: true, force: true });
}
console.log("All rolling-tool lifecycle regressions passed (no user sessions, files or network used).");
