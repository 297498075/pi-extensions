import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Name of Pi's tool that declares searched tools for the next request. */
export const TOOL_SEARCH_TOOL_NAME = "tool_search";

/**
 * Whether a tool that can search and load other tools is registered. Only a tool that reaches the
 * tools it loads can declare them, so a same-named tool without `reachesTools` does not count.
 */
function hasSearchTool(pi: ExtensionAPI): boolean {
	const all = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
	return all.some((tool) => tool.name === TOOL_SEARCH_TOOL_NAME && tool.reachesTools !== undefined);
}

/** Activate the given tools, tolerating an API that cannot change the active set. */
function activate(pi: ExtensionAPI, names: readonly string[]): void {
	if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
	const active = pi.getActiveTools();
	const missing = names.filter((name) => !active.includes(name));
	if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
}

/**
 * Keep low-frequency tools out of every request until the model asks for them.
 *
 * Register the tools with `exposure: "deferred"` and call this once from the extension factory. On
 * every session start it activates `tool_search`, which declares the matches for the next request;
 * `deferred` tools stay callable from `codemode` scripts meanwhile. A branch that already loaded one
 * keeps it active, because Pi records loaded tools in the transcript.
 *
 * Without any search tool the tools would be unreachable, since the model never learns their names.
 * They are then activated (declared like `direct` tools) instead of silently disappearing. An explicit
 * tool allowlist still wins: Pi leaves tools it excludes out of the registry entirely.
 */
export function deferTools(pi: ExtensionAPI, names: readonly string[]): void {
	if (names.length === 0 || typeof pi.on !== "function") return;
	pi.on("session_start", () => {
		activate(pi, hasSearchTool(pi) ? [TOOL_SEARCH_TOOL_NAME] : names);
	});
}
