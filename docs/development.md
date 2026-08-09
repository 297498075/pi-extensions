# Development Guide

## Resource loading

Pi reads the `pi` field in `package.json` and discovers resources from the configured paths:

- `extensions/`: `.ts` and `.js` extension modules;
- `skills/`: directories containing `SKILL.md`, plus supported top-level skill Markdown files;
- `prompts/`: Markdown prompt templates;
- `themes/`: JSON themes.

Keep resource-specific dependencies and documentation close to the resource when that improves discoverability. Do not put explanatory Markdown files in `skills/` unless they are intended to be loaded as skills.

## Extension lifecycle

An extension factory can register event handlers, tools, commands, shortcuts and providers. Avoid starting long-lived work in the factory because Pi can load extensions in invocations that never start a session. Start session-scoped work from `session_start` and release it from `session_shutdown`.

## Package dependencies

Use this split:

| Dependency kind | Location | Reason |
| --- | --- | --- |
| Pi core package | `peerDependencies` | Supplied by the Pi host; do not bundle it |
| Extension runtime library | `dependencies` | Required after a production install |
| Type checker and test tools | `devDependencies` | Development-only |

When adding a Pi package dependency that must ship with this package, follow Pi's `bundledDependencies` rules and document the installation behavior.

## Validation

`npm run check` validates TypeScript sources. `npm run validate` checks that every manifest path exists and that JSON themes are parseable. Use `npm pack --dry-run` to inspect the publishable file set.
