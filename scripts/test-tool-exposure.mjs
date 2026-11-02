import assert from "node:assert/strict";
import askUser from "../extensions/ask-user.ts";
import listary from "../extensions/listary.ts";
import mediaGen from "../extensions/media-gen.ts";
import timer from "../extensions/timer.ts";
import { TOOL_SEARCH_TOOL_NAME, deferTools } from "../extensions/lib/tool-exposure.ts";

const noop = () => {};
const extensions = [
	{ name: "listary", load: listary, tools: ["listary_search"] },
	{ name: "timer", load: timer, tools: ["timer_schedule", "timer_cancel", "timer_list"] },
	{ name: "media-gen", load: mediaGen, tools: ["image_job_status", "generate_image", "generate_video"] },
	{ name: "ask-user", load: askUser, tools: ["get_user_answer", "wait_user_answer", "ask_user_question"] },
];
const deferredTools = extensions.flatMap((entry) => entry.tools);

/** Minimal ExtensionAPI for `deferTools`: only the members it reads or writes. */
function accessFixture({ active = [], registered = [], searchTool = true } = {}) {
	const tools = [...registered];
	if (searchTool) tools.push({ name: TOOL_SEARCH_TOOL_NAME, exposure: "model-only", reachesTools: () => "all" });
	let activeNames = [...active];
	return {
		pi: {
			on() {},
			getAllTools: () => tools,
			getActiveTools: () => [...activeNames],
			setActiveTools(names) { activeNames = [...new Set(names)]; },
		},
		active: () => activeNames,
	};
}

console.log("=== Test 1: extensions register their tools deferred ===");
{
	for (const extension of extensions) {
		const tools = new Map();
		let handlers = 0;
		const pi = new Proxy({
			registerTool(definition) { tools.set(definition.name, definition); },
			on() { handlers++; },
		}, { get: (object, property) => (property in object ? object[property] : noop) });
		extension.load(pi);
		assert.deepEqual([...tools.keys()].sort(), [...extension.tools].sort(), `${extension.name} registers exactly its tools`);
		for (const name of extension.tools) {
			const tool = tools.get(name);
			assert.equal(tool.exposure, "deferred", `${extension.name}/${name} must stay out of the prompt`);
			assert.equal(typeof tool.execute, "function", `${extension.name}/${name} stays executable`);
			assert.ok(tool.parameters, `${extension.name}/${name} keeps its schema for tool_search`);
		}
		assert.ok(handlers > 0, `${extension.name} keeps its tools reachable on session start`);
	}
	console.log(`✓ ${deferredTools.length} tools deferred across 4 extensions, schema and execute intact`);
}

console.log("=== Test 2: tool_search is activated so the deferred tools stay reachable ===");
{
	const fixture = accessFixture({ active: ["read", "bash", "codemode"] });
	const handlers = [];
	deferTools({ ...fixture.pi, on: (_event, handler) => handlers.push(handler) }, deferredTools);
	assert.equal(handlers.length, 1, "one session_start handler per extension");
	for (const handler of handlers) handler({}, {});
	assert.deepEqual(fixture.active(), ["read", "bash", "codemode", TOOL_SEARCH_TOOL_NAME], "tool_search appended once");
	for (const name of deferredTools) assert.ok(!fixture.active().includes(name), `${name} must not be declared`);
	// A second start must not add it twice.
	for (const handler of handlers) handler({}, {});
	assert.deepEqual(fixture.active(), ["read", "bash", "codemode", TOOL_SEARCH_TOOL_NAME], "idempotent");
	console.log("✓ tool_search activated once, every deferred tool stays undeclared");
}

console.log("=== Test 3: an already active tool_search is left alone ===");
{
	const fixture = accessFixture({ active: ["read", TOOL_SEARCH_TOOL_NAME] });
	const handlers = [];
	deferTools({ ...fixture.pi, on: (_event, handler) => handlers.push(handler) }, deferredTools);
	for (const handler of handlers) handler({}, {});
	assert.deepEqual(fixture.active(), ["read", TOOL_SEARCH_TOOL_NAME], "no duplicate activation");
	console.log("✓ no duplicate entry");
}

console.log("=== Test 4: without a search tool the tools are declared instead of lost ===");
{
	const fixture = accessFixture({ active: ["read"], searchTool: false });
	const handlers = [];
	deferTools({ ...fixture.pi, on: (_event, handler) => handlers.push(handler) }, deferredTools);
	for (const handler of handlers) handler({}, {});
	assert.deepEqual([...fixture.active()].sort(), ["read", ...deferredTools].sort(), "all tools activated");
	console.log("✓ nothing becomes unreachable when no tool can search");
}

console.log("=== Test 5: a same-named tool that reaches nothing is not a loader ===");
{
	const fixture = accessFixture({
		active: ["read"],
		searchTool: false,
		registered: [{ name: TOOL_SEARCH_TOOL_NAME, exposure: "deferred" }],
	});
	const handlers = [];
	deferTools({ ...fixture.pi, on: (_event, handler) => handlers.push(handler) }, deferredTools);
	for (const handler of handlers) handler({}, {});
	assert.ok(!fixture.active().includes(TOOL_SEARCH_TOOL_NAME), "an inert tool_search is not activated");
	for (const name of deferredTools) assert.ok(fixture.active().includes(name), `${name} stays declared`);
	console.log("✓ only a loader that reaches other tools counts");
}

console.log("=== Test 6: a branch that already loaded a tool keeps it declared ===");
{
	const fixture = accessFixture({ active: ["read", TOOL_SEARCH_TOOL_NAME, "listary_search"] });
	const handlers = [];
	deferTools({ ...fixture.pi, on: (_event, handler) => handlers.push(handler) }, deferredTools);
	for (const handler of handlers) handler({}, {});
	assert.ok(fixture.active().includes("listary_search"), "loaded tool keeps its declaration");
	console.log("✓ tool_search results survive the next session start");
}

console.log("=== Test 7: an empty or unsupported API is a no-op ===");
{
	let subscribed = 0;
	deferTools({ on() { subscribed++; } }, []);
	assert.equal(subscribed, 0, "no session handler without tools");
	assert.doesNotThrow(() => deferTools({}, ["listary_search"]), "a harness without event support is tolerated");
	assert.doesNotThrow(() => deferTools({ on(_event, handler) { handler(); } }, ["listary_search"]), "a harness without tool introspection is tolerated");
	console.log("✓ no handler for an empty list, and partial ExtensionAPI fakes do not throw");
}

console.log("All tool-exposure regressions passed.");
