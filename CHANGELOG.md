# Changelog

All notable changes to this project will be documented here.

## [Unreleased]

- fix(security): replace Windows `cmd /c start` file opening with a fixed ShellExecute adapter; paths remain literal data and must be existing local absolute paths.
- fix(rolling-tools): enforce visible-column bounds in fixed/running/status/error/feedback layouts, wrapping long tool names and preserving full fixed-mode paths.
- fix(desktop): handle async spawn/stdin errors, nonzero exits, timeouts and cancellation; report copy/open failures without crashing or falsely claiming success.
- fix(tests): run todo mutation tests only in an isolated temporary copy, preventing source corruption on interruption and loss of concurrent edits.
- test: add desktop-action/Unicode-width safety regressions and mutation interruption/concurrent-edit regressions; mock clipboard actions instead of touching the system clipboard.

- fix(review): preserve assistant reasoning/signatures while hiding only the rendered view; restore global/UI hooks on extension shutdown.
- fix(state): deep-copy todo snapshots, clear missing branch state, apply batch replacement atomically, and restore rolling history from the active branch.
- fix(todo-loop): continue from the post-retry `agent_before_settle` boundary using persisted context messages; honor UI clear/completed/disabled state and existing follow-up budgets.
- fix(network): limit compression to known API hosts or explicit opt-ins; validate JSON and tear down fetch hooks without overwriting other wrappers.
- fix(media-gen): honor session cwd/agent directory and environment interpolation; propagate cancellation with a five-minute total deadline, validate image downloads, encode local video references, and mark tool errors correctly.
- fix(ui): width-safe cancellable questionnaires without JSON/RPC terminal bytes; shared modal status for rolling-tools, request-compress and image-pager.
- fix(timer): chain bounded timeouts so delays over 24.9 days cannot execute immediately.
- fix(voice): reject empty/error synthesis responses and clear UI timers; defer gateway isolation/physical completion redesign per user decision (see `docs/known-issues.md`).
- test: isolate media tests from personal credentials; add real SessionManager/boundary, cross-extension hook, UI, cancellation and long-timer regressions.

- fix(media-gen): support multimodal `/chat/completions` fallback for image generation and editing (Gemini, Claude, Qwen, OneAPI/NewAPI proxies).
  - Proxy services and native endpoints often reject models like `gemini-3.1-flash-image` with HTTP 400 on `/v1/images/generations`.
  - Added seamless fallback to `/v1/chat/completions`, supporting `message.images` (OpenAI-compatible image objects or data URIs), multimodal `message.content` parts (`image_url`), markdown image links (`![...](...)`), and embedded base64 data URIs.
  - Enhanced error diagnostics detailing statuses of both `/images/generations` and `/chat/completions` endpoints upon failure.


- feat(timer): add scheduled message timer extension (`extensions/timer.ts`) with flexible time parsing, above-editor countdown widget, transcript entry cards, and agent tools (`timer_schedule`, `timer_cancel`, `timer_list`).
  - Supports versatile duration formats: user-specified `seconds minutes hours` (e.g. `/timer 30 2 0 <prompt>`), natural time strings (e.g. `5m`, `30s`, `1h 30m`, `1小时30分钟`), and clock colon formats (`00:05:00`, `02:30`).
  - Interactive input prompts when `/timer` is executed without arguments.
  - Live ticking countdown widget (`aboveEditor`) showing remaining time and prompt preview with auto-cleanup on trigger/cancellation.
  - Durable structured chat transcript cards (`EntryRenderer`) for task creation, trigger, and cancellation events.
  - Seamless agent dispatch: dispatches via `sendUserMessage` when idle or queues as `followUp` when busy or streaming.
  - Status modal overlay (`/timer status`) using `ctx.ui.custom()` compliant with repository UX standards.
  - Tool integration for agent self-scheduling: `timer_schedule`, `timer_cancel`, and `timer_list`.

- fix(rolling-tools): capture streaming tool calls in real time (fixes command not showing after thinking completed / flickering on execution end).
  - Previously, `rolling-tools` only tracked tools when the formal `tool_call` event fired after the entire LLM response stream had ended and local execution was about to begin. Because LLMs take seconds to generate tool call arguments (especially when generating multiple concurrent tool calls like multiple `read` / `bash` commands), the UI would stay stuck on `💡 思考完成` during streaming, followed by tool execution that completed in milliseconds (e.g. 1ms~50ms), causing the commands to appear as a brief "flash" when execution finished.
  - Now, `message_update` captures `toolCall` blocks as soon as the model begins streaming them, displaying them immediately with live spinner and elapsed timer (`⠋ [1] bash ... (0.5s)`).
  - Streaming argument updates (`toolcall_delta`) stream directly into the widget in real time as JSON fragments are parsed.
  - Concurrent multi-tool calls are immediately surfaced both in `running` mode (with multi-task separators or `(+N)` concurrency badge) and in `fixed` mode.
  - `tool_call` execution transitions idempotently without duplicate sequence indexing or double-insertion.
- feat(rolling-tools): refine view modes, live task duration ticker, and icons (`🔽`/`⏏️`, `➕`).
  - Switched overlay dialog button to `➕`.
  - Switched view mode toggle button to `🔽` (fixed recent rows) and `⏏️` (single-line running mode).
  - In `running` mode, active tasks are merged directly into the header row (zero vertical height jump/flicker).
  - Active running tasks now display a live elapsed timer (`(19ms)`, `(2.5s)`) both in the header row and in the multi-row list.
  - Error rendering: tool failure shows the red cross `✗` on its row, plus a compact single-line `✗ [#N tool] <message>` line that stays visible in **both** `fixed` and `running` modes (the multiline `[Error in #N ...]` block was removed; a successful tool result clears the line).
  - `running` mode no longer swallows error information behind the running-task header.
  - Fixed a leaked 100ms re-render timer: the status timer is now started only for tools included in the widget, so silenced/excluded tools can no longer leave an orphaned interval running until the next turn boundary.
  - Normalized the view-mode toggle hit region to match the `➕` button (no longer extends one column to the left).
- feat(rolling-tools): unify plugin tips into the footer status line (config schema v3).
  - `interceptNotifications` now defaults to `[{ "match": "*", "suppressToast": true }]`, so every plugin's `notify(..., "info")` tip is suppressed from the transcript instead of only SoL-Pi's.
  - `error` / `warning` notifications, and any `info` message containing a `notificationKeywords` word (default: `error`, `failed`, `failure`, `warning`, `错误`, `失败`, `警告`, `⚠`, `❌`, `🔴`), always pass through.
  - `statusEnhancements` now defaults to `keyPattern: "*"` with `colorize: true` and **no** `durationMs`, so a plugin's footer status is colorized but its lifecycle is left alone. Add `durationMs` to a rule to make a transient tip auto-clear.
  - Add `persistentKeys` (default `["blackhole", "mcp"]`): keys listed here are passed through completely untouched — no countdown, no forced colorization, and their own `setStatus(key, undefined)` clears are never swallowed. This fixes pi-blackhole's footer gauge and the MCP server status being wrongly cleared. Default `persistentKeys` are always unioned into user rules.
  - Add `stripToolNotificationHeaders` (default `true`): strip plugin-inserted headers such as SoL-Pi's `⚡ SoL-Pi · Action Fusion` / `Money saved · …` from tool rows via `pi.registerToolRenderer` (silently degrades on Pi versions without it).
  - Remove the now-unused `rollIntoWidget` notification rule field and the `solPiSavings` widget state.
  - Every new field has a default, so the config file is entirely optional; a one-time v2→v3 notice documents the new defaults and `/rolling-tools migrate` writes them out.
- feat(rolling-tools): click a left-list row in the history dialog to copy that tool's detail (diff / script / command / path / output) to the clipboard, with in-dialog feedback.
- feat(rolling-tools): render the history dialog as a centered box on a full-screen canvas so clicking outside the box closes it.
- feat(rolling-tools): add dedicated `codemode` formatting (script preview + line count, full script body available in the overlay dialog).
- fix(rolling-tools): throttle history persistence to turn boundaries (`agent_end` / `session_shutdown`) so session files no longer grow O(N²) from one snapshot per tool call.
- feat(dev): add test coverage for `reload` history restore and `codemode`/third-party tool tracking.
- feat(rolling-tools): restore rolling history on `/reload` (not just `resume`/`fork`) by reading persisted history from the current session, so the block and `[⤢]` dialog work after a reload.
- feat(rolling-tools): make the status row (waiting/thinking/thinking-done) a persistent header of the rolling block, and keep `思考完成` visible after a turn completes.
- feat(rolling-tools): move the `[⤢]` history-dialog button onto the persistent header row (removed from individual tool rows).
- feat(rolling-tools): draw a full box border around the history overlay dialog.
- feat(rolling-tools): live-update the open history overlay while the agent is running (new tools appear immediately; auto-follows the newest unless the user has selected an older entry).
- feat(rolling-tools): roll **all** tools (including `edit`, `write`, `codemode`, and third-party tools such as SoL-Pi `recall` / Trellis `subagent`) into the widget and hide them from the transcript by default via `*` wildcard defaults for `managedTools` / `silencedTools` / `widgetTools`.
- feat(rolling-tools): add a `[⤢]` persistent-header button (only on the header row) that opens a large, fully bordered, two-pane history overlay dialog (`ctx.ui.custom` + `overlay`), showing the full tool history and the selected tool's complete content (edit diff, write body, codemode script, command, output). Click a left-list row to copy that tool's detail; click outside the box (or press `Esc`) to close.
- feat(rolling-tools): support mouse-wheel scrolling inside the overlay with top-edge lazy loading (`lazyLoadStep`, default 10) so long histories load incrementally instead of all at once.
- feat(rolling-tools): keep the rolling block across turns (no longer reset on `agent_start`) and persist history across sessions via `pi.appendEntry()` (`rolling-tools-history`), restored on `reload`/`resume`/`fork` when `persistAcrossSessions` is enabled.
- feat(rolling-tools): capture `edit` diffs from `tool_result.details.diff` and `write` file bodies from tool input for full-fidelity overlay display.
- feat(rolling-tools): add `/rolling-tools history` (alias `open`) command and expand `/rolling-tools status` with tool rules, lazy-load step, and persistence state.
- feat(rolling-tools): add config schema versioning (`configVersion: 2`) with non-destructive legacy migration. Old configs keep their original whitelist semantics and show a one-time upgrade notice; `/rolling-tools migrate` rewrites the config to the new all-tools (`["*"]`) semantics.
- feat(request-compress): add transparent HTTP request body compression extension supporting configurable algorithms (zstd, gzip, deflate, br) with default zstd for API proxies.
- fix(request-compress): add idempotent global hook protection against `/reload` re-wrapping, prevent double-compression via magic bytes and `Content-Encoding` header inspection, and ensure valid JSON payload validation.
- fix(compatibility): align dev dependencies with Pi 1.2.0 (`@earendil-works/pi-coding-agent` & `@earendil-works/pi-tui`), maintaining `>=0.84.1` peer compatibility. Verified against Pi 1.2.0 including the `codemode` tool and the `/reload` lifecycle.
- feat(rolling-tools): support Pi 0.86+ native `powershell` tool on Windows as a first-class shell command with automatic transcript silencing, multiline formatting, and backward-compatible config migration.
- fix(rolling-tools): refine completion state handling with `agent_settled` to avoid premature completion labels during auto-retry or mid-run compactions.

- feat(skills): add idm-download skill with sanitized configuration and automated background download support for IDM.
- feat(extensions): switch detail expansion from hover to click toggle with visual indicator, include bash unconditionally in rolling widget, silence collapsed bash in transcript, and support in-detail copy and execution output view.
- fix(extensions): precise text-width X-axis hover boundary, unconditional 0-line silence for read/grep/find/ls, and enforce default collapsed tools on agent start.
- feat(extensions): unified single OpenCode box for bash with strict 5-line limit, full silence for read-only tools and allowlisted bash, and completed on agent end.
- feat(extensions): add waiting server response state sharing top line with thinking, with globe icon and dynamic request timer.
- fix(extensions): decouple actual thinking duration from visual animation buffer to reflect genuine model thinking time.
- feat(extensions): fix turn_end premature completed label, thinking persistence until text streaming, in-widget only copy feedback, and 100% pi-tool-display ownership for bash/edit/write.
- feat(extensions): dynamic RollingToolsWidgetComponent for instant 0ms hover tips, thinking completed stays until text streams, and fix duplicate bash box.
- feat(extensions): clean hover tips without instructional prefix, show Completed on turn end, fix duplicate bash rendering, and eliminate thinking completed label.
- feat(extensions): minimum 1.5s thinking animation, remove hover text highlight, fix multiline bash allowlist splitting, and eliminate completed message labels.
- feat(extensions): complete thinking elimination from transcript, gentle bulb icon, native TUI hover/click interactions for paths and multiline commands, and full pi-tool-display ownership for bash/edit/write.
- feat(extensions): add `rolling-tools` extension for compact rolling status widget and transcript silencing of read/execution tools.
- Initial Pi package structure.
