# Todo Loop control protocol

## Load and configure

Load the package normally, or load only this extension alongside a todo provider:

```bash
pi --extension ./extensions/todo-loop.ts
pi --todo-loop-max-followups 50
```

The extension requires Pi's `agent_before_settle` boundary API and tool registration APIs (checked with the repository's Pi dependency). The todo provider must be loaded separately. Supported persisted task sources are:

- `todo` / `todos` tool results containing `details.tasks` or `details.todos`;
- `todo-tree-state` custom entries, including UI updates, clear and disable;
- executing `plan-mode` custom entries. `executing: false` authoritatively resets the plan.

Failed todo tool results do not replace authoritative task state. Completed, cancelled, deleted and example-format done tasks do not count as unfinished.

The default budget is **20 automatic follow-ups**. Set a persistent local override in `~/.pi/agent/todo-loop/config.json` (or under `PI_CODING_AGENT_DIR`):

```json
{ "maxFollowups": 100 }
```

The extension reads this file at load time, including on `/reload`. A valid local value takes precedence over the invocation flag, including when Pi carries the previous flag value across reload. Missing or invalid config falls back to the flag; an invalid or absent flag falls back to 20. A limit of `0` disables automatic follow-ups, not the control/status tool.

Explicit `/reload`, `/resume`, `/new`, and fork/clone transitions start a fresh budget without resetting todo or blocker state in the selected session. The count includes persisted `todo-loop-followup` messages and the exact legacy continuation prompt since the latest reset on the active branch. Automatic runtime startup, new user messages, task replacement and compaction preserve that count. Tree navigation reconstructs the count from the selected branch.

## Separate explanation from control

Assistant text never pauses the loop. Quoting `cannot continue`, showing JSON in a code block, mentioning `operation aborted`, or producing a phase summary is not a control operation. This prevents summaries that quote todo-loop's old continuation prompt from accidentally stopping execution.

The extension only requests continuation after core retries, compaction and queued work finish. It does not continue aborted/errored runs or assistant messages with structural `aborted` / `error` stop reasons, and it does not duplicate another boundary handler's continuation. Escape/core cancellation remains authoritative; it is not inferred from prose. To disable automatic todo work explicitly, use the todo provider's disable/clear controls or start with a zero follow-up budget.

## Explicit blockers

The extension registers a **model-only, sequential** `todo_loop_control` tool. It must be called directly by the model, not through codemode or another nested-tool orchestrator: nested calls do not produce standalone persisted tool-result entries. Successful result `details` are the durable control protocol. Failed or uncommitted calls cannot register blockers.

Inspect task IDs first:

```json
{ "action": "status" }
```

Register a real blocker:

```json
{
  "action": "report_blocker",
  "taskIds": ["1.2"],
  "category": "needs_user_input",
  "reason": "The target environment address was not supplied.",
  "resumeWhen": "The user supplies the target address."
}
```

Categories are `needs_user_input`, `missing_access` and `external_dependency`. Report concrete evidence and what must change; difficulty or a phase summary alone is not a blocker. Multiple IDs can share one blocker description. Validation is atomic: an unknown/non-actionable/duplicate ID or missing reason/resume condition rejects the entire call.

Clear a blocker when its prerequisite is satisfied:

```json
{ "action": "clear_blocker", "taskIds": ["1.2"] }
```

### Task hierarchy

Pending parents act as containers while they have unfinished children. Register blockers on the actionable unfinished children, not their parent. If a parent remains unfinished after its children finish, it becomes actionable itself. This avoids requiring both a blocked child and its container to be independently blocked before pausing.

- One blocked task does **not** stop unrelated unblocked tasks.
- Only when **all actionable unfinished tasks** have valid blockers does todo-loop pause its own follow-ups.
- Blockers do not modify the owning todo extension or mark anything completed/cancelled.
- Numeric IDs are represented as strings. ID-less example/plan tasks use positional IDs such as `@1`; inspect `status` for the current IDs. Ambiguous IDs must be fixed before reporting blockers.

### Lifetime and persistence

Blockers are reconstructed from successful control-tool results in the active branch; there is no cross-session in-memory blocker cache.

- A blocker binds to the task's canonicalized record and provider family. Object-key order and redundant unfinished `done`/`completed` aliases are ignored, so todo-tree custom snapshots and tool results agree. Other record changes (including notes/timestamps), completion, removal or replacement invalidate that task's blocker conservatively.
- Changing another task does not invalidate an unchanged task's blocker. Identical repeated todo snapshots/list results preserve it.
- Clear/disable/reset removes blockers. Reusing IDs after a clear does not resurrect them.
- A new user message clears existing blockers so the agent reassesses prerequisites. Automatic custom follow-ups and the exact legacy continuation user message do not clear them.
- Reload/resume and fork/tree navigation reconstruct only the selected branch's controls. No external blocker file is used.
- Task revisions are conservative change detectors, not a semantic proof that an external dependency has changed. If an external prerequisite is resolved without changing the task or sending user input, the model must clear that blocker explicitly.
- Clearing blockers or sending user input preserves the current follow-up count. Use `/reload` or explicitly reopen the session to renew an exhausted budget.

## Diagnostics

`/todo-loop status` opens a scrollable TUI modal with current actionable task IDs, blocker reasons/resume conditions, the branch budget and the latest recorded boundary decision. Non-TUI environments fall back to a notification. The latest decision is explicitly historical: current task/control changes may have occurred since that boundary.

Every settlement boundary with known todo state appends a `todo-loop-decision` session entry. For example:

```json
{
  "decision": "pause",
  "reason": "all_remaining_tasks_blocked",
  "remaining": 6,
  "actionable": 4,
  "blocked": 4,
  "followups": 5,
  "limit": 20
}
```

Reasons also distinguish unfinished work, no unfinished tasks, pending messages, structural errors/aborts, a continuation already requested by another extension, and budget exhaustion. Decisions are diagnostic only and are not replayed as control state. A decision does not veto continuations requested by other extensions. All-blocked and budget pauses show concise warnings; inspect the status modal for details.

There is intentionally no "todos did not change for N turns" detector: source investigation, database inspection and debugging can be real progress without any todo status change. The persisted follow-up budget is the deterministic runaway guard. No secondary model or network request is used to judge assistant intent.

## Verification

```bash
node scripts/test-todo-loop.mjs
npm run check
npm run validate
npm test
```

The focused regression uses in-memory Pi sessions, mocked extension registration/UI, and a temporary local config. It covers historical-prompt echoes, prose/JSON non-controls, per-leaf partial/all-blocked state, atomic failures, result persistence, branch restoration, explicit budget renewal, automatic startup, config precedence, per-task invalidation, user input, alternative todo formats, boundary composition, structural cancellation/errors and modal/fallback status. It does not access user sessions/configuration, invoke a model, or use the network.

Manual smoke check after loading/reloading the extension:

1. Create a parent with an unfinished child and a separate unfinished task.
2. Let the model quote the old continuation prompt in a summary: continuation must still run.
3. Register a blocker for the child: the separate task must still run.
4. Register a blocker for the separate task: automatic continuation must pause; `/todo-loop status` must show both reasons and the decision.
5. Send new user input or change one blocked task: its effective blocker must be cleared/reassessed, subject to the existing branch budget.
6. Reload: status should show zero used follow-ups and the same applicable blockers. Navigate to a branch before the reset: its previous count and only its own blocker reports apply.

## Permissions and privacy

Like all Pi extensions, this code executes with full process/system permissions. This implementation performs no network requests, external file writes, command execution, timers or background work. It reads the local budget config and active session history, registers a tool and a slash command, and adds control results, decisions, budget resets and continuation messages to Pi's session log. Blocker reasons and resume conditions become part of that history and may be sent to the configured model; do not put credentials/secrets in them. Task revision hashes are change markers, not privacy/security guarantees.
