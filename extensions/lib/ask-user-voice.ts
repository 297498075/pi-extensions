/** In-process, best-effort bridge; never persisted or sent as a model message. */
export const ASK_USER_VOICE_PROMPT = "ask-user:voice-prompt";
export const DEFAULT_QUESTION_VOICE_PROMPT = "有个问题需要你确认，请看一下终端。";

export interface QuestionVoicePrompt {
	text: string;
	/** Owned by the questionnaire, not its originating tool call. */
	signal: AbortSignal;
}

export function isQuestionVoicePrompt(value: unknown): value is QuestionVoicePrompt {
	if (!value || typeof value !== "object") return false;
	const data = value as Partial<QuestionVoicePrompt>;
	return typeof data.text === "string" && data.text.trim().length > 0 && data.text.length <= 500 &&
		data.signal instanceof AbortSignal;
}
