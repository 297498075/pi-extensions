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

## Upgrading from the pre-review build

Restart the Pi process once after updating. The old build installed process-wide hooks and UI wrappers without complete ownership/teardown metadata; `/reload` cannot reliably recover every old wrapper chain. New request-compress code detects that legacy fetch-hook state, disables compression and asks for a restart rather than overwriting another extension's wrapper. Subsequent reload/unload cycles of the new build are covered by regression tests. Previously deleted reasoning blocks cannot be recovered from already-written session entries.

## Validation

`npm run check` validates TypeScript sources. `npm run validate` checks that every manifest path exists and that JSON themes are parseable. Use `npm pack --dry-run` to inspect the publishable file set.

`npm test` includes `scripts/test-extension-regressions.mjs`: real in-memory SessionManager snapshot isolation and boundary projection, branch navigation, global hook unload/off behavior, notification/status interactions, reasoning preservation, bounded timer chaining, compression isolation and strict voice response validation. Media generation uses temporary agent/project directories and mocked fetch only, with no personal provider or credentials required. Questionnaire tests validate schemas and exercise narrow widths, cancellation and non-TUI stdout. See `docs/known-issues.md` for deliberately deferred behavior; mocks do not certify physical audio playback.
