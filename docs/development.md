# Development Guide

## Resource loading

Pi reads the `pi` field in `package.json` and discovers resources from the configured paths:

- `extensions/`: `.ts` and `.js` extension modules;
- `skills/`: directories containing `SKILL.md`, plus supported top-level skill Markdown files;
- `prompts/`: Markdown prompt templates;
- `themes/`: JSON themes.

Keep resource-specific dependencies and documentation close to the resource when that improves discoverability. Do not put explanatory Markdown files in `skills/` unless they are intended to be loaded as skills.

## Extension lifecycle

An extension factory can register event handlers, tools, commands, shortcuts and providers. Avoid starting long-lived work in the factory because Pi can load extensions in invocations that never start a session. Start session-scoped work from `session_start` and release it from `session_shutdown`. Global wrappers must restore owned functions or become inert without overwriting wrappers installed by other extensions. Branch-sensitive restoration must use `getBranch()` and persistence must copy mutable state.

## Package dependencies

Use this split:

| Dependency kind | Location | Reason |
| --- | --- | --- |
| Pi core package | `peerDependencies` | Supplied by the Pi host; do not bundle it |
| Extension runtime library | `dependencies` | Required after a production install |
| Type checker and test tools | `devDependencies` | Development-only |

When adding a Pi package dependency that must ship with this package, follow Pi's `bundledDependencies` rules and document the installation behavior.

## Shared UI helpers

`extensions/lib/status-modal.ts` is an imported helper, not an extension entry (no `index.ts`). Read-only status commands use it to avoid muted notifications. TUI gets a scrollable, width-bounded overlay; RPC/print/JSON fall back to notifications. Local `.ts` imports are checked via `allowImportingTsExtensions` and run directly in Pi/Node without emitted build files.

`extensions/lib/desktop-actions.ts` is also import-only. Fixed executable/script definitions keep user paths out of command text; every helper process handles `error`, stdin failure, exit status, cancellation and a bounded deadline. Windows file-open uses `ProcessStartInfo.UseShellExecute` via a fixed `-EncodedCommand` script and a literal environment value, not `cmd /c start`. OS file associations may still execute trusted files by design.

## Upgrading from the pre-review build

Restart the Pi process once after updating. The old build installed process-wide hooks and UI wrappers without complete ownership/teardown metadata; `/reload` cannot reliably recover every old wrapper chain. New request-compress code detects that legacy fetch-hook state, disables compression and asks for a restart rather than overwriting another extension's wrapper. Subsequent reload/unload cycles of the new build are covered by regression tests. Previously deleted reasoning blocks cannot be recovered from already-written session entries.

## Tool lifecycle tracking

Rolling tools distinguishes streamed **preparing** drafts from dispatched **running** calls. `message_update` is only a preview, not proof that `execute()` ran. Failed/aborted assistant streams may be omitted during core retry with no tool result at all, so their matching unexecuted drafts must be closed on `message_end`.

Use `tool_execution_start`/`tool_execution_end` as the native dispatch boundaries. They also cover validation/blocked calls that bypass `tool_call`/`tool_result` hooks; a missing core `durationMs` can mean `execute()` never ran. Prefer core-measured duration over the elapsed time since the first streamed argument. A fast execution can end long before the parallel batch's persisted result messages are appended. Result hooks/messages are supplementary reconciliation sources, not the only terminal signal.

At `agent_end`, first reconcile final tool results, then close remaining orphan records before persisting. Settlement and shutdown provide fallback cleanup. Do not impose duration/index heuristics on genuine long-running calls. Active records survive history-window trimming, and snapshots include active calls as well as the recent history tail.

`test-rolling-tool-lifecycle.mjs` exercises overload/abort→retry, elapsed-clock reset, validation rejection, missing terminal hooks, clear/reload/shutdown and a long task across a 600-call history window. It also runs a real in-memory Agent-core stream/parallel batch to verify native event ordering without user session data, file tools or network access.

## Mutation test isolation

`scripts/test-mutation-todo-tree.mjs` copies extensions and the focused test suite into a temporary workspace (dereferencing source symlinks), links installed `node_modules` for resolution, and uses an isolated agent/home directory. Mutations and test execution occur only in that copy. It never backs up/restores checkout files, so concurrent editing is safe and an interrupt cannot leave mutants in production source. A hard kill may leave a disposable temp directory; normal completion/failure cleans it up. Timeouts or unexpected failures do not count as killed mutants.

## Validation

`npm run check` validates TypeScript sources. `npm run validate` checks that every manifest path exists and that JSON themes are parseable. Use `npm pack --dry-run` to inspect the publishable file set.

`npm test` includes `scripts/test-extension-regressions.mjs`: real in-memory SessionManager snapshot isolation and boundary projection, branch navigation, global hook unload/off behavior, notification/status interactions, reasoning preservation, bounded timer chaining, compression isolation and strict voice response validation. Media generation uses temporary agent/project directories and mocked fetch only, with no personal provider or credentials required. Questionnaire tests validate schemas and exercise narrow widths, cancellation and non-TUI stdout.

`test-rolling-tools-safety.mjs` checks literal path transport, mocked Ctrl-click/copy routes, helper spawn/stdin/exit/timeout failures, shutdown cancellation and 1–140-column layouts. It never touches the real clipboard or opens GUI applications. `test-mutation-isolation.mjs` uses disposable repository fixtures to interrupt a mutation runner and simulate concurrent edits, proving that neither success nor interruption rewrites checkout source. See `docs/known-issues.md` for deliberately deferred behavior; mocks do not certify physical audio playback.
