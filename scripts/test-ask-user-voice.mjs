import assert from "node:assert/strict";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import askUser, { AskUserQuestionSchema } from "../extensions/ask-user.ts";
import voiceExtension, { DEFAULT_CONFIG } from "../extensions/voice.ts";
import { ASK_USER_VOICE_PROMPT, DEFAULT_QUESTION_VOICE_PROMPT } from "../extensions/lib/ask-user-voice.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
const question = { questions: [{ question: "要保留旧配置吗？", options: [{ label: "保留" }] }] };
const answer = { answers: [{ question: question.questions[0].question, selected: ["保留"] }], cancelled: false };
const theme = { fg: (_color, text) => text, style: text => text };

function harness({ enabled = true, voice = true, reverse = false } = {}) {
	const tools = new Map(), commands = new Map(), hooks = new Map();
	const events = createEventBus(), prompts = [], speeches = [], recordings = [], deliveries = [], dialogs = [];
	let active = [], failSpeech = false, branch = [];
	events.on(ASK_USER_VOICE_PROMPT, data => prompts.push(data));
	const pi = {
		events,
		registerTool(tool) { tools.set(tool.name, tool); active.push(tool.name); },
		registerCommand(name, command) { commands.set(name, command); }, registerShortcut() {},
		on(name, handler) { const list = hooks.get(name) ?? []; list.push(handler); hooks.set(name, list); },
		getActiveTools: () => active, setActiveTools: names => { active = names; },
		sendMessage: (...args) => deliveries.push(args), appendEntry() {},
		sendUserMessage() { throw Error("must not deliver microphone input"); },
	};
	const config = { ...structuredClone(DEFAULT_CONFIG), defaultEnabled: enabled, voicesCacheByGateway: { [DEFAULT_CONFIG.gatewayUrl]: [] } };
	const store = { get: () => structuredClone(config) };
	const gateway = {
		speak(text, options) {
			let resolve;
			const promise = new Promise(done => { resolve = done; });
			speeches.push({ text, ...options, resolve });
			return failSpeech ? Promise.reject(Error("gateway unavailable")) : promise;
		},
		recordAndTranscribe(options) {
			recordings.push(options);
			return new Promise(() => {});
		},
		getVoices() { throw Error("must use cached voices"); },
	};
	const loadVoice = () => { if (voice) voiceExtension(pi, { config: store, gateway: () => gateway }); };
	if (reverse) { loadVoice(); askUser(pi); } else { askUser(pi); loadVoice(); }
	const ctx = {
		hasUI: true, mode: "tui", isIdle: () => true,
		sessionManager: { getBranch: () => branch },
		ui: {
			notify() {}, setStatus() {},
			custom(factory) {
				return new Promise((resolve, reject) => {
					let done = false, component;
					const close = result => { if (done) return; done = true; component?.dispose(); resolve(result); };
					component = factory({ requestRender() {} }, theme, {}, close);
					dialogs.push({ close, fail(error) { component.dispose(); reject(error); } });
				});
			},
		},
	};
	const hook = (name, context = ctx) => { for (const handler of hooks.get(name) ?? []) handler({}, context); };
	hook("session_start");
	return {
		ctx, tools, prompts, speeches, recordings, deliveries, dialogs, events, hook,
		call: (name, args, signal, context = ctx) => tools.get(name).execute(name, args, signal, undefined, context),
		command: args => commands.get("voice").handler(args, ctx),
		set failure(value) { failSpeech = value; }, set branch(value) { branch = value; },
		close: () => hook("session_shutdown"),
	};
}

assert(Check(AskUserQuestionSchema, { ...question, voice_prompt: "请来确认一下。" }));
for (const voice_prompt of ["", "x".repeat(501), 123, null]) {
	assert.equal(Check(AskUserQuestionSchema, { ...question, voice_prompt }), false);
}

// These tests run only against a controlled gateway: no real audio, network, or personal config.
const stdoutWrite = process.stdout.write;
process.stdout.write = () => true;
try {
	for (const reverse of [false, true]) {
		const h = harness({ reverse });
		try {
			const result = h.call("ask_user_question", { ...question, blocking: false, voice_prompt: "过来确认一下，要保留旧配置吗？" });
			assert.equal(h.dialogs.length, 1, "dialog opens without waiting for speech");
			const pending = await result; await tick();
			assert.equal(pending.details.status, "pending");
			assert.equal(h.speeches[0].text, "过来确认一下，要保留旧配置吗？");
			assert.equal(h.recordings.length, 0, "asking never opens a microphone");
			await h.call("get_user_answer", { requestId: pending.details.requestId });
			const waitAbort = new AbortController();
			const waiting = h.call("wait_user_answer", { requestId: pending.details.requestId }, waitAbort.signal);
			waitAbort.abort(); await assert.rejects(waiting, /aborted/);
			assert.equal(h.speeches[0].signal.aborted, false, "aborting only the waiter preserves question and speech");
			assert.equal(h.prompts.length, 1, "query/wait must not replay speech");
			h.dialogs[0].close(answer); await tick();
			assert(h.speeches[0].signal.aborted, "submitting stops the reminder");
			const answered = await h.call("get_user_answer", { requestId: pending.details.requestId });
			assert.equal(answered.details.status, "answered"); assert.equal(h.deliveries.length, 1);
		} finally { h.close(); }
	}

	// Immediate answers/preflight off invalidate reminders before the asynchronous voice handoff.
	for (const action of ["answer", "off", "session_tree"]) {
		const h = harness();
		try {
			const p = h.call("ask_user_question", question);
			if (action === "answer") h.dialogs[0].close(answer);
			else if (action === "off") await h.command("off");
			else h.hook("session_tree");
			await tick();
			// An answer may race the first speech microtask, but must always cancel it promptly.
			if (action === "answer") assert(h.speeches.every(speech => speech.signal.aborted));
			else assert.equal(h.speeches.length, 0);
			if (action === "off") h.dialogs[0].close(answer);
			await p;
		} finally { h.close(); }
	}

	// A detached prompt outlives its tool signal; subsequent visible dialogs speak in FIFO order.
	{
		const h = harness();
		try {
			const origin = new AbortController();
			await h.call("ask_user_question", { ...question, blocking: false }, origin.signal);
			origin.abort(); await tick();
			assert.equal(h.speeches[0].text, DEFAULT_QUESTION_VOICE_PROMPT);
			assert.equal(h.speeches[0].signal.aborted, false);
			const secondAbort = new AbortController();
			const second = h.call("ask_user_question", { ...question, voice_prompt: "第二个问题，请确认。" }, secondAbort.signal);
			await tick(); assert.equal(h.prompts.length, 1); assert.equal(h.dialogs.length, 1);
			h.dialogs[0].close(answer); await tick(); await tick();
			assert.equal(h.speeches.length, 2, "next prompt waits for previous abort cleanup, not its gateway promise");
			assert.equal(h.speeches[1].text, "第二个问题，请确认。");
			assert.equal(h.dialogs.length, 2);
			secondAbort.abort(); assert.equal((await second).details.status, "cancelled"); await tick();
			assert(h.speeches[1].signal.aborted);
		} finally { h.close(); }
	}

	for (const settings of [{ enabled: false }, { voice: false }]) {
		const h = harness(settings);
		try {
			const p = h.call("ask_user_question", question); await tick();
			assert.equal(h.speeches.length, 0); assert.equal(h.dialogs.length, 1);
			h.dialogs[0].close(answer); assert.equal((await p).details.status, "answered");
		} finally { h.close(); }
	}

	// Busy audio and gateway failure are best effort: no retries, and the dialog remains usable.
	for (const busy of [false, true]) {
		const h = harness();
		try {
			h.failure = !busy;
			const explicit = busy ? h.call("voice_speak", { text: "正在播报进度。" }) : undefined;
			const p = h.call("ask_user_question", question); await tick();
			assert.equal(h.speeches.length, 1, "no interruption or automatic retry");
			if (busy) assert.equal(h.speeches[0].signal.aborted, false);
			h.dialogs[0].close(answer); assert.equal((await p).details.status, "answered");
			if (busy) { assert.equal(h.speeches[0].signal.aborted, false); await h.command("stop"); await explicit; }
		} finally { h.close(); }
	}

	// Stop/off and session replacement cancel reminders without replay on re-enable.
	for (const action of ["stop", "off", "session_shutdown", "session_before_switch", "session_before_fork", "session_tree"]) {
		const h = harness();
		try {
			await h.call("ask_user_question", { ...question, blocking: false }); await tick();
			if (action.startsWith("session_")) h.hook(action); else await h.command(action);
			await tick(); assert(h.speeches[0].signal.aborted, action);
			await h.command("on"); await tick(); assert.equal(h.speeches.length, 1, "no stale replay after " + action);
		} finally { h.close(); }
	}

	// Suppress queued or pre-aborted prompts and do not replay restored requests.
	{
		const h = harness();
		try {
			const aborted = new AbortController(); aborted.abort();
			await h.call("ask_user_question", question, aborted.signal);
			assert.equal(h.prompts.length, 0);
			const p = await h.call("ask_user_question", { ...question, blocking: false });
			const abortQueued = new AbortController();
			const queued = h.call("ask_user_question", question, abortQueued.signal); abortQueued.abort();
			await queued; h.dialogs[0].close(answer); await tick();
			assert.equal(h.prompts.length, 1);
			h.branch = [{ type: "message", message: { role: "toolResult", toolName: "ask_user_question", details: p.details } }];
			h.hook("session_start"); await tick(); assert.equal(h.prompts.length, 1);
			assert.equal((await h.call("get_user_answer", { requestId: p.details.requestId })).details.status, "cancelled");
		} finally { h.close(); }
	}

	{
		const h = harness();
		try {
			await h.call("ask_user_question", question, undefined, { hasUI: false, mode: "print" });
			assert.equal(h.prompts.length, 0, "headless requests never speak");
			let selectAnswer;
			const rpc = { ...h.ctx, mode: "rpc", ui: { ...h.ctx.ui, select: () => new Promise(resolve => { selectAnswer = resolve; }) } };
			const p = h.call("ask_user_question", question, undefined, rpc); await tick();
			assert.equal(h.speeches.length, 1, "RPC uses the enabled voice gateway as well");
			selectAnswer("保留"); assert.equal((await p).details.status, "answered");
			for (const data of [null, {}, { text: "x" }, { text: "x".repeat(501), signal: new AbortController().signal }]) h.events.emit(ASK_USER_VOICE_PROMPT, data);
			await tick(); assert.equal(h.speeches.length, 1, "malformed bus messages are ignored");
		} finally { h.close(); }
	}

	// Live is only suspended by the existing speak operation; no extra recording is started.
	{
		const h = harness();
		try {
			await h.command("live on"); assert.equal(h.recordings.length, 1);
			const p = h.call("ask_user_question", question); await tick();
			assert(h.recordings[0].signal.aborted); assert.equal(h.recordings.length, 1);
			h.dialogs[0].close(answer); await p; await tick();
			assert.equal(h.recordings.length, 2, "only already-enabled Live resumes");
		} finally { h.close(); }
	}
} finally { process.stdout.write = stdoutWrite; }
console.log("✓ ask-user/voice bridge: model wording, fallback, blocking/detached/FIFO, cancellation, failures, lifecycle and mode isolation");
