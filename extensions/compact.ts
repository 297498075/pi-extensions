import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface CompactRequest {
	toolCallId: string;
	sessionId: string;
	customInstructions?: string;
	phase: "queued" | "compacting";
	cancelled: boolean;
}

export default function compactTool(pi: ExtensionAPI): void {
	let pending: CompactRequest | undefined;
	const clear = () => { pending = undefined; };

	// A queued action is deliberately not replayed on resume/fork. Its tool
	// result remains an audit record, not authorization to compact another branch.
	pi.on("session_start", clear);
	pi.on("session_shutdown", clear);
	pi.on("session_before_switch", clear);
	pi.on("session_before_fork", clear);
	pi.on("session_before_tree", clear);
	pi.on("before_agent_start", clear);
	pi.on("agent_settled", (event) => {
		if (event.aborted && pending?.phase === "queued") clear();
	});
	pi.on("session_compact_failed", (event) => {
		if (pending?.phase === "compacting" && event.reason === "manual") {
			pending.cancelled = event.aborted;
		}
	});

	pi.registerTool({
		name: "compact",
		label: "Compact context",
		// Context control must not run inside a codemode script/nested tool batch.
		exposure: "model-only",
		description:
			"Request context compaction when the conversation is long or a major task phase is complete. " +
			"Call this tool directly, preferably by itself. Optional customInstructions tell the summarizer what to preserve. " +
			"The request is queued until all tools in this turn finish; after successful compaction you automatically resume the current task. " +
			"Do not immediately compact again without substantial new task progress. Cancellation or failure does not auto-resume.",
		promptGuidelines: [
			"Use compact proactively for long conversations, not after every turn. Preserve the goal, constraints, decisions, file paths, progress, blockers, and next steps in customInstructions.",
			"A compact tool result only acknowledges a queued request; compaction completion is reported separately. Do not repeat the request while it is pending.",
		],
		parameters: Type.Object({
			customInstructions: Type.Optional(Type.String({
				minLength: 1,
				maxLength: 16_000,
				description: "What the compaction summary must preserve, especially current progress and the next concrete steps.",
			})),
		}, { additionalProperties: false }),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Compaction request aborted");
			if (pending) throw new Error("A compaction request is already pending; do not call compact again yet.");
			const customInstructions = params.customInstructions?.trim() || undefined;
			pending = {
				toolCallId,
				sessionId: ctx.sessionManager.getSessionId(),
				customInstructions,
				phase: "queued",
				cancelled: false,
			};
			return {
				content: [{ type: "text", text: "Compaction queued. All tools in this turn will finish first. After successful compaction, continue the current task from the preserved next steps." }],
				details: { status: "queued", customInstructions, contextUsage: ctx.getContextUsage() },
				terminate: true,
			};
		},
	});

	const isCurrent = (request: CompactRequest, ctx: ExtensionContext) =>
		pending === request && request.sessionId === ctx.sessionManager.getSessionId();

	pi.on("turn_end", (event, ctx) => {
		const request = pending;
		if (!request || request.phase !== "queued") return;
		if (!isCurrent(request, ctx) || event.outcome !== "completed" || ctx.signal?.aborted) {
			clear();
			return;
		}
		// Only start after our successful tool result AND all sibling results have
		// been persisted. A tool_result handler may have turned our call into an error.
		const result = event.toolResults.find((message) => message.toolCallId === request.toolCallId);
		if (!result || result.isError) {
			clear();
			return;
		}
		request.phase = "compacting";
		const fail = (error: Error) => {
			if (!isCurrent(request, ctx)) return;
			clear();
			const cancelled = request.cancelled || error.name === "AbortError" || /\b(?:aborted|cancelled|canceled)\b/i.test(error.message);
			pi.sendMessage({
				customType: "compact-result",
				content: cancelled
					? "Context compaction was cancelled. Do not automatically resume."
					: `Context compaction failed: ${error.message}. No automatic retry or continuation was started.`,
				display: true,
				details: { status: cancelled ? "cancelled" : "failed", error: error.message },
			}, { triggerTurn: false });
			if (ctx.hasUI && !cancelled) ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
		};
		try {
			// Manual compaction aborts and waits for the active run to finish.
			// NEVER await it from a tool or lifecycle handler: that would deadlock
			// the run it is waiting on. Returning here lets that run finish first.
			ctx.compact({
				customInstructions: request.customInstructions,
				onComplete: (result) => {
					if (!isCurrent(request, ctx)) return;
					clear();
					pi.sendMessage({
						customType: "compact-result",
						content: "Context compaction completed. Continue the current task from the summary and preserved next steps. Do not immediately compact again; make substantive task progress first.",
						display: false,
						details: {
							status: "completed",
							tokensBefore: result.tokensBefore,
							estimatedTokensAfter: result.estimatedTokensAfter,
						},
					}, { triggerTurn: true, deliverAs: "followUp" });
				},
				onError: fail,
			});
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
		}
	});
}
