import assert from "node:assert/strict";
import { Agent } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import compactTool from "../extensions/compact.ts";

function harness() {
	const handlers = new Map(), tools = new Map(), messages = [], notifications = [], compactions = [];
	const sm = SessionManager.inMemory(process.cwd());
	const h = { handlers, tools, messages, notifications, compactions, sm };
	h.ctx = {
		hasUI: false,
		sessionManager: sm,
		getContextUsage: () => ({ tokens: 50_000, contextWindow: 100_000, percent: 50 }),
		compact(options) { compactions.push(options); },
		ui: { notify(...args) { notifications.push(args); } },
	};
	h.pi = {
		on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool(tool) { tools.set(tool.name, tool); },
		sendMessage(message, options) { messages.push({ message, options }); },
	};
	h.emit = async (name, event = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, h.ctx);
	};
	compactTool(h.pi);
	h.tool = tools.get("compact");
	h.call = async (params = {}, signal, id = "compact-1") => {
		const result = await h.tool.execute(id, params, signal, undefined, h.ctx);
		return { result, message: { role: "toolResult", toolName: "compact", toolCallId: id, ...result, isError: false, timestamp: Date.now() } };
	};
	h.finish = async (message, extra = {}) => h.emit("turn_end", { outcome: "completed", toolResults: [message], ...extra });
	return h;
}
const completed = { summary: "Task state and next steps", tokensBefore: 50_000, estimatedTokensAfter: 10_000 };

{
	const h = harness();
	assert.equal(h.tool.exposure, "model-only", "context control must not run inside codemode");
	assert.ok(Check(h.tool.parameters, {}));
	assert.deepEqual(h.tool.parameters.properties, {}, "compact must declare no parameters");
	assert.doesNotMatch([h.tool.description, ...h.tool.promptGuidelines].join("\n"), /customInstructions/);
	for (const args of [{ customInstructions: "Preserve task state" }, { customInstructions: 1 }, { customInstructions: "" }, { unknown: true }, null, []]) {
		assert.equal(Check(h.tool.parameters, args), false);
	}
	const { result, message } = await h.call();
	assert.equal(result.terminate, true);
	assert.equal(result.details.status, "queued");
	assert.equal(Object.hasOwn(result.details, "customInstructions"), false);
	assert.equal(result.details.contextUsage.tokens, 50_000);
	assert.equal(h.compactions.length, 0, "execute must not start compaction before tool-result persistence");
	await assert.rejects(h.call(), /already pending/);
	await h.finish(message);
	assert.equal(h.compactions.length, 1);
	assert.deepEqual(Object.keys(h.compactions[0]).sort(), ["onComplete", "onError"], "use Pi defaults without custom summary instructions");
	await h.finish(message);
	assert.equal(h.compactions.length, 1, "one request starts only once");
	await h.emit("agent_settled", { aborted: true }); // Manual compact itself aborts the active run.
	assert.equal(h.messages.length, 0, "only the completion callback may resume");
	h.compactions[0].onComplete(completed);
	h.compactions[0].onComplete(completed);
	h.compactions[0].onError(new Error("late callback"));
	assert.equal(h.messages.length, 1);
	assert.equal(h.messages[0].message.details.status, "completed");
	assert.equal(h.messages[0].message.details.estimatedTokensAfter, 10_000);
	assert.deepEqual(h.messages[0].options, { triggerTurn: true, deliverAs: "followUp" });
	assert.equal(h.notifications.length, 0, "headless mode needs no UI");
	await h.call({}, undefined, "compact-2");
}
console.log("✓ schema, direct-only exposure, queued acknowledgement and one successful automatic continuation");

for (const outcome of ["aborted", "error"]) {
	const h = harness(), { message } = await h.call();
	await h.finish(message, { outcome });
	assert.equal(h.compactions.length, 0);
	await h.call(); // The cancelled request no longer blocks future requests.
}
for (const toolResults of [[], [{ toolCallId: "compact-1", isError: true }]]) {
	const h = harness(), { message } = await h.call();
	await h.finish(message, { toolResults });
	assert.equal(h.compactions.length, 0, "missing/rewritten error results must not authorize compaction");
}
{
	const h = harness(), controller = new AbortController(); controller.abort();
	await assert.rejects(h.call({}, controller.signal), /aborted/);
	const { message } = await h.call();
	h.ctx.signal = controller.signal;
	await h.finish(message);
	assert.equal(h.compactions.length, 0);
}
{
	const h = harness(); await h.call();
	await h.emit("agent_settled", { aborted: true });
	await h.call();
}
console.log("✓ aborted/error turns, missing/error results, aborted signals and abandoned queued requests");

for (const lifecycle of ["session_start", "session_shutdown", "session_before_switch", "session_before_fork", "session_before_tree", "before_agent_start"]) {
	for (const phase of ["queued", "compacting"]) {
		const h = harness(), { message } = await h.call();
		if (phase === "compacting") await h.finish(message);
		await h.emit(lifecycle);
		if (phase === "queued") {
			await h.finish(message);
			assert.equal(h.compactions.length, 0);
		} else {
			h.compactions[0].onComplete(completed);
			h.compactions[0].onError(new Error("late failure"));
			assert.equal(h.messages.length, 0, `${lifecycle} must invalidate late callbacks`);
		}
	}
}
{
	const h = harness(), { message } = await h.call(); await h.finish(message);
	h.ctx.sessionManager = SessionManager.inMemory(process.cwd());
	h.compactions[0].onComplete(completed);
	assert.equal(h.messages.length, 0, "session identity is also checked without lifecycle notification");
}
console.log("✓ no stale continuations after shutdown/reload/navigation/new user input/session replacement");

for (const cancelled of [false, true]) {
	const h = harness(); h.ctx.hasUI = true;
	const { message } = await h.call(); await h.finish(message);
	if (cancelled) await h.emit("session_compact_failed", { reason: "manual", aborted: true });
	h.compactions[0].onError(new Error(cancelled ? "Stopped by extension" : "Nothing to compact (session too small)"));
	assert.equal(h.messages.length, 1);
	assert.equal(h.messages[0].message.details.status, cancelled ? "cancelled" : "failed");
	assert.equal(h.messages[0].options.triggerTurn, false, "failure/cancellation never revives the task");
	assert.equal(h.notifications.length, cancelled ? 0 : 1);
	await h.call();
}
{
	const h = harness(); h.ctx.compact = () => { throw new Error("synchronous error"); };
	await h.finish((await h.call()).message);
	assert.equal(h.messages[0].message.details.status, "failed");
}
console.log("✓ asynchronous and synchronous failures recorded without retry; cancellation does not auto-resume");

// Real Agent-core: run two parallel tools, persist the whole batch, abort/wait
// exactly as AgentSession.compact does, then resume via the completion callback.
// This catches awaiting compaction from turn_end (a self-deadlock) and early
// compaction while a sibling tool is still running. No API/network/files used.
{
	const h = harness();
	const model = { id: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://not-used.invalid", reasoning: false,
		input: ["text"], contextWindow: 100_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	let requests = 0, abortedRequests = 0, siblingFinished = false, siblingStarted, releaseSibling, resolveFinished, rejectFinished;
	const started = new Promise(resolve => { siblingStarted = resolve; });
	const siblingWait = new Promise(resolve => { releaseSibling = resolve; });
	const finished = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
	const agent = new Agent({
		initialState: { model, tools: [
			{ ...h.tool, execute: (...args) => h.tool.execute(...args, h.ctx) },
			{ name: "sibling", label: "Sibling", description: "fixture", parameters: Type.Object({}), execute: async () => {
				siblingStarted(); await siblingWait; siblingFinished = true;
				return { content: [{ type: "text", text: "sibling complete" }], details: {} };
			} },
		] },
		streamFn: (_model, context, options) => {
			// The low-level loop can enter its next stream with an already-aborted
			// signal when sibling tools did not all return terminate. A real provider
			// observes that signal rather than issuing another live model request.
			if (options?.signal?.aborted) {
				assert.equal(++abortedRequests, 1);
				const stream = new AssistantMessageEventStream();
				const error = { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Operation aborted", api: model.api,
					provider: model.provider, model: model.id, usage: structuredClone(usage), timestamp: Date.now() };
				queueMicrotask(() => stream.push({ type: "error", reason: "aborted", error }));
				return stream;
			}
			if (++requests > 2) throw new Error("Fixture exceeded its two-response budget");
			if (requests === 2) assert.ok(context.messages.some(message => message.role === "user" && message.content[0].text.includes("compaction completed")));
			const response = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage: structuredClone(usage), timestamp: Date.now(),
				stopReason: requests === 1 ? "toolUse" : "stop", content: requests === 1
					? [{ type: "toolCall", id: "compact-native", name: "compact", arguments: {} }, { type: "toolCall", id: "sibling-native", name: "sibling", arguments: {} }]
					: [{ type: "text", text: "Task resumed" }] };
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => { stream.push({ type: "start", partial: response }); stream.push({ type: "done", reason: response.stopReason, message: response }); });
			return stream;
		},
		finishTurn: async ({ message, toolResults }, signal) => {
			h.ctx.signal = signal;
			await h.emit("turn_end", { outcome: "completed", message, toolResults });
		},
	});
	agent.subscribe(event => {
		if (event.type === "message_end") h.sm.appendMessage(event.message);
	});
	h.ctx.compact = options => {
		h.compactions.push(options);
		void (async () => {
			assert.equal(siblingFinished, true);
			assert.equal(h.sm.getBranch().filter(entry => entry.type === "message" && entry.message.role === "toolResult").length, 2);
			agent.abort();
			await agent.waitForIdle();
			assert.equal(agent.state.isStreaming, false);
			options.onComplete(completed);
		})().catch(rejectFinished);
	};
	h.pi.sendMessage = (message, options) => {
		h.messages.push({ message, options });
		assert.equal(options.triggerTurn, true);
		void agent.prompt(message.content).then(resolveFinished, rejectFinished);
	};
	let timer;
	const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Compaction/continuation deadlocked")), 5_000); });
	let firstRun;
	try {
		firstRun = agent.prompt("Do the task, compact, then continue");
		await Promise.race([started, timeout]);
		assert.equal(h.compactions.length, 0, "must wait for the slow sibling");
		releaseSibling();
		await Promise.race([Promise.all([firstRun, finished]), timeout]);
		assert.equal(requests, 2);
		assert.equal(h.compactions.length, 1);
		assert.equal(h.messages.length, 1);
		assert.equal(agent.state.messages.at(-1).content[0].text, "Task resumed");
	} finally {
		clearTimeout(timer); releaseSibling(); agent.abort();
		if (firstRun) await firstRun;
		await h.emit("session_shutdown");
	}
}
console.log("✓ native parallel-tool persistence, abort/wait without deadlock, and automatic next model turn");
