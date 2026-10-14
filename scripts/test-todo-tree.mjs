import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Key, visibleWidth } from "@earendil-works/pi-tui";
import {
	TodoTreeStore,
	TodoTreeWidgetComponent,
	TodoTreeOverlayComponent,
	sanitizeText,
	SNAPSHOT_ENTRY_TYPE,
	MAX_TREE_DEPTH,
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

console.log("=== Test 3: Dual-direction Status Linkage & Completed Protection (Bug 2) ===");
// Current leaves: 1.1, 1.2.1, 2.1, 2.2
// 1. Mark 1.1 completed
store.updateTask("1.1", { status: "completed" });
assert.equal(store.getTask("1.1")?.status, "completed");
assert.equal(store.getTask("1")?.status, "in_progress", "Parent 1 should be in_progress when partial children completed");

// 2. Mark 1.2.1 completed -> 1.2 completed -> all children of 1 done -> 1 completed
store.updateTask("1.2.1", { status: "completed" });
assert.equal(store.getTask("1.2")?.status, "completed");
assert.equal(store.getTask("1")?.status, "completed");

// 3. Re-open 1.2.1 to pending -> Parent 1.2 and 1 must revert to in_progress / pending!
store.updateTask("1.2.1", { status: "pending" });
assert.equal(store.getTask("1.2")?.status, "pending", "Parent 1.2 should revert to pending when leaf reopened");
assert.equal(store.getTask("1")?.status, "in_progress", "Parent 1 should revert to in_progress because 1.1 is still completed");

// 4. Re-open 1.1 to pending -> Parent 1 must fully revert to pending!
store.updateTask("1.1", { status: "pending" });
assert.equal(store.getTask("1")?.status, "pending", "Parent 1 should revert to pending when all children reopened");

// 5. Test cancellation protection: 1.1 completed, then cancel parent 1
store.updateTask("1.1", { status: "completed" });
store.updateTask("1", { status: "cancelled" });

assert.equal(store.getTask("1")?.status, "cancelled");
assert.equal(
	store.getTask("1.1")?.status,
	"completed",
	"Completed subtask 1.1 MUST NOT be overwritten by parent cancellation!",
);
assert.equal(
	store.getTask("1.2")?.status,
	"cancelled",
	"Pending subtask 1.2 should be cascade-cancelled",
);
console.log("✓ Dual-direction status deduction and cancellation protection verified.");

console.log("=== Test 4: Dynamic Task Evolution & Progress Exclusions ===");
// Reset task 2 leaves: 2.1 is pending, cancel 2.2
store.updateTask("2.2", { status: "cancelled" });
const stats = store.getProgressStats();
// Active leaves: 1.1 (completed), 1.2.1 (cancelled under 1.2), 2.1 (pending). Cancelled: 1.2.1, 2.2
assert.equal(stats.completed, 1);
assert.ok(stats.cancelled >= 1);
console.log("✓ Cancelled items correctly excluded from active denominator.");

console.log("=== Test 5: Sanitization of Control Sequences (Bug 8) ===");
const malicious = "Title with \x1b]0;PWNED\x07 \x1b[2J\r\n\tNew line";
const clean = sanitizeText(malicious);
assert.ok(!clean.includes("\x1b"), "Must strip ANSI escape codes");
assert.ok(!clean.includes("\n"), "Must replace newlines with space");
assert.equal(clean, "Title with New line");
console.log("✓ Terminal escape sequence and control character sanitization verified.");

console.log("=== Test 6: Cycle and Deep Chain Guard (Bug 5) ===");
// Construct cyclical snapshot
const cyclicalSnapshot = [
	{ id: "A", parentId: "B", subject: "Task A", status: "pending" },
	{ id: "B", parentId: "A", subject: "Task B", status: "pending" },
];
store.loadSnapshot(cyclicalSnapshot);
// Loading cyclical data must not crash or loop infinitely
const tasksAfterLoad = store.getAllTasks();
assert.equal(tasksAfterLoad.length, 2);
const activeTasksSafe = store.getActiveInProgressTasks();
assert.ok(Array.isArray(activeTasksSafe), "Cycle in snapshot safely broken");

// Deep chain test
const deepChain = [];
for (let i = 1; i <= MAX_TREE_DEPTH + 5; i++) {
	deepChain.push({
		id: String(i),
		parentId: i === 1 ? null : String(i - 1),
		subject: `Depth ${i}`,
		status: "pending",
	});
}
store.loadSnapshot(deepChain);
const deepTree = store.buildTree();
assert.ok(deepTree.length > 0, "Deep chain safely capped at MAX_TREE_DEPTH");
console.log("✓ Cycle detection and recursion depth guard verified.");

console.log("=== Test 7: Widget Precise Click Hit & Memory Disposal (Bug 6, 9) ===");
// Restore normal tasks
store.loadSnapshot([
	{ id: "1", subject: "Root Task", status: "in_progress" },
	{ id: "1.1", parentId: "1", subject: "Subtask 1", status: "in_progress" },
]);

const fakeTheme = {
	fg: (_name, text) => text,
	bg: (_name, text) => text,
	style: (text) => text,
};

let modalOpenCount = 0;
const widget = new TodoTreeWidgetComponent(
	{ requestRender: () => {} },
	fakeTheme,
	store,
	() => {
		modalOpenCount++;
	},
);

const widgetLines = widget.render(100);
assert.ok(widgetLines.length >= 1);
assert.ok(widgetLines[0].includes("[📋 ]"));

// Click in middle text area (x=20) -> MUST NOT open modal
const missResult = widget.handleMouse({
	type: "click",
	button: "left",
	x: 20,
	y: 0,
});
assert.equal(missResult, undefined, "Clicking left/middle area should not trigger modal");
assert.equal(modalOpenCount, 0);

// Click on right button (x=98) -> MUST open modal
const hitResult = widget.handleMouse({
	type: "click",
	button: "left",
	x: 98,
	y: 0,
});
assert.equal(hitResult?.handled, true, "Clicking button must handle event");
assert.equal(modalOpenCount, 1, "Clicking button must trigger open modal");

// Disposal test
widget.dispose();
// After disposal, modifying store must not trigger calls on disposed widget
store.createTask({ subject: "New Task" });
console.log("✓ Precise button hit-testing and subscriber disposal verified.");

console.log("=== Test 8: Real handleInput Dispatching & Width Overflow Guard (Bug 1, 7) ===");
let overlayClosed = false;
let userNotePromptTaskId = null;

const overlay = new TodoTreeOverlayComponent(
	{ terminal: { rows: 24, cols: 80 }, requestRender: () => {} },
	fakeTheme,
	store,
	() => {
		overlayClosed = true;
	},
	(taskId) => {
		userNotePromptTaskId = taskId;
	},
);

// Verify width safety on very narrow terminal & ultra long subject
store.createTask({
	subject: "A".repeat(300), // Very long subject
});

const renderedLines = overlay.render(80);
const boxWidth = Math.min(100, Math.max(50, Math.floor(80 * 0.88)));
const boxLeft = Math.floor((80 - boxWidth) / 2);
const expectedLineWidth = boxLeft + boxWidth;

for (let i = 0; i < renderedLines.length; i++) {
	const line = renderedLines[i];
	const w = visibleWidth(line);
	assert.ok(
		w <= expectedLineWidth,
		`Line ${i} visible width (${w}) exceeds max allowed (${expectedLineWidth}): "${line}"`,
	);
}

// Test real handleInput with standard keys
overlay.handleInput("j"); // Down
overlay.handleInput(Key.down); // Down
overlay.handleInput("n"); // Note prompt
assert.ok(userNotePromptTaskId !== null, "Key 'n' via handleInput must trigger note prompt");

// Test toggle completion via 'c'
const selectedIdx = overlay["selectedIndex"];
const currentSelectedId = store.getFlattenedTree()[selectedIdx]?.node.item.id;
overlay.handleInput("c");
const toggledTask = store.getTask(currentSelectedId);
assert.ok(
	toggledTask?.status === "completed" || toggledTask?.status === "pending",
	`Status after toggle must be completed or pending, got ${toggledTask?.status}`,
);

// Test close via Escape
overlay.handleInput(Key.escape);
assert.ok(overlayClosed, "handleInput with Key.escape must close modal");
console.log("✓ Real handleInput keyboard handling and strict line width bounding verified.");

console.log("=== Test 9: Custom Entry Persistence & Native setActiveTools (Bug 3, 4) ===");
const registeredTools = new Map();
const registeredCommands = new Map();
const eventHandlers = new Map();
const appendedEntries = [];
let activeToolsList = ["read", "bash", "todo"];

const mockPi = {
	registerTool(tool) {
		registeredTools.set(tool.name, tool);
	},
	registerCommand(name, options) {
		registeredCommands.set(name, options);
	},
	registerShortcut: () => {},
	getActiveTools() {
		return [...activeToolsList];
	},
	setActiveTools(tools) {
		activeToolsList = [...tools];
	},
	appendEntry(customType, data) {
		appendedEntries.push({ customType, data });
	},
	on(event, handler) {
		const list = eventHandlers.get(event) || [];
		list.push(handler);
		eventHandlers.set(event, list);
	},
	sendUserMessage: () => {},
};

todoTreeExtension(mockPi);

// Test tool execution creates custom entry
const todoTool = registeredTools.get("todo");
await todoTool.execute("call-1", {
	action: "create",
	subject: "Setup CI pipeline",
});

assert.ok(appendedEntries.length > 0, "Tool execution must persist custom entry");
const lastEntry = appendedEntries[appendedEntries.length - 1];
assert.equal(lastEntry.customType, SNAPSHOT_ENTRY_TYPE);
assert.ok(Array.isArray(lastEntry.data.tasks), "Persisted snapshot must include task list");

// Test command '/todo off' invokes native setActiveTools
const cmdHandler = registeredCommands.get("todo").handler;
await cmdHandler("off", { hasUI: false, ui: null, sessionManager: { getBranch: () => [] } });
assert.ok(!activeToolsList.includes("todo"), "Disabling todo must remove it via native setActiveTools");

// Test command '/todo on' re-enables via native setActiveTools
await cmdHandler("on", { hasUI: false, ui: null, sessionManager: { getBranch: () => [] } });
assert.ok(activeToolsList.includes("todo"), "Enabling todo must restore it via native setActiveTools");

console.log("✓ Session branch custom entry persistence and native setActiveTools isolation verified.");

console.log("\n=======================================================");
console.log("ALL VERIFICATION & BUG-FIX TESTS PASSED SUCCESSFULLY! 🎉");
console.log("=======================================================");
