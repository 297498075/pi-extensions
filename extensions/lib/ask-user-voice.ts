/** In-process, best-effort bridge; never persisted or sent as a model message. */
export const ASK_USER_VOICE_PROMPT = "ask-user:voice-prompt";
export const DEFAULT_QUESTION_VOICE_PROMPT = "There is a question for you to confirm, please check the terminal.";

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
