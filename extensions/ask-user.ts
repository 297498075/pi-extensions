import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	matchesKey,
	visibleWidth,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { ASK_USER_VOICE_PROMPT, DEFAULT_QUESTION_VOICE_PROMPT, type QuestionVoicePrompt } from "./lib/ask-user-voice.ts";

// ==========================================
// Schema 定义
// ==========================================

export const OptionSchema = Type.Object({
	label: Type.String({
		maxLength: 80,
		description: "简明选项显示文本 (1-5个词)",
	}),
	description: Type.Optional(
		Type.String({
			description: "每个选项都应填写：具体会怎么做、影响的行为/范围、主要收益与代价或风险、适用场景。推荐项必须结合用户当前需求解释为什么比其他项更合适；避免只写‘更好/推荐/更灵活’或复述标签。不确定的影响要明确说明。",
		}),
	),
});

export const QuestionItemSchema = Type.Object({
	question: Type.String({
		description: "向用户提出的完整具体问题，以问号结尾",
	}),
	header: Type.Optional(
		Type.String({
			maxLength: 24,
			description: "短标签/类别名 (如 '架构选择', '数据库', '确认')",
		}),
	),
	options: Type.Array(OptionSchema, {
		minItems: 1,
		maxItems: 12,
		description: "可供选择的选项列表 (1-12项)。'Type something.' 会由系统自动追加，请勿手动添加 Other",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			default: false,
			description: "是否允许多选 (默认为 false 单选)",
		}),
	),
});

export const AskUserQuestionSchema = Type.Object({
	voice_prompt: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 500,
		description: "voice 开启时自动播放的口语提醒。由你结合当前场景决定：简短呼叫用户、直接提问或概括需要确认的选择，限 1–2 句，不读代码、路径或长选项。省略则使用简短呼叫；无需另外调用 voice_speak，不会自动录音。",
	})),
	blocking: Type.Optional(Type.Boolean({
		default: true,
		description: "默认 true：等待用户回答。false：立即返回 requestId，让用户回答的同时继续不依赖该答案的工作；答案自动通知。需要答案才能继续时调用 wait_user_answer，勿把未回答或取消当成同意。",
	})),
	questions: Type.Array(QuestionItemSchema, {
		minItems: 1,
		maxItems: 4,
		description: "需要向用户询问的问题列表 (1-4个)",
	}),
});

export type OptionData = Static<typeof OptionSchema>;
export type QuestionItem = Static<typeof QuestionItemSchema>;
export type AskUserQuestionParams = Static<typeof AskUserQuestionSchema>;

interface QuestionAnswer {
	question: string;
	header?: string;
	selected: string[];
	customText?: string;
}

interface QuestionnaireResult {
	answers: QuestionAnswer[];
	cancelled: boolean;
}

const ANSWER_MESSAGE = "ask-user-answer";

export const AnswerRequestSchema = Type.Object({
	requestId: Type.String({ minLength: 1, description: "ask_user_question 返回的 requestId" }),
});

const RequestSnapshotSchema = Type.Object({
	kind: Type.Literal("ask-user/v1"),
	requestId: Type.String({ minLength: 1 }),
	status: Type.Union([Type.Literal("pending"), Type.Literal("answered"), Type.Literal("cancelled"), Type.Literal("error")]),
	questions: Type.Array(QuestionItemSchema),
	answers: Type.Array(Type.Object({
		question: Type.String(), header: Type.Optional(Type.String()),
		selected: Type.Array(Type.String()), customText: Type.Optional(Type.String()),
	})),
	cancelled: Type.Boolean(),
	reason: Type.Optional(Type.String()),
});

type RequestSnapshot = Static<typeof RequestSnapshotSchema>;
interface LiveRequest {
	snapshot: RequestSnapshot;
	controller: AbortController;
	promise: Promise<void>;
	resolve: () => void;
	ctx: ExtensionContext;
	notify: boolean;
	generation: number;
	voicePrompt?: string;
}

function requestResult(snapshot: RequestSnapshot) {
	const prefix = `Question request ${snapshot.requestId}: ${snapshot.status}.`;
	const text = snapshot.status === "pending"
		? `${prefix} Continue work that does not depend on the answer. Use get_user_answer to check, or wait_user_answer when the answer is required. Unanswered questions are not consent.`
		: snapshot.status === "answered"
			? `${prefix}\nUser answers:\n${snapshot.answers.map(a =>
				`- ${a.header ? `[${a.header}] ` : ""}${a.question}: ${a.selected.join(", ")}`).join("\n")}`
			: `${prefix} ${snapshot.reason || "User cancelled the questionnaire."} No authorization was granted.`;
	return { content: [{ type: "text" as const, text }], details: structuredClone(snapshot),
		...(snapshot.status === "error" ? { isError: true } : {}) };
}

async function waitForRequest(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw new Error("Waiting for user answer was aborted; the question remains available.");
	let abort: (() => void) | undefined;
	try {
		await Promise.race([promise, new Promise<never>((_resolve, reject) => {
			abort = () => reject(new Error("Waiting for user answer was aborted; the question remains available."));
			signal?.addEventListener("abort", abort, { once: true });
		})]);
	} finally {
		if (abort) signal?.removeEventListener("abort", abort);
	}
}

function cancelledResult() {
	return { content: [{ type: "text" as const, text: "User cancelled the questionnaire" }], details: { answers: [], cancelled: true } };
}

// ==========================================
// 辅助函数
// ==========================================

/**
 * 触发终端蜂鸣、OSC 9 桌面通知及应用内通知
 */
function notifyPrompt(title: string, ctx: ExtensionContext): void {
	try {
		if (ctx.mode !== "tui") return;
		// 1. 终端提示音
		process.stdout.write("\x07");
		// 2. OSC 9 终端原生弹窗通知 (Windows Terminal / WezTerm / iTerm2 原生支持)
		const cleanTitle = title.replace(/[\x00-\x1f]/g, " ").slice(0, 80);
		process.stdout.write(`\x1b]9;Pi 需要决策: ${cleanTitle}\x07`);
	} catch {
		// ignore
	}
	ctx.ui.notify?.(`需要用户决策: ${title.slice(0, 40)}`, "info");
}

// ==========================================
// 主扩展注册
// ==========================================

export default function askUserQuestion(pi: ExtensionAPI): void {
	const requests = new Map<string, LiveRequest>();
	let queue: LiveRequest[] = [];
	let active: LiveRequest | undefined;
	let generation = 0;

	function finish(request: LiveRequest, result: QuestionnaireResult, error?: string): void {
		if (request.snapshot.status !== "pending") return;
		request.snapshot = {
			...request.snapshot, ...result,
			status: error ? "error" : result.cancelled ? "cancelled" : "answered",
			...(error ? { reason: error } : {}),
		};
		// Submission/cancellation also stops any reminder still speaking.
		request.controller.abort();
		request.resolve();
		if (!request.notify || request.generation !== generation) return;
		try {
			// Persist before steering: queued delivery must not be the only durable copy.
			pi.appendEntry(ANSWER_MESSAGE, request.snapshot);
			pi.sendMessage({
				customType: ANSWER_MESSAGE, content: requestResult(request.snapshot).content,
				display: true, details: request.snapshot,
			}, { triggerTurn: true, deliverAs: "steer" });
		} catch {
			// A delivery failure must not discard the answer or reject a detached task.
			request.ctx.ui.notify?.("答案已保存，可通过 get_user_answer 获取；自动通知失败。", "warning");
		}
	}

	function pump(): void {
		if (active) return;
		const request = queue.shift();
		if (!request) return;
		if (request.snapshot.status !== "pending") { pump(); return; }
		active = request;
		try {
			// Only the visible FIFO questionnaire speaks. No listener means no voice dependency.
			const prompt: QuestionVoicePrompt = {
				text: request.voicePrompt?.trim() || DEFAULT_QUESTION_VOICE_PROMPT,
				signal: request.controller.signal,
			};
			pi.events.emit(ASK_USER_VOICE_PROMPT, prompt);
		} catch { /* Voice must never prevent presenting the question. */ }
		void presentQuestionnaire({ questions: request.snapshot.questions }, request.controller.signal, request.ctx)
			.then(result => finish(request, result.details), error => finish(request,
				{ answers: [], cancelled: true }, error instanceof Error ? error.message : String(error)))
			.finally(() => {
				if (active === request) { active = undefined; pump(); }
			}).catch(() => { /* Detached UI/notification failures must not leak rejections. */ });
	}

	function reset(): void {
		generation++;
		queue = [];
		active = undefined;
		for (const request of requests.values()) {
			if (request.snapshot.status !== "pending") continue;
			request.snapshot = { ...request.snapshot, reason: "Question interrupted by session shutdown or branch change." };
			request.controller.abort();
			finish(request, { answers: [], cancelled: true });
		}
		requests.clear();
	}

	function restore(ctx: ExtensionContext): void {
		reset();
		const snapshots = new Map<string, RequestSnapshot>();
		for (const entry of ctx.sessionManager.getBranch()) {
			let data: unknown;
			if (entry.type === "message" && entry.message.role === "toolResult" &&
				["ask_user_question", "get_user_answer", "wait_user_answer"].includes(entry.message.toolName)) {
				data = entry.message.details;
			} else if (entry.type === "custom_message" && entry.customType === ANSWER_MESSAGE) {
				data = entry.details;
			} else if (entry.type === "custom" && entry.customType === ANSWER_MESSAGE) {
				data = entry.data;
			}
			if (!Check(RequestSnapshotSchema, data)) continue;
			// A fast RPC response can be persisted before the initial pending tool result.
			if (data.status === "pending" && snapshots.get(data.requestId)?.status !== undefined) continue;
			snapshots.set(data.requestId, data);
		}
		for (const stored of snapshots.values()) {
			const snapshot: RequestSnapshot = stored.status === "pending" ? {
				...stored, status: "cancelled", cancelled: true, answers: [],
				reason: "Question interrupted by session reload or branch change. Ask again if still needed.",
			} : stored;
			requests.set(snapshot.requestId, {
				snapshot, controller: new AbortController(), promise: Promise.resolve(), resolve() {},
				ctx, notify: false, generation,
			});
		}
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", () => reset());

	for (const wait of [false, true]) {
		pi.registerTool({
			name: wait ? "wait_user_answer" : "get_user_answer",
			label: wait ? "Wait for User Answer" : "Get User Answer",
			description: wait
				? "Wait for an ask_user_question request only when further work requires its answer. Returns immediately if already answered/cancelled/failed. Aborting this wait does not cancel the question. Never treat cancellation as consent."
				: "Check an ask_user_question request by requestId without waiting. Returns pending, answered, cancelled, or error. Do not busy-poll: continue independent work or call wait_user_answer when the answer is required.",
			parameters: AnswerRequestSchema,
			async execute(_id, { requestId }, signal) {
				const request = requests.get(requestId);
				if (!request) return {
					content: [{ type: "text" as const, text: `Unknown requestId: ${requestId}. It is not available on this session branch; ask again if needed.` }],
					details: { requestId, status: "not_found" }, isError: true,
				};
				if (wait && request.snapshot.status === "pending") {
					await waitForRequest(request.promise, signal);
				}
				return requestResult(request.snapshot);
			},
		});
	}

	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description: `Ask the user one or more structured questions during execution.
Use when requirements, scope, behavior, or implementation choices are ambiguous and you need the user's decision to proceed.

Guidelines:
- Each question must provide 1 to 12 clear, distinct options.
- Provide a concise label (1-5 words) AND a clear description for EVERY option. State what will actually be done, affected behavior/scope, benefits, meaningful costs/risks, and when that option fits. Use concrete language the user can compare; do not merely restate the label or say "better/more flexible".
- For a recommended option, explain WHY it fits this user's current goals and constraints better than the alternatives, and disclose its downside. Do not invent benefits or certainty; identify material unknowns. Keep descriptions concise but sufficient for an informed decision.
- The system automatically appends a "Type something..." option for custom user input; do NOT author an "Other" option yourself.
- Set multiSelect: true if multiple options can be chosen simultaneously.
- If you recommend a specific choice, make it the first option and append "(Recommended)" to its label; the label never replaces the explanation.
- blocking defaults to true (wait for the answer). Use blocking: false when useful independent work can continue: you receive a requestId immediately and the answer is automatically delivered as a steering message at the next processing boundary (pending tools may be skipped; already running tools are not forcibly aborted).
- Use get_user_answer to check without blocking. Call wait_user_answer with that requestId once further work truly depends on the answer. Do not busy-poll, assume an unanswered choice, or treat cancellation as authorization.
- Set voice_prompt to a concise, conversational reminder suited to the moment: call the user over, ask the question aloud, or summarize the decision in 1-2 sentences. When voice is enabled it plays automatically alongside the questionnaire; do not also call voice_speak for the same question. Omit it for a generic spoken alert. This does not start recording or accept spoken answers.
`,
		parameters: AskUserQuestionSchema,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI || !params.questions?.length || signal?.aborted) {
				return presentQuestionnaire(params, signal, ctx);
			}
			let resolve!: () => void;
			const request: LiveRequest = {
				snapshot: {
					kind: "ask-user/v1", requestId: randomUUID(), status: "pending",
					questions: structuredClone(params.questions), answers: [], cancelled: false,
				},
				controller: new AbortController(), promise: new Promise<void>(done => { resolve = done; }),
				resolve, ctx, notify: params.blocking === false, generation, voicePrompt: params.voice_prompt,
			};
			requests.set(request.snapshot.requestId, request);
			queue.push(request);
			const abort = () => {
				request.controller.abort();
				finish(request, { answers: [], cancelled: true });
			};
			// Detached questions outlive the originating tool call's AbortSignal.
			if (params.blocking !== false) signal?.addEventListener("abort", abort, { once: true });
			pump();
			if (params.blocking === false) return requestResult(request.snapshot);
			try {
				await request.promise;
				return requestResult(request.snapshot);
			} finally {
				signal?.removeEventListener("abort", abort);
			}
		},
	});
}

async function presentQuestionnaire(typedParams: AskUserQuestionParams, _signal: AbortSignal | undefined,
	ctx: ExtensionContext): Promise<{ content: { type: "text"; text: string }[]; details: QuestionnaireResult }> {
			if (!typedParams.questions || typedParams.questions.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No questions provided" }],
					details: { answers: [], cancelled: true },
				};
			}

			// 非交互或无 UI 模式降级
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: { answers: [], cancelled: true },
				};
			}

			if (_signal?.aborted) return cancelledResult();
			notifyPrompt(typedParams.questions[0].question, ctx);

			// RPC 模式 (如 VSCode 插件端 / Zed) 降级交互
			if (ctx.mode === "rpc") {
				const answers: QuestionAnswer[] = [];
				for (const q of typedParams.questions) {
					if (q.multiSelect) {
						const selected = new Set<number>();
						let customText: string | undefined;
						const finish = "✓ Done selecting";
						const custom = "✎ Type something (custom answer)...";
						for (;;) {
							const choices = q.options.map((option, index) =>
								`${selected.has(index) ? "[x]" : "[ ]"} ${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`);
							const choice = await ctx.ui.select(q.question, [...choices, custom, finish], { signal: _signal });
							if (choice === undefined || _signal?.aborted) return cancelledResult();
							if (choice === finish) break;
							if (choice === custom) {
								const text = await ctx.ui.input("Enter your custom answer:", customText || "", { signal: _signal });
								if (text === undefined || _signal?.aborted) return cancelledResult();
								customText = text.trim() || undefined;
							} else {
								const index = choices.indexOf(choice);
								if (index >= 0) {
									if (selected.has(index)) selected.delete(index);
									else selected.add(index);
								}
							}
						}
						answers.push({ question: q.question, header: q.header,
							selected: [...q.options.filter((_option, index) => selected.has(index)).map(option => option.label), ...(customText ? [customText] : [])],
							customText });
						continue;
					}
					const optionLabels = q.options.map((o) => (o.description ? `${o.label} - ${o.description}` : o.label));
					const customChoice = "Type something (custom answer)...";
					optionLabels.push(customChoice);

					const choice = await ctx.ui.select(q.question, optionLabels, { signal: _signal });
					if (choice === undefined || _signal?.aborted) {
						return {
							content: [{ type: "text", text: "User cancelled the questionnaire" }],
							details: { answers: [], cancelled: true },
						};
					}

					if (choice === customChoice) {
						const customVal = await ctx.ui.input("Enter your custom answer:", "", { signal: _signal });
						if (customVal === undefined || _signal?.aborted) return cancelledResult();
						answers.push({
							question: q.question,
							header: q.header,
							selected: [customVal?.trim() || "(empty)"],
							customText: customVal?.trim(),
						});
					} else {
						const selectedLabel = q.options.find((o) =>
							o.description ? `${o.label} - ${o.description}` === choice : o.label === choice,
						)?.label || choice;
						answers.push({
							question: q.question,
							header: q.header,
							selected: [selectedLabel],
						});
					}
				}

				return {
					content: [
						{
							type: "text",
							text:
								"User answers:\n" +
								answers.map((a) => `- ${a.header ? `[${a.header}] ` : ""}${a.question}: ${a.selected.join(", ")}`).join("\n"),
						},
					],
					details: { answers, cancelled: false },
				};
			}

			// TUI 模式：半屏紧凑浮窗 + 原生 Input 硬件光标/IME 定位 + 提交 Review
			const totalQuestions = typedParams.questions.length;
			const reviewTabIndex = totalQuestions;
			const totalTabs = totalQuestions + 1;

			let cancelDialog: (() => void) | undefined;
			const onAbort = () => cancelDialog?.();
			_signal?.addEventListener("abort", onAbort, { once: true });
			const result = await ctx.ui.custom<QuestionnaireResult>(
				(tui, theme, _kb, done) => {
					cancelDialog = () => done({ answers: [], cancelled: true });
					if (_signal?.aborted) cancelDialog();
					let currentTab = 0;
					let isMinimized = false;
					let cachedLines: string[] | undefined;

					// 各问题的回答与选中状态
					interface QuestionState {
						cursorIndex: number;
						scrollOffset: number;
						selectedIndices: Set<number>;
						customInput: Input; // 原生 Input 驱动硬件光标与 IME 定位
						singleSelectedIndex?: number;
					}

					const states: QuestionState[] = typedParams.questions.map(() => {
						const input = new Input({
							prompt: "自定义: ",
							placeholder: "直接打字输入，Enter确认",
						});
						return {
							cursorIndex: 0,
							scrollOffset: 0,
							selectedIndices: new Set<number>(),
							customInput: input,
						};
					});

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function getCurrentQ(): QuestionItem | undefined {
						return typedParams.questions[currentTab];
					}

					function getCurrentState(): QuestionState | undefined {
						return states[currentTab];
					}

					function getDisplayOptions(q: QuestionItem): Array<{ label: string; description?: string; isCustom?: boolean }> {
						const list = q.options.map((o) => ({ label: o.label, description: o.description, isCustom: false }));
						list.push({ label: "Type something...", description: "输入自定义回复 (键入即选中，支持 ←→ 移动光标)", isCustom: true });
						return list;
					}

					function getSelectedLabels(qIndex: number): string[] {
						const q = typedParams.questions[qIndex];
						const st = states[qIndex];
						const opts = getDisplayOptions(q);
						const customIdx = opts.length - 1;
						const results: string[] = [];
						const customVal = st.customInput.getValue().trim();

						if (q.multiSelect) {
							for (let i = 0; i < opts.length; i++) {
								if (st.selectedIndices.has(i)) {
									if (i === customIdx) {
										if (customVal) {
											results.push(`[自定义] ${customVal}`);
										}
									} else {
										results.push(opts[i].label);
									}
								}
							}
						} else {
							// 单选
							if (st.singleSelectedIndex !== undefined && opts[st.singleSelectedIndex]) {
								if (st.singleSelectedIndex === customIdx) {
									if (customVal) {
										results.push(`[自定义] ${customVal}`);
									}
								} else {
									results.push(opts[st.singleSelectedIndex].label);
								}
							}
						}
						return results;
					}

					function submitAll() {
						const finalAnswers: QuestionAnswer[] = [];
						for (let i = 0; i < totalQuestions; i++) {
							const q = typedParams.questions[i];
							const st = states[i];
							const selected = getSelectedLabels(i);
							const customVal = st.customInput.getValue().trim();
							finalAnswers.push({
								question: q.question,
								header: q.header,
								selected: selected.length > 0 ? selected : ["(未作答)"],
								customText: customVal || undefined,
							});
						}
						done({ answers: finalAnswers, cancelled: false });
					}

					function handleInput(data: string): void {
						// 1. 最小化处理
						if (isMinimized) {
							if (matchesKey(data, Key.escape)) {
								done({ answers: [], cancelled: true });
								return;
							}
							isMinimized = false;
							refresh();
							return;
						}

						// 快捷最小化切换：Ctrl+] 或 Alt+H
						if (matchesKey(data, Key.ctrl("]")) || matchesKey(data, Key.alt("h"))) {
							isMinimized = true;
							refresh();
							return;
						}

						// 2. Review 提交确认页交互
						if (currentTab === reviewTabIndex) {
							if (matchesKey(data, Key.enter) || data === "s" || data === "S") {
								submitAll();
								return;
							}
							// 左右方向键与 Tab/Shift+Tab 切换题目
							if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.up)) {
								currentTab = totalQuestions - 1;
								refresh();
								return;
							}
							if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
								currentTab = 0; // 循环切回第一题
								refresh();
								return;
							}
							const digit = parseInt(data, 10);
							if (!isNaN(digit) && digit >= 1 && digit <= totalQuestions) {
								currentTab = digit - 1;
								refresh();
								return;
							}
							if (matchesKey(data, Key.escape)) {
								done({ answers: [], cancelled: true });
								return;
							}
							return;
						}

						// 3. 普通题目操作
						const q = getCurrentQ();
						const st = getCurrentState();
						if (!q || !st) return;

						const opts = getDisplayOptions(q);
						const customIndex = opts.length - 1;
						const isAtCustom = st.cursorIndex === customIndex;

						// Tab 与 Shift+Tab: 在任何地方都可以随时切换题目
						if (totalTabs > 1) {
							if (matchesKey(data, Key.tab)) {
								st.customInput.focused = false;
								currentTab = (currentTab + 1) % totalTabs;
								refresh();
								return;
							}
							if (matchesKey(data, Key.shift("tab"))) {
								st.customInput.focused = false;
								currentTab = (currentTab - 1 + totalTabs) % totalTabs;
								refresh();
								return;
							}
						}

						// Esc: 取消问答
						if (matchesKey(data, Key.escape)) {
							done({ answers: [], cancelled: true });
							return;
						}

						// ---------------------------------------------------------
						// 光标正处于“自定义输入”行：
						// 由原生 Input 组件接管字符、左右箭头移动、退格与 IME 输入定位
						// 注意：这里的 ← 和 → 绝不切题，严格用于在输入框中移动光标！
						// ---------------------------------------------------------
						if (isAtCustom) {
							// 离开自定义行：Up 向上移动到普通选项
							if (matchesKey(data, Key.up)) {
								st.customInput.focused = false;
								st.cursorIndex = Math.max(0, st.cursorIndex - 1);
								refresh();
								return;
							}

							// Enter: 确认本题并前往下一题 / Review
							if (matchesKey(data, Key.enter)) {
								const val = st.customInput.getValue().trim();
								if (val) {
									if (q.multiSelect) st.selectedIndices.add(customIndex);
									else st.singleSelectedIndex = customIndex;
								}
								st.customInput.focused = false;
								currentTab++;
								refresh();
								return;
							}

							// 其它所有键（包括文字、中文输入、←、→、Home、End、Backspace）交给 Input 处理
							st.customInput.focused = true;
							st.customInput.handleInput(data);
							const val = st.customInput.getValue();

							// 只要有文本内容，自动打勾
							if (val.trim().length > 0) {
								if (q.multiSelect) st.selectedIndices.add(customIndex);
								else st.singleSelectedIndex = customIndex;
							} else {
								if (q.multiSelect) st.selectedIndices.delete(customIndex);
								else if (st.singleSelectedIndex === customIndex) st.singleSelectedIndex = undefined;
							}
							refresh();
							return;
						}

						// ---------------------------------------------------------
						// 普通选项操作区 (光标在选项 1 ~ N-1 上)
						// 在此区域中：← 和 → 直接切换题目！
						// ---------------------------------------------------------

						// 左右方向键切换题目 (Left/Right)
						if (totalTabs > 1) {
							if (matchesKey(data, Key.left)) {
								st.customInput.focused = false;
								currentTab = (currentTab - 1 + totalTabs) % totalTabs;
								refresh();
								return;
							}
							if (matchesKey(data, Key.right)) {
								st.customInput.focused = false;
								currentTab = (currentTab + 1) % totalTabs;
								refresh();
								return;
							}
						}

						// 光标上下移动
						if (matchesKey(data, Key.up)) {
							st.cursorIndex = Math.max(0, st.cursorIndex - 1);
							if (st.cursorIndex === customIndex) st.customInput.focused = true;
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							st.cursorIndex = Math.min(opts.length - 1, st.cursorIndex + 1);
							if (st.cursorIndex === customIndex) st.customInput.focused = true;
							refresh();
							return;
						}

						// 数字键 1-9 快速处理
						const digit = parseInt(data, 10);
						if (!isNaN(digit) && digit >= 1 && digit <= opts.length) {
							const targetIdx = digit - 1;
							st.cursorIndex = targetIdx;
							if (targetIdx === customIndex) {
								st.customInput.focused = true;
								refresh();
								return;
							}
							if (q.multiSelect) {
								if (st.selectedIndices.has(targetIdx)) {
									st.selectedIndices.delete(targetIdx);
								} else {
									st.selectedIndices.add(targetIdx);
								}
							} else {
								st.singleSelectedIndex = targetIdx;
								currentTab++;
							}
							refresh();
							return;
						}

						// 空格键：多选模式切换勾选；单选标记当前
						if (data === " ") {
							if (q.multiSelect) {
								if (st.selectedIndices.has(st.cursorIndex)) {
									st.selectedIndices.delete(st.cursorIndex);
								} else {
									st.selectedIndices.add(st.cursorIndex);
								}
								refresh();
								return;
							} else {
								st.singleSelectedIndex = st.cursorIndex;
								refresh();
								return;
							}
						}

						// Enter 回车键：多选进入下一题，单选确认当前项并进入下一题
						if (matchesKey(data, Key.enter)) {
							if (q.multiSelect) {
								currentTab++;
								refresh();
								return;
							} else {
								st.singleSelectedIndex = st.cursorIndex;
								currentTab++;
								refresh();
								return;
							}
						}
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;

						const renderWidth = Math.max(2, width);
						const lines: string[] = [];

						// 1. 最小化呈现
						if (isMinimized) {
							const hint = " [⏸ Agent 等待决策中... 按 Ctrl+] 或 任意键 展开 | Esc 放弃] ";
							lines.push(theme.style(hint.padEnd(renderWidth, " "), { fg: "accent", bold: true }));
							cachedLines = lines;
							return lines;
						}

						// 2. 顶部边框与多题 Tab 栏
						const tabsList: string[] = [];
						for (let i = 0; i < totalQuestions; i++) {
							const q = typedParams.questions[i];
							const isActive = i === currentTab;
							const hasSelected = getSelectedLabels(i).length > 0;
							const tag = q.header || `Q${i + 1}`;
							const check = hasSelected ? "✓ " : "";
							if (isActive) {
								tabsList.push(theme.style(`[ ${check}${i + 1}. ${tag} ]`, { fg: "accent", bold: true }));
							} else {
								tabsList.push(theme.fg(hasSelected ? "text" : "muted", ` ${check}${i + 1}. ${tag} `));
							}
						}
						// 加上 Review Tab
						const isReviewActive = currentTab === reviewTabIndex;
						if (isReviewActive) {
							tabsList.push(theme.style("[ 📋 提交确认 ]", { fg: "warning", bold: true }));
						} else {
							tabsList.push(theme.fg("muted", " 📋 提交确认 "));
						}

						const tabsStr = tabsList.join(" ");
						lines.push(
							theme.fg("accent", "╭─ ") +
								tabsStr +
								" " +
								theme.fg("accent", "─".repeat(Math.max(2, renderWidth - visibleWidth(tabsStr) - 6)) + "╮"),
						);

						// 3. 视图分支 A：Review 提交确认页
						if (currentTab === reviewTabIndex) {
							lines.push(`│ ${theme.style("📋 请检查并确认您的所有选择 (Review Answers)", { fg: "text", bold: true })}`);
							lines.push("│");

							for (let i = 0; i < totalQuestions; i++) {
								const q = typedParams.questions[i];
								const tag = q.header ? `[${q.header}] ` : "";
								const selected = getSelectedLabels(i);
								lines.push(`│ ${theme.fg("accent", `${i + 1}. `)}${theme.style(`${tag}${q.question}`, { fg: "text", bold: true })}`);

								if (selected.length === 0) {
									lines.push(`│    ${theme.fg("warning", "⚠ (未作答 / 跳过)")}`);
								} else {
									for (const item of selected) {
										lines.push(`│    ${theme.fg("success", "✓")} ${theme.fg("text", item)}`);
									}
								}
								lines.push("│");
							}

							lines.push("│");
							const submitBtn = theme.style(" [ 🚀 确认并提交所有答案 (Enter / S) ] ", { fg: "accent", bold: true });
							const backBtn = theme.fg("dim", " [ ↩ 返回上一题修改 (Left / [) ] ");
							lines.push(`│  ${submitBtn}  ${backBtn}`);
							lines.push("│");
							lines.push(`│ ${theme.fg("dim", "Enter/S 提交 · ← 或 Shift+Tab 回退 · 1-9 跳回对应题目 · Esc 取消")}`);
							lines.push(theme.fg("accent", "╰" + "─".repeat(renderWidth - 2) + "╯"));

							cachedLines = lines;
							return lines;
						}

						// ----------------------------------------------------
						// 4. 视图分支 B：当前问题问答页
						// ----------------------------------------------------
						const q = getCurrentQ()!;
						const st = getCurrentState()!;
						const modeBadge = q.multiSelect
							? theme.style(" [多选: 空格勾选, Enter进入下一题] ", { fg: "warning", bold: true })
							: theme.fg("dim", " [单选: Enter/数字键确认] ");

						lines.push(`│ ${theme.style("❓ " + q.question, { fg: "text", bold: true })}${modeBadge}`);
						lines.push("│");

						// 选项列表 (含虚拟滚动)
						// 控制总高度在终端 40% 左右：限制最多可视 4 项选项，使整个交互框保持在 9~12 行以内
						const opts = getDisplayOptions(q);
						const customIndex = opts.length - 1;
						const maxVisibleOptions = 4;
						const totalOpts = opts.length;

						if (st.cursorIndex < st.scrollOffset) {
							st.scrollOffset = st.cursorIndex;
						} else if (st.cursorIndex >= st.scrollOffset + maxVisibleOptions) {
							st.scrollOffset = st.cursorIndex - maxVisibleOptions + 1;
						}

						const visibleStart = st.scrollOffset;
						const visibleEnd = Math.min(totalOpts, visibleStart + maxVisibleOptions);

						if (visibleStart > 0) {
							lines.push(`│   ${theme.fg("dim", "▲ ... 更多上方选项 ...")}`);
						}

						for (let i = visibleStart; i < visibleEnd; i++) {
							const opt = opts[i];
							const isCursor = i === st.cursorIndex;
							const isChecked = q.multiSelect
								? st.selectedIndices.has(i)
								: st.singleSelectedIndex === i;
							const isCustom = i === customIndex;
							// 序号前缀：所有普通选项均显示对齐序号，第 10 项及以后显示 10. 11. 12.
							const num = isCustom ? "   " : `${String(i + 1).padStart(2, " ")}. `;

							let marker = "  ";
							if (q.multiSelect) {
								marker = isChecked ? theme.style("[x] ", { fg: "accent", bold: true }) : theme.fg("muted", "[ ] ");
							} else {
								marker = isChecked ? theme.style("(•) ", { fg: "accent", bold: true }) : theme.fg("muted", "( ) ");
							}

							const cursorPointer = isCursor ? theme.fg("accent", "❯ ") : "  ";

							// 渲染项：如果是自定义行，由原生 Input 组件渲染（自动带 CURSOR_MARKER 定位硬件光标与 IME 浮窗）
							if (isCustom) {
								st.customInput.focused = isCursor;
								const inputWidth = Math.max(10, renderWidth - 14);
								const [renderedInput] = st.customInput.render(inputWidth);
								lines.push(`│ ${cursorPointer}${num}${marker}${renderedInput.trimEnd()}`);
							} else {
								const labelColor = isCursor ? "accent" : isChecked ? "accent" : "text";
								const labelContent = theme.style(opt.label, { fg: labelColor, bold: isCursor || isChecked });
								lines.push(`│ ${cursorPointer}${num}${marker}${labelContent}`);
							}

							// 选项说明 (如有，且非当前正在输入的自定义行)
							if (opt.description && !(isCustom && isCursor)) {
								const descIndent = 8;
								const wrappedDesc = wrapTextWithAnsi(theme.fg("muted", opt.description), renderWidth - descIndent - 4);
								for (const d of wrappedDesc) {
									lines.push(`│ ${" ".repeat(descIndent)}${d}`);
								}
							}
						}

						if (visibleEnd < totalOpts) {
							lines.push(`│   ${theme.fg("dim", "▼ ... 更多下方选项 ...")}`);
						}

						// 底部操作提示
						lines.push("│");
						const multiHints = q.multiSelect
							? "Space 切换勾选 · Enter 下一题 · "
							: "Enter 确认本题 · ";
						const isAtCustomRow = st.cursorIndex === customIndex;
						const navHints = isAtCustomRow
							? "←/→ 移动文字光标 · Tab 切换题目 · "
							: (totalTabs > 1 ? "←/→ 或 Tab 切换题目 · " : "");
						const footerHints = `↑/↓ 移动 · ${multiHints}${navHints}Ctrl+] 最小化 · Esc 取消`;

						lines.push(`│ ${theme.fg("dim", footerHints)}`);
						lines.push(theme.fg("accent", "╰" + "─".repeat(renderWidth - 2) + "╯"));

						cachedLines = lines;
						return lines;
					}

					return {
						render(width: number) {
							// Reflow every textual line, including question, labels and
							// review answers. Never hand an overwide line to Pi's TUI.
							cachedLines = undefined;
							return render(width).flatMap(line => wrapTextWithAnsi(line, Math.max(1, width)))
								.map(line => truncateToWidth(line, Math.max(1, width)));
						},
						dispose() { _signal?.removeEventListener("abort", onAbort); },
						invalidate: () => {
							cachedLines = undefined;
						},
						handleInput,
					};
				},
			).finally(() => _signal?.removeEventListener("abort", onAbort));

			if (!result || result.cancelled || result.answers.length === 0) {
				return {
					content: [{ type: "text", text: "User cancelled the prompt / answered nothing." }],
					details: { answers: [], cancelled: true },
				};
			}

			// 格式化输出供模型理解
			const summaryText =
				"User answers:\n" +
				result.answers
					.map((a) => {
						const tag = a.header ? `[${a.header}] ` : "";
						return `- ${tag}${a.question} -> ${a.selected.join(", ")}`;
					})
					.join("\n");

			return {
				content: [{ type: "text", text: summaryText }],
				details: {
					answers: result.answers,
					cancelled: false,
				},
			};
}
