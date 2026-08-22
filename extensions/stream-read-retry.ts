import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STREAM_READ_ERROR = "stream_read_error";

/**
 * Reclassify a provider stream read failure so Pi's built-in retry loop handles it.
 * The original error is kept in the message for diagnostics.
 */
export default function streamReadRetry(pi: ExtensionAPI): void {
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant" || event.message.stopReason !== "error") return;

		const errorMessage = event.message.errorMessage;
		if (!errorMessage?.toLowerCase().includes(STREAM_READ_ERROR)) return;

		return {
			message: {
				...event.message,
				// Pi's classifier already retries errors containing "network error".
				errorMessage: `Network error: ${errorMessage}`,
			},
		};
	});
}
