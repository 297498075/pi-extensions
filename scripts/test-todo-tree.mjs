import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	TodoTreeStore,
	TodoTreeWidgetComponent,
	TodoTreeOverlayComponent,
	default as todoTreeExtension,
} from "../extensions/todo-tree.ts";

initTheme();

console.log("=== Test 1: Store Hierarchy & Auto-generated IDs ===");
const store = new TodoTreeStore();

// 1. Create top-level tasks
const task1 = store.createTask({ subject: "Database Layer Migration" });
assert.equal(task1.id, "1");
assert.equal(task1.parentId, null);

const task2 = store.createTask({ subject: "API Endpoints Implementation" });
assert.equal(task2.id, "2");

// 2. Create subtasks under task 1
const sub1_1 = store.createTask({ parentId: "1", subject: "Define Domain Models" });
assert.equal(sub1_1.id, "1.1");
assert.equal(sub1_1.parentId, "1");

const sub1_2 = store.createTask({ parentId: "1", subject: "Implement Repository" });
assert.equal(sub1_2.id, "1.2");

// 3. Create subtask under 1.2 (3 levels)
const sub1_2_1 = store.createTask({ parentId: "1.2", subject: "Write SQL queries" });
assert.equal(sub1_2_1.id, "1.2.1");

console.log("✓ Tree hierarchy and automatic hierarchical IDs work correctly.");

console.log("=== Test 2: Batch Create ===");
const batch = store.batchCreate([
	{ parentId: "2", subject: "Add User Endpoint" },
	{ parentId: "2", subject: "Add Auth Middleware" },
]);
assert.equal(batch.length, 2);
assert.equal(batch[0].id, "2.1");
assert.equal(batch[1].id, "2.2");
console.log("✓ Batch creation works properly.");

console.log("=== Test 3: Status Linkage & Progress Calculation ===");
// Initial stats:
// Leaves: 1.1, 1.2.1, 2.1, 2.2 (total 4 leaves)
let stats = store.getProgressStats();
assert.equal(stats.total, 4);
assert.equal(stats.completed, 0);
assert.equal(stats.percent, 0);

// Mark 1.1 in_progress -> parent 1 becomes in_progress
store.updateTask("1.1", { status: "in_progress" });
assert.equal(store.getTask("1.1")?.status, "in_progress");
assert.equal(store.getTask("1")?.status, "in_progress");

// Mark 1.1 completed
store.updateTask("1.1", { status: "completed" });
stats = store.getProgressStats();
assert.equal(stats.completed, 1);
assert.equal(stats.percent, 25);

// Complete 1.2.1 -> parent 1.2 becomes completed -> parent 1 becomes completed
store.updateTask("1.2.1", { status: "completed" });
assert.equal(store.getTask("1.2")?.status, "completed");
assert.equal(store.getTask("1")?.status, "completed");

stats = store.getProgressStats();
assert.equal(stats.completed, 2);
assert.equal(stats.percent, 50);
console.log("✓ Parent-child status linkage and progress calculation work as expected.");

console.log("=== Test 4: Dynamic Task Evolution & Cancellation ===");
// Requirement: Scope changes - task 2.2 is cancelled/no longer needed
store.updateTask("2.2", { status: "cancelled" });
stats = store.getProgressStats();
// Total active leaves now: 3 (1.1, 1.2.1, 2.1), cancelled is 1
assert.equal(stats.total, 3);
assert.equal(stats.cancelled, 1);
assert.equal(stats.completed, 2);
assert.equal(stats.percent, 67); // 2/3 = 67%

// Dynamically add a new subtask under task 2
const sub2_3 = store.createTask({ parentId: "2", subject: "Add Rate Limiter" });
assert.equal(sub2_3.id, "2.3");
stats = store.getProgressStats();
assert.equal(stats.total, 4); // 1.1, 1.2.1, 2.1, 2.3
console.log("✓ Dynamic task addition and cancellation work properly without stalling progress.");

console.log("=== Test 5: Multiple In-Progress Tasks & Breadcrumbs ===");
// Mark 2.1 and 2.3 in_progress simultaneously
store.updateTask("2.1", { status: "in_progress" });
store.updateTask("2.3", { status: "in_progress" });

const activeTasks = store.getActiveInProgressTasks();
assert.equal(activeTasks.length, 2);
assert.equal(activeTasks[0].task.id, "2.1");
assert.equal(activeTasks[0].breadcrumb, "[API Endpoints Implementation] ");
assert.equal(activeTasks[1].task.id, "2.3");
assert.equal(activeTasks[1].breadcrumb, "[API Endpoints Implementation] ");
console.log("✓ Multiple parallel in-progress tasks and breadcrumbs verified.");

console.log("=== Test 6: Notes / Annotations ===");
store.addUserNote("2.1", "Ensure backward compatibility with v1 API.");
const task2_1 = store.getTask("2.1");
assert.equal(task2_1?.notes?.length, 1);
assert.equal(task2_1?.notes?.[0].author, "user");
assert.equal(task2_1?.notes?.[0].text, "Ensure backward compatibility with v1 API.");
console.log("✓ User notes / annotations stored correctly.");

console.log("=== Test 7: Widget Rendering (Multi-task & No Height Limit) ===");
const fakeTheme = {
	fg: (name, text) => text,
	bg: (name, text) => text,
	style: (text) => text,
};

let modalOpened = false;
const widget = new TodoTreeWidgetComponent(
	{ requestRender: () => {} },
	fakeTheme,
	store,
	() => {
		modalOpened = true;
	},
);

const lines = widget.render(100);
// Should render line 0 for 2.1 with [📋 ] and line 1 for 2.3
assert.ok(lines.length >= 2, `Expected at least 2 lines for 2 parallel tasks, got ${lines.length}`);
assert.ok(lines[0].includes("[📋 ]"), "Line 0 must include [📋 ] button");
assert.ok(lines[0].includes("2.1"), "Line 0 must mention first active task");
assert.ok(lines[1].includes("2.3"), "Line 1 must display second parallel active task");

// Test click button
const handled = widget.handleMouse({
	type: "click",
	x: 96,
	y: 0,
	button: "left",
});
assert.ok(handled?.handled, "Click on button should be handled");
assert.ok(modalOpened, "Modal should be opened on button click");
console.log("✓ Main widget rendering and button interaction verified.");

console.log("=== Test 8: Modal Overlay Rendering & Keyboard / Scrollbar ===");
let modalClosed = false;
let promptedNoteTaskId = null;

const overlay = new TodoTreeOverlayComponent(
	{ terminal: { rows: 24, cols: 80 }, requestRender: () => {} },
	fakeTheme,
	store,
	() => {
		modalClosed = true;
	},
	(taskId) => {
		promptedNoteTaskId = taskId;
	},
);

const modalLines = overlay.render(80);
assert.ok(modalLines.length > 5, "Modal should render header, body, details, actions");
assert.ok(modalLines.some((l) => l.includes("📋 Todo Tree")), "Header must have title");

// Test key navigation
overlay.handleKey("down");
overlay.handleKey("n");
assert.ok(promptedNoteTaskId !== null, "Key 'n' should prompt for note");

overlay.handleKey("escape");
assert.ok(modalClosed, "Key 'escape' should close modal");
console.log("✓ Modal overlay rendering and keyboard control verified.");

console.log("=== Test 9: Extension Registration & Disabled-by-Default ===");
const registeredTools = new Map();
const registeredCommands = new Map();
const registeredShortcuts = new Map();
const eventHandlers = new Map();

const mockPi = {
	registerTool(tool) {
		registeredTools.set(tool.name, tool);
	},
	registerCommand(name, options) {
		registeredCommands.set(name, options);
	},
	registerShortcut(shortcut, options) {
		registeredShortcuts.set(shortcut, options);
	},
	on(event, handler) {
		const list = eventHandlers.get(event) || [];
		list.push(handler);
		eventHandlers.set(event, list);
	},
	sendUserMessage: () => {},
};

todoTreeExtension(mockPi);

assert.ok(registeredTools.has("todo"), "'todo' tool must be registered");
assert.ok(registeredCommands.has("todo"), "'todo' command must be registered");
assert.ok(registeredCommands.has("todos"), "'todos' command alias must be registered");

// Test before_provider_request hides tool when disabled
const beforeProviderReq = eventHandlers.get("before_provider_request")?.[0];
assert.ok(beforeProviderReq, "before_provider_request handler registered");

const testPayload = {
	tools: [
		{ name: "bash" },
		{ name: "read" },
		{ name: "todo" },
	],
};

beforeProviderReq({ payload: testPayload });
assert.equal(testPayload.tools.length, 2, "When disabled, 'todo' tool should be hidden from LLM");
assert.ok(!testPayload.tools.some((t) => t.name === "todo"), "'todo' tool must be filtered out");
console.log("✓ Dynamic hiding of tool when disabled verified (0 token pollution on small tasks).");

console.log("=== Test 10: Tool Execution & Details Format for todo-loop ===");
const todoTool = registeredTools.get("todo");
const result = await todoTool.execute("call-1", {
	action: "create",
	subject: "Setup CI pipeline",
});

assert.ok(result.content[0].text.startsWith("✓ Created"), "Content summary must be single-line confirmation");
assert.ok(Array.isArray(result.details.tasks), "Details must include tasks snapshot");
const lastTaskInDetails = result.details.tasks[result.details.tasks.length - 1];
assert.equal(typeof lastTaskInDetails.completed, "boolean", "completed field must exist for todo-loop");
assert.equal(typeof lastTaskInDetails.done, "boolean", "done field must exist for todo-loop");

console.log("✓ Tool execution response and details compatibility verified.");

console.log("\nALL 10 TESTS PASSED SUCCESSFULLY!");
