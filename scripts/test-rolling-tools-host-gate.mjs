import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Synthetic web session. The separate browser smoke procedure is documented in the README.
const root = mkdtempSync(join(tmpdir(), "pi-web-buttons-"));
process.env.PI_CODING_AGENT_DIR = process.env.HOME = process.env.USERPROFILE = root;
delete process.env.PI_WEB_HOSTNAME;
delete process.env.PI_WEB_PASSWORD;
delete process.env.PI_ROLLING_TOOLS_PI_WEB;
const { default: rollingTools } = await import("../extensions/rolling-tools.ts");
const { default: todoTree } = await import("../extensions/todo-tree.ts");
const configDir = join(root, "extensions", "rolling-tools");
mkdirSync(configDir, { recursive: true });
function configure(settings) { writeFileSync(join(configDir, "config.json"), JSON.stringify({ configVersion: 3, ...settings })); }

function mount(extension, mode = "rpc") {
	const handlers = new Map(), commands = new Map(), tools = new Map(), statuses = new Map(), widgets = new Map();
	const entries = [], replies = [], messages = [], notices = [];
	let active = [];
	function dialog(method, title, value, opts) {
		assert.ok(replies.length, `unexpected ${method}: ${title.slice(0, 80)}`);
		const [expected, answer] = replies.shift();
		assert.equal(method, expected);
		const result = typeof answer === "function" ? answer(title, value, opts) : answer;
		if (method === "select" && typeof result === "string") assert.ok(value.includes(result), `missing button '${result}' in ${value}`);
		return Promise.resolve(result);
	}
	const ui = { notify: (m) => notices.push(m), setToolsExpanded() {},
		setStatus(key, text) { if (text === undefined) statuses.delete(key); else statuses.set(key, text); },
		setWidget(key, value) { if (value === undefined) widgets.delete(key); else widgets.set(key, value); },
		select: (...args) => dialog("select", ...args), confirm: (...args) => dialog("confirm", ...args), input: (...args) => dialog("input", ...args),
		custom: () => assert.fail("web actions must use mouse-accessible native dialogs"),
	};
	const ctx = { cwd: root, mode, hasUI: true, ui, sessionManager: { getBranch: () => entries } };
	extension({ on(n, h) { handlers.set(n, [...(handlers.get(n) ?? []), h]); }, registerCommand(n, c) { commands.set(n, c); },
		registerShortcut() {}, registerTool(t) { tools.set(t.name, t); }, getActiveTools: () => active, setActiveTools: (a) => { active = a; },
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }), sendUserMessage: (m) => messages.push(m),
	});
	const run = (name, args) => commands.get(name).handler(args, ctx);
	return { ctx, tools, statuses, widgets, entries, replies, messages, notices, run,
		async emit(n, event = {}) { for (const h of handlers.get(n) ?? []) await h(event, ctx); },
	};
}
const history = "Tool details", todos = "📋 Todos";
const option = (pattern) => (_title, options) => { const found = options.find(o => pattern.test(o)); assert.ok(found, `missing option ${pattern}`); return found; };
try {
	globalThis.__piWebHttpDispatcherConfigured = true;
	const terminal = mount(rollingTools, "tui"); await terminal.emit("session_start");
	assert.equal(typeof terminal.widgets.get("rolling-tools"), "function"); assert.equal(terminal.statuses.size, 0);
	const hooks = globalThis[Symbol.for("pi-rolling-tools.dynamicHooks.v3")], terminalRender = hooks.handleToolRender;

	configure({ maxRecentTools: 1, lazyLoadStep: 1, defaultViewMode: "running" });
	const r = mount(rollingTools), originalNotify = r.ctx.ui.notify;
	await r.emit("session_start"); await r.emit("agent_start");
	assert.equal(r.ctx.ui.notify, originalNotify); assert.equal(hooks.handleToolRender, terminalRender);
	assert.equal(r.statuses.size, 0); assert.deepEqual(r.widgets.get(history), ["No tool history yet."]);
	for (const id of ["one", "two"]) {
		await r.emit("tool_execution_start", { toolCallId: id, toolName: "bash", args: { command: `echo ${id}` } });
		const live = r.widgets.get(history).join("\n");
		assert.match(live, /bash · running/i); assert.match(live, new RegExp(`Input: echo ${id}`));
		await r.emit("tool_execution_end", { toolCallId: id, toolName: "bash", result: { content: [{ type: "text", text: `fixture ${id} output\n\n</details> & ![plot](fixture.png)\r\n<em>literal</em>` }] } });
		assert.match(r.widgets.get(history).join("\n"), new RegExp(`Output: fixture ${id} output`)); assert.equal(r.statuses.size, 0);
	}
	assert.doesNotMatch(r.widgets.get(history).join("\n"), /echo one/);
	const toolPage = (id, page, proceed) => ["confirm", (title, body) => {
		assert.match(title, new RegExp("Tool History · " + page + "/2")); assert.match(body, new RegExp(`<details><summary>[^<]*echo ${id}</summary>`));
		assert.match(body, /<strong>Arguments<\/strong>/); assert.match(body, new RegExp("fixture " + id + " output"));
		assert.match(body, /&lt;\/details&gt; &amp; !\[plot\]/); assert.doesNotMatch(body, /[\r\n]|<em>|<img>/);
		return proceed;
	}];
	r.replies.push(["select", "Next page"], ["select", option(/echo one/)], toolPage("one", 2, true),
		["select", "Previous page"], ["select", "View this page"], toolPage("two", 1, false));
	await r.run("rolling-tools", "history"); assert.equal(r.replies.length, 0);
	r.replies.push(["select", (title) => { assert.match(title, /Host: pi-web/); return "Close"; }]); await r.run("rolling-tools", "status");
	await r.run("rolling-tools", "off"); assert.equal(r.statuses.size, 0); assert.equal(r.widgets.size, 0);
	await r.run("rolling-tools", "on"); assert.ok(r.widgets.has(history));
	configure({ disableInPiWeb: true }); await r.run("rolling-tools", "reload"); assert.equal(r.widgets.size, 0);
	await r.emit("session_shutdown"); assert.equal(hooks.handleToolRender, terminalRender);
	for (const [config, env, enabled] of [[true, undefined, false], [true, "on", true], [false, "off", false], [false, undefined, true]]) {
		configure({ disableInPiWeb: config }); if (env) process.env.PI_ROLLING_TOOLS_PI_WEB = env; else delete process.env.PI_ROLLING_TOOLS_PI_WEB;
		const h = mount(rollingTools); await h.emit("session_start"); assert.equal(h.widgets.has(history), enabled);
		if (!enabled) { await h.run("rolling-tools", "on"); assert.ok(h.widgets.has(history)); }
		await h.emit("session_shutdown"); assert.equal(h.widgets.size, 0); assert.equal(h.statuses.size, 0);
	}
	console.log("✓ command-free live tool preview, output cap, direct Next/Previous page, literal details, opt-outs and cleanup");

	const t = mount(todoTree), openTodo = () => t.run("todo", "open"); await t.emit("session_start"); assert.ok(!t.widgets.has(todos));
	await t.run("todo", "on"); assert.deepEqual(t.widgets.get(todos), ["No tasks yet."]); assert.equal(t.statuses.size, 0);
	t.replies.push(["confirm", (title, body) => { assert.match(title, /Empty/); assert.match(body, /No entries/); return true; }]); await openTodo();
	const tool = t.tools.get("todo"); await tool.execute("fixture", { action: "batch_create", tasks: [
		{ id: "1", subject: "Parent" }, { id: "1.1", parentId: "1", subject: "Child <tag>", description: "A & B </summary>" },
	] });
	const preview = () => t.widgets.get(todos).join("\n");
	assert.match(preview(), /0\/1 complete/); assert.match(preview(), /\n  ○ #1\.1 Child <tag>/); assert.match(preview(), /Description: A & B <\/summary>/);
	await tool.execute("fixture-annotation", { action: "update", id: "1", note: "Agent annotation" });
	assert.match(preview(), /\[Agent\] Agent annotation/);
	const task = (id) => t.entries.at(-1).data.tasks.find(item => item.id === id);
	const childAction = (action) => [["confirm", true], ["select", option(/Child/)], ["select", action]];
	const length = t.entries.length;
	t.replies.push(["confirm", (_title, body) => {
		assert.match(body, /<details><summary>[^<]*Parent[^<]*<\/summary><div><strong>agent:<\/strong> Agent annotation<\/div><ul><li><details><summary>[^<]*Child &lt;tag&gt;/);
		assert.match(body, /A &amp; B &lt;\/summary&gt;/); return false;
	}]); await openTodo(); assert.equal(t.entries.length, length, "browsing makes no edits");
	t.replies.push(...childAction("Complete task"), ...childAction("Reopen task"), ...childAction("Cancel task"), ...childAction("Restore task"),
		...childAction("Add note"), ["input", "browser fixture note"], ["confirm", false], ["confirm", (_title, body) => {
			assert.match(body, /<strong>user:<\/strong> browser fixture note/); return false;
		}]);
	await openTodo(); assert.equal(t.replies.length, 0); assert.equal(task("1.1").status, "pending"); assert.equal(task("1.1").notes[0].author, "user"); assert.equal(t.messages.length, 0); assert.match(preview(), /\[User\] browser fixture note/);
	t.replies.push(...childAction("Add note"), ["input", "reminder fixture"], ["confirm", true], ...childAction("Complete task"), ["confirm", false]);
	await openTodo(); assert.match(t.messages[0], /reminder fixture/); assert.equal(task("1").status, "completed"); assert.match(preview(), /1\/1 complete/);
	t.replies.push(["select", "Close"]); await t.run("todo", "status");
	// An outstanding response must never apply an old branch's edit to a new task with the same id.
	let signal, release;
	t.replies.push(...childAction((_title, _choices, opts) => { signal = opts.signal; return new Promise(resolve => { release = resolve; }); }));
	const pending = openTodo(); await new Promise(resolve => setImmediate(resolve)); await openTodo(); // already open
	t.entries.length = 0; await t.emit("session_tree"); assert.ok(signal.aborted); release("Reopen task"); await pending;
	assert.equal(t.entries.length, 0); assert.doesNotMatch(preview(), /Parent|Child/); await t.run("todo", "off"); assert.equal(t.widgets.size, 0);
	await t.run("todo", "on");
	await tool.execute("fixture-paged", { action: "batch_create", tasks: [{ id: "1", subject: "Page parent" },
		...Array.from({ length: 31 }, (_, i) => ({ id: `1.${i + 1}`, parentId: "1", subject: `Leaf [${i + 1}]` }))] });
	assert.match(preview(), /Tasks: 30\/32/); assert.doesNotMatch(preview(), /Leaf \[30\]/);
	t.replies.push(["select", (title, options) => { assert.match(title, /1\/2/); assert.ok(options.some(s => s.includes("Leaf") && s.includes("29"))); return "Next page"; }],
		["select", "View this page"], ["confirm", (title, body) => {
			assert.match(title, /2\/2/); assert.match(body, /<details open><summary>[^<]*Page parent/);
			assert.match(body, /Leaf \[30\]/); assert.doesNotMatch(body, /Leaf \[29\]/); return false;
		}]);
	await openTodo(); assert.equal(t.replies.length, 0);
	t.replies.push(["select", (_title, _choices, opts) => { signal = opts.signal; return new Promise(resolve => { release = resolve; }); }]);
	const treeOpen = openTodo(); await t.emit("session_shutdown"); assert.ok(signal.aborted); release("Next page"); await treeOpen;
	assert.equal(t.statuses.size, 0); assert.equal(t.widgets.size, 0);
	console.log("✓ native todo preview, annotations, manual paging with ancestors, editing, branch and shutdown cleanup");

	delete globalThis.__piWebHttpDispatcherConfigured;
	const rpc = mount(rollingTools); await rpc.emit("session_start"); assert.equal(typeof rpc.widgets.get("rolling-tools"), "function");
	assert.equal(rpc.statuses.size, 0); await rpc.run("rolling-tools", "history"); assert.match(rpc.notices.at(-1), /does not support the overlay/);
	await rpc.emit("session_shutdown"); await terminal.emit("session_shutdown");
	console.log("✓ ordinary RPC and terminal clients keep their original UI");
} finally { rmSync(root, { recursive: true, force: true }); }
