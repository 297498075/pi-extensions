import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Transport-level signatures of a premature stream end that Pi's built-in
 * retry classifier does not currently recognize.
 *
 * Pi's `isRetryableAssistantError` (see `pi-ai/dist/utils/retry.js`) matches a
 * fixed list of transient-error phrases. It covers several premature-stream
 * endings ("ended without", "stream ended before message_stop", "websocket
 * closed", ...) but misses the wording emitted when a provider/WebSocket stream
 * closes before its terminal completion event, e.g.:
 *
 *   "stream error: stream disconnected before completion:
 *    stream closed before response.completed"
 *
 * Each entry below is a lowercase substring matched against the assistant
 * error message. Keep them specific to stream/transport termination so we never
 * reclassify deterministic errors (quota, billing, invalid request, ...).
 */
const PREMATURE_STREAM_END_SIGNATURES = [
	"stream disconnected",
	"disconnected before completion",
	"stream closed before",
	"closed before response.completed",
	"connection reset",
	"connection closed",
	"connection lost",
	"premature close",
	"premature end",
	"unexpected end of stream",
	"incomplete response",
];

/**
 * Phrases that Pi's classifier already treats as retryable. If one is present
 * we leave the message untouched to avoid stacking prefixes on repeated retries.
 */
const ALREADY_RETRYABLE_SIGNATURES = [
	"network error",
	"connection error",
	"connection refused",
	"other side closed",
	"fetch failed",
	"socket hang up",
	"socket connection was closed",
	"websocket closed",
	"websocket error",
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"timeout",
	"timed out",
];

function includesAny(haystack: string, needles: readonly string[]): boolean {
	return needles.some((needle) => haystack.includes(needle));
}

/** Only explicit HTTP/status codes or a leading status are interpreted as client errors. */
function hasPermanentClientStatus(text: string): boolean {
	// Preserve the existing treatment of potentially transient client statuses.
	const transient = new Set([408, 409, 425, 429]);
	const codes = text.matchAll(/\b(?:http(?:\/\d(?:\.\d)?)?(?:\s+(?:status(?:\s+code)?|error))?|status(?:[_ -]?code)?|error[_ -]?code)["\']?\s*[:=]?\s*["\']?(4\d{2})\b/g);
	for (const match of codes) {
		if (!transient.has(Number(match[1]))) return true;
	}
	const leading = text.match(/^\s*(?:error:\s*)?(4\d{2})\b/);
	return Boolean(leading && !transient.has(Number(leading[1])));
}

/**
 * Reclassify a provider stream read failure so Pi's built-in retry loop handles it.
 * The original error is kept in the message for diagnostics.
 */
export default function streamReadRetry(pi: ExtensionAPI): void {
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant" || event.message.stopReason !== "error") return;

		const errorMessage = event.message.errorMessage;
		if (!errorMessage) return;

		const normalized = errorMessage.toLowerCase();
		// A deterministic provider rejection may be wrapped in a stream error.
		// Transport wording must never override authentication, schema or limits.
		if (/invalid[_ -]?request|unsupported|invalid[_ -]?parameter|authentication|unauthorized|forbidden|api[_ -]?key|quota|billing|budget|usage[_ -]?limit|content[_ -]?policy|safety|\b40[0134]\b/.test(normalized)) return;
		if (hasPermanentClientStatus(normalized)) return;
		if (!includesAny(normalized, PREMATURE_STREAM_END_SIGNATURES)) return;
		// Already retryable (or already rewritten by us): nothing to do.
		if (includesAny(normalized, ALREADY_RETRYABLE_SIGNATURES)) return;

		return {
			message: {
				...event.message,
				// Pi's classifier retries errors containing "network error".
				errorMessage: `Network error: ${errorMessage}`,
			},
		};
	});
}
