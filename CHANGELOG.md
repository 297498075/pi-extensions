# Changelog

All notable changes to this project will be documented here.

## [Unreleased]

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
