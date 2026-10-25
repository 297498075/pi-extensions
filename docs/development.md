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

`extensions/lib/status-modal.ts` is an imported helper, not an extension entry (no `index.ts`). Read-only status commands use it to avoid muted notifications. TUI gets a scrollable, width/height-bounded overlay; RPC/print/JSON fall back to notifications. Its reusable `StatusModalComponent` also drives timer/voice/todo status dialogs. It wraps complete values, has no viewport-exceeding minimum width, and supports keyboard/wheel paging plus Enter/Esc/click close. Local `.ts` imports are checked via `allowImportingTsExtensions` and run directly in Pi/Node without emitted build files.

`extensions/lib/desktop-actions.ts` is also import-only. Fixed executable/script definitions keep user paths out of command text; every helper process handles `error`, stdin failure, exit status, cancellation and a bounded deadline. Windows file-open uses `ProcessStartInfo.UseShellExecute` via a fixed `-EncodedCommand` script and a literal environment value, not `cmd /c start`. OS file associations may still execute trusted files by design.

## Upgrading from the pre-review build

Restart the Pi process once after updating. The old build installed process-wide hooks and UI wrappers without complete ownership/teardown metadata; `/reload` cannot reliably recover every old wrapper chain. New request-compress code detects that legacy fetch-hook state, disables compression and asks for a restart rather than overwriting another extension's wrapper. Subsequent reload/unload cycles of the new build are covered by regression tests. Previously deleted reasoning blocks cannot be recovered from already-written session entries.

## Tool lifecycle tracking

Rolling tools distinguishes streamed **preparing** drafts from dispatched **running** calls. `message_update` is only a preview, not proof that `execute()` ran. Failed/aborted assistant streams may be omitted during core retry with no tool result at all, so their matching unexecuted drafts must be closed on `message_end`.

Use `tool_execution_start`/`tool_execution_end` as the native dispatch boundaries. They also cover validation/blocked calls that bypass `tool_call`/`tool_result` hooks; a missing core `durationMs` can mean `execute()` never ran. Prefer core-measured duration over the elapsed time since the first streamed argument. A fast execution can end long before the parallel batch's persisted result messages are appended. Result hooks/messages are supplementary reconciliation sources, not the only terminal signal.

At `agent_end`, first reconcile final tool results, then close remaining orphan records before persisting. Settlement and shutdown provide fallback cleanup. Do not impose duration/index heuristics on genuine long-running calls. Active records survive history-window trimming, and snapshots include active calls as well as the recent history tail.

`test-rolling-tool-lifecycle.mjs` exercises overload/abort→retry, elapsed-clock reset, validation rejection, missing terminal hooks, clear/reload/shutdown and a long task across a 600-call history window. It also runs a real in-memory Agent-core stream/parallel batch to verify native event ordering without user session data, file tools or network access.

## Renderer and history contracts

Rolling-tools follows the assistant component's native `hideThinkingBlock` flag. When enabled, its assistant-rendering hook passes a shallow, thinking-free view to Pi's renderer to remove both the placeholder and thinking-only spacing, then retains the original message as `lastMessage`. Never delete, shorten, or rewrite thinking text/signatures in stream events, session entries, or model context. Native setting changes rebuild from the original message; off/unload restores native rendering on the next render. Singleton wrappers remain inert without an owned handler, and reload must not stack wrappers. `test-extension-regressions.mjs` covers existing components, long thinking, streaming tails, setting changes, mixed text/tool calls, error visibility, and off/reload/shutdown restoration.

Tool-renderer decorators must pass the underlying component back as `context.lastComponent` for both call and result slots, without mutating the host context. A live enable predicate also lets existing wrappers become inert on off/unload. Forward focus/blur only if the child is focusable: Pi checks for the presence of `focused`, so a getter returning `undefined` on every wrapper is not transparent. Header filtering is limited to known line prefixes in the leading header block, after stripping ANSI; matching source/body text must survive. History detail layout uses Pi-provided ANSI/grapheme-aware wrapping and a content-revision cache. Invalidate on stream/input/result/status changes, selection/width changes, and theme invalidation; idle refreshes must not reprocess large text or reset a manually scrolled detail viewport. Manual detail scrolling suspends tail following; clicking the latest list row restores it. List copy hit-testing uses the actual rendered column bounds and primary button only. History frames/canvases and every detail header/path fit the viewport; narrow/short screens use one detail column with keyboard tool selection.

History snapshots bound raw input previews to 20,000 characters and copy small inputs rather than retaining mutable argument references. On restore, canonical tool calls in the active branch can replace truncated previews with complete inputs; nested calls without transcript entries retain an explicit, stable truncation notice. Legacy file-path metadata is recomputed in memory using Pi-compatible path conventions. These transformations do not rewrite original call/result entries. Invalid/partial file URL metadata is isolated per field: rolling-tools omits the actionable path without blocking `tool_call`, and image-pager can still replace unrelated images (or use an unknown-path notice). The exported strict image path normalizer keeps its original validation contract. Transient footer statuses own per-key timers; clear them on off/reload/shutdown while leaving persistent keys alone.

## Provider and media boundaries

Request compression resolves ownership from the request origin and the longest matching API path prefix, with a slash boundary (so `/v1` does not match `/v10`). Preserve all provider IDs for identical normalized base URLs; ambiguous ownership must remain uncompressed even with `targetHosts`. Do not let a model/default-provider fallback bypass provider exclusions. Explicit host opt-in remains available for otherwise unknown endpoints. The exported filtering helper still accepts legacy host-only environment maps, but configuration discovery records complete API bases.

Reference-image upload/encoding derives MIME and multipart file names from the validated image signature. Download headers (including `application/octet-stream`, parameterized or incorrect MIME) and local filename extensions are not authoritative. Signature checks are not decoder verification; preserve existing abort, HTTP-error and unsupported-payload rejection behavior.

## Todo overlay lifecycle and layout

Todo details use Pi's linear ANSI/grapheme-aware wrapping, with an unthemed layout cache keyed by selected task and available width. Store notifications and `invalidate()` clear it; unchanged redraws and detail scrolling reuse it. Wrap complete titles as well as descriptions and notes. Bound indentation, ID previews, frames and canvas to the viewport; fewer than 50 columns or 16 rows uses a detail-only layout with keyboard task selection and paged/wheel details. Compact mode retains keyboard fold/note/status actions, without invisible mouse-action hitboxes.

An overlay subscription belongs to one interaction. Release it both on ordinary close and BEFORE handing off to note input, and expose an idempotent `dispose()` for native `ctx.ui.custom()` teardown. Keyboard and mouse note actions share this cleanup path. Do not rely on garbage collection or the normal close callback to cover dialog transitions.

## Mutation test isolation

`scripts/test-mutation-todo-tree.mjs` copies extensions and the focused test suite into a temporary workspace (dereferencing source symlinks), links installed `node_modules` for resolution, and uses an isolated agent/home directory. Mutations and test execution occur only in that copy. It never backs up/restores checkout files, so concurrent editing is safe and an interrupt cannot leave mutants in production source. A hard kill may leave a disposable temp directory; normal completion/failure cleans it up. Timeouts or unexpected failures do not count as killed mutants.

## Listary search transport

`extensions/listary.ts` exposes one read-only `listary_search` tool with a fixed `127.0.0.1:38431` target. It uses Node HTTP with a byte-accurate Content-Length and one-request-per-connection behavior, not fetch wrappers or shell commands. It starts work only on a tool call and cleans up each request's deadline, abort listener and failed connection. Keep response validation and bounded model output separate from transport; display-limited pages must resume after displayed results, not skip the remainder of a server page. See `docs/listary-extension.md` for usage, limits and privacy implications.

`scripts/test-listary.mjs` uses a random-port loopback fixture through a test-only injected transport, asserting the production target before delegation. It never touches real Listary or personal files. It covers request framing, schema/runtime checks, filters/folders, pagination, response/error validation, size limits, no retries/redirects, pre/in-flight cancellation, wall-clock timeout including trickled responses, cleanup and output escaping/bounds. It is included in `npm test`.

## Validation

Run agent-driven tests under an independent parent-process/process-tree deadline of 30–60 seconds; a timer in the tested process cannot interrupt a busy microtask or synchronous loop. Tool `timeout` values are **seconds**, whereas Node timer/child-process options use milliseconds. Mock streams and UI traversal loops must have finite response/iteration budgets and respect cancellation.

`npm run check` validates TypeScript sources. `npm run validate` checks that every manifest path exists and that JSON themes are parseable. Use `npm pack --dry-run` to inspect the publishable file set.

`npm test` includes `scripts/test-extension-regressions.mjs`: real in-memory SessionManager snapshot isolation and boundary projection, branch navigation, global hook unload/off behavior, notification/status interactions, reasoning preservation, bounded timer chaining, compression isolation and strict voice response validation. Media generation uses temporary agent/project directories and mocked fetch only, with no personal provider or credentials required. Questionnaire tests validate schemas and exercise narrow widths, cancellation and non-TUI stdout.

`scripts/test-extension-edge-cases.mjs` covers native call/result renderer reuse, independent fake-clock status keys, bounded snapshots with real in-memory SessionManager recovery, Pi-compatible and legacy metadata paths, linear/cached Unicode detail rendering, URL/base64 video rejection/fallback/cancellation, stopped plans, fully cancelled tree replacement, voice error flags, and scrollable status dialogs at 1–140 columns and short heights. Its 16K-CJK fixture reports timings but asserts cache reuse/invalidation rather than a machine-dependent speed threshold. Media fixtures verify signatures, not decoder playback.

`scripts/test-extension-boundaries.mjs` covers timer unit/word boundaries and separately parsed tool/dialog fields, permanent HTTP status filtering, native `tool_call`/`context` error isolation, safe leading-header filtering, native Input focus/IME markers, manual detail-scroll retention during the real widget timer, list-only primary-button copy hit-testing, history layout across 1–140 columns and 1–30 rows, and nullable fetch options with compression on/off. All inputs/iterations are bounded; desktop actions are pre-aborted and HTTP calls are mocked or local data URLs.

`scripts/test-extension-review-followups.mjs` covers co-hosted provider prefixes/exclusions/ambiguity with real fetch wrapping, signature-derived reference-image MIME across headers and local suffixes, Todo bounds at 1–140 columns and 1–48 rows including 32 levels, cache reuse/invalidation, and actual custom-dialog completion/disposal and fullscreen compositing/SGR primary clicks. Loops have finite budgets, media/network responses are mocked, and rendering timings have generous bounds rather than a precise performance target. Run the same tests against another installed host with `node scripts/test-extension-review-followups.mjs --host-dir <host-node_modules-directory>`; no personal configuration or sessions are used.

`test-rolling-tools-safety.mjs` checks literal path transport, mocked Ctrl-click/copy routes, helper spawn/stdin/exit/timeout failures, shutdown cancellation and 1–140-column layouts. It never touches the real clipboard or opens GUI applications. `test-mutation-isolation.mjs` uses disposable repository fixtures to interrupt a mutation runner and simulate concurrent edits, proving that neither success nor interruption rewrites checkout source. See `docs/known-issues.md` for deliberately deferred behavior; mocks do not certify physical audio playback.
