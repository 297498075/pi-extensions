# Changelog

All notable changes to this project will be documented here.

## [Unreleased]

- feat(compatibility): upgrade dependencies to Pi 0.86.1 (`@earendil-works/pi-coding-agent` & `@earendil-works/pi-tui`), maintaining `>=0.84.1` peer compatibility.
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
