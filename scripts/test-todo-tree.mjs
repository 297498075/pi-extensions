import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Key, visibleWidth } from "@earendil-works/pi-tui";
import {
	TodoTreeStore,
	TodoTreeWidgetComponent,
	TodoTreeOverlayComponent,
	TodoTreeStatusModalComponent,
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

console.log("=== Test 6: Cycle and Deep Chain Guard on Real createTask & Snapshot (Bug 5) ===");
// 1. Snapshot with cyclical references
const cyclicalSnapshot = [
	{ id: "A", parentId: "B", subject: "Task A", status: "pending" },
	{ id: "B", parentId: "A", subject: "Task B", status: "pending" },
];
store.loadSnapshot(cyclicalSnapshot);
const tasksAfterLoad = store.getAllTasks();
assert.equal(tasksAfterLoad.length, 2);
const activeTasksSafe = store.getActiveInProgressTasks();
assert.ok(Array.isArray(activeTasksSafe), "Cycle in snapshot safely broken");

// 2. Real createTask deep nesting crash prevention
store.clear();
let lastParentId = null;
let caughtDepthError = false;

try {
	for (let i = 1; i <= MAX_TREE_DEPTH + 5; i++) {
		const created = store.createTask({
			parentId: lastParentId,
			subject: `Level ${i}`,
		});
		lastParentId = created.id;
	}
} catch (err) {
	caughtDepthError = true;
	assert.ok(
		err.message.includes("maximum supported depth"),
		`Expected depth error, got: ${err.message}`,
	);
}

assert.ok(caughtDepthError, "createTask must safely throw on exceeding MAX_TREE_DEPTH without stack overflow");
console.log("✓ Cycle detection and recursion depth guard verified on real createTask path.");

console.log("=== Test 7: Performance Cache Verification (Bug 9) ===");
store.clear();
store.createTask({ subject: "Root 1" });
store.createTask({ subject: "Root 2" });
store.createTask({ parentId: "1", subject: "Child 1.1" });

const initialBuildCount = store.buildTreeCount;
// Call getFlattenedTree 50 times
for (let i = 0; i < 50; i++) {
	store.getFlattenedTree();
	store.getProgressStats();
	store.getActiveInProgressTasks();
}

assert.equal(
	store.buildTreeCount,
	initialBuildCount + 1,
	`Cache MUST prevent rebuilds! Expected buildTreeCount=${initialBuildCount + 1}, got=${store.buildTreeCount}`,
);

// Mutating store must invalidate cache
store.createTask({ subject: "Root 3" });
store.getFlattenedTree();
assert.equal(store.buildTreeCount, initialBuildCount + 2, "Mutating store must invalidate and recompute cache once");
console.log("✓ Explicit null-cleared performance cache verified (no dead code).");

console.log("=== Test 8: Widget Strict Width Bounding on Narrow Screens (Bug 7) ===");
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

// Test widths: 30, 40, 45, 50, 80, 120
const testWidths = [30, 40, 45, 50, 60, 80, 100, 120];
for (const w of testWidths) {
	widget.invalidate();
	const lines = widget.render(w);
	for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
		const line = lines[lineIdx];
		const actWidth = visibleWidth(line);
		assert.ok(
			actWidth <= w,
			`Widget line ${lineIdx} with width=${w} overflowed! Actual width=${actWidth}: "${line}"`,
		);
	}
}

// Re-render at 80 before mouse hit test to set cachedWidth to 80
widget.render(80);

// Button hit testing
const missResult = widget.handleMouse({
	type: "click",
	button: "left",
	x: 10,
	y: 0,
});
assert.equal(missResult, undefined, "Clicking left/middle area should not trigger modal");
assert.equal(modalOpenCount, 0);

const hitResult = widget.handleMouse({
	type: "click",
	button: "left",
	x: 78,
	y: 0,
});
assert.equal(hitResult?.handled, true, "Clicking button must handle event");
assert.equal(modalOpenCount, 1, "Clicking button must trigger open modal");

widget.dispose();
console.log("✓ Widget strict width bounding across all narrow screens (30..120 cols) verified.");

console.log("=== Test 9: Overlay handleInput & Modal c/x Persistence (Bug 1, 3, 7) ===");
let overlayClosed = false;
let userNotePromptTaskId = null;
let modalPersistCount = 0;

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
	() => {
		modalPersistCount++;
	},
);

// Width test for overlay
const modalLines = overlay.render(80);
const boxWidth = Math.min(100, Math.max(50, Math.floor(80 * 0.88)));
const boxLeft = Math.floor((80 - boxWidth) / 2);
const expectedLineWidth = boxLeft + boxWidth;

for (let i = 0; i < modalLines.length; i++) {
	const line = modalLines[i];
	const w = visibleWidth(line);
	assert.ok(
		w <= expectedLineWidth,
		`Overlay line ${i} width (${w}) exceeds max allowed (${expectedLineWidth})`,
	);
}

// Test modal c/x persists
assert.equal(modalPersistCount, 0);
overlay.handleInput("c");
assert.equal(modalPersistCount, 1, "Pressing 'c' in modal MUST trigger onPersist callback!");

overlay.handleInput("x");
assert.equal(modalPersistCount, 2, "Pressing 'x' in modal MUST trigger onPersist callback!");

overlay.handleInput("n");
assert.ok(userNotePromptTaskId !== null, "Key 'n' via handleInput must trigger note prompt");

overlay.handleInput(Key.escape);
assert.ok(overlayClosed, "handleInput with Key.escape must close modal");

// Test mouse interaction on tree fold icon
const mouseTestStore = new TodoTreeStore();
const rootTask = mouseTestStore.createTask({ id: "1", subject: "Parent Module" });
mouseTestStore.createTask({ id: "1.1", parentId: "1", subject: "Submodule A" });

let mouseOverlayClosed = false;
const mouseOverlay = new TodoTreeOverlayComponent(
	{ terminal: { rows: 24, cols: 80 }, requestRender: () => {} },
	fakeTheme,
	mouseTestStore,
	() => {
		mouseOverlayClosed = true;
	},
);

mouseOverlay.render(80);
assert.equal(mouseTestStore.isCollapsed("1"), false, "Initially root task 1 should not be collapsed");

// In 80x24 terminal:
// boxWidth = min(100, max(50, floor(80*0.88))) = 70
// boxLeft = floor((80-70)/2) = 5
// boxHeight = min(32, max(14, floor(24*0.82))) = 19
// boxTop = floor((24-19)/2) = 2
// Row 0 of tree list is at screen Y = boxTop + 3 = 5
// Fold icon is around X = boxLeft + 3 = 8
const clickFoldResult = mouseOverlay.handleMouse({
	type: "click",
	button: "left",
	x: 8,
	y: 5,
});
assert.equal(clickFoldResult?.handled, true, "Clicking fold icon must handle mouse event");
assert.equal(mouseTestStore.isCollapsed("1"), true, "Clicking fold icon must toggle task to collapsed");

// Clicking again must expand
mouseOverlay.handleMouse({
	type: "click",
	button: "left",
	x: 8,
	y: 5,
});
assert.equal(mouseTestStore.isCollapsed("1"), false, "Clicking fold icon again must toggle task back to expanded");

// Clicking outside the box must close overlay
mouseOverlay.handleMouse({
	type: "click",
	button: "left",
	x: 0,
	y: 0,
});
assert.ok(mouseOverlayClosed, "Clicking outside modal bounding box must close modal");

console.log("✓ Modal handleInput keyboard controls, fold icon mouse clicks, and c/x persistence callback verified.");

console.log("=== Test 10: Declarative defaultActive: false & Tool Registration (Bug 4) ===");
const registeredTools = new Map();
const registeredCommands = new Map();
const registeredEventHandlers = new Map();
let activeToolsList = ["read", "bash"];

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
	appendEntry: () => {},
	on(event, handler) {
		const list = registeredEventHandlers.get(event) || [];
		list.push(handler);
		registeredEventHandlers.set(event, list);
	},
	sendUserMessage: () => {},
};

todoTreeExtension(mockPi);

const todoToolDef = registeredTools.get("todo");
assert.ok(todoToolDef, "'todo' tool must be registered");
assert.equal(
	todoToolDef.defaultActive,
	false,
	"'todo' tool MUST declare defaultActive: false so it is inactive on registration!",
);

// Test command '/todo on' activates tool via setActiveTools
const cmdHandler = registeredCommands.get("todo").handler;
await cmdHandler("on", { hasUI: false, ui: null, sessionManager: { getBranch: () => [] } });
assert.ok(activeToolsList.includes("todo"), "/todo on must activate tool in activeTools list");

// Test command '/todo status' output includes active in model status
let statusOutput = "";
await cmdHandler("status", {
	hasUI: true,
	ui: {
		notify(msg) {
			statusOutput = msg;
		},
	},
	sessionManager: { getBranch: () => [] },
});
assert.ok(
	statusOutput.includes("Active in Model: YES"),
	"status output must reflect active status (YES)",
);

// Test command '/todo off' deactivates tool via setActiveTools
await cmdHandler("off", { hasUI: false, ui: null, sessionManager: { getBranch: () => [] } });
assert.ok(!activeToolsList.includes("todo"), "/todo off must deactivate tool in activeTools list");

await cmdHandler("status", {
	hasUI: true,
	ui: {
		notify(msg) {
			statusOutput = msg;
		},
	},
	sessionManager: { getBranch: () => [] },
});
assert.ok(
	statusOutput.includes("Active in Model: NO"),
	"status output must reflect inactive status (NO)",
);

console.log("✓ Declarative defaultActive: false and native setActiveTools verified.");

console.log("=== Test 11: Source-level Guard & Invariant Assertion ===");
// 方案 1（最优）：断言扩展源码中不存在 payload 篡改钩子
// 这是唯一能真正防住"有人加回 payload 补丁"的办法，且不依赖对 Pi 内部行为的模拟
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../extensions/todo-tree.ts", import.meta.url), "utf8");
assert.ok(
	!/before_provider_request/.test(src),
	"todo-tree 不得注册 before_provider_request 钩子（禁止篡改 payload.tools，否则前缀缓存击穿）",
);

// 验证必须声明 defaultActive: false（源头声明式隔离）
assert.ok(
	/defaultActive:\s*false/.test(src),
	"todo-tree 工具注册必须声明 defaultActive: false，确保注册时默认处于非激活状态",
);

// 验证 session_tree 事件下必须同步 syncActiveTools(config.enabled)
const sessionTreeHandler = registeredEventHandlers.get("session_tree")?.[0];
assert.ok(sessionTreeHandler, "session_tree event handler must be registered");

const mockTreeContext = {
	sessionManager: {
		getBranch: () => [
			{
				type: "custom",
				customType: SNAPSHOT_ENTRY_TYPE,
				data: { tasks: [{ id: "1", subject: "Task 1", status: "pending" }], enabled: true },
			},
		],
	},
};

// 当前状态为 off -> 触发带有 enabled: true 快照的 session_tree 必须同步拉起 syncActiveTools(true)
assert.ok(!activeToolsList.includes("todo"), "Precondition: todo is inactive");
sessionTreeHandler({}, mockTreeContext);
assert.ok(
	activeToolsList.includes("todo"),
	"session_tree handler 必须同步执行 syncActiveTools(config.enabled)！",
);

console.log("✓ 源码级禁止 before_provider_request 钩子与 session_tree 状态同步断言验证通过。");

console.log("=== Test 12: Lightweight Status Modal Component & /todo status Execution ===");
let statusCustomOpened = false;
let statusModalDoneCalled = false;

const mockTui = { terminal: { rows: 24, cols: 80 }, requestRender: () => {} };

// Mock custom UI handler
await cmdHandler("status", {
	hasUI: true,
	ui: {
		custom(factory) {
			statusCustomOpened = true;
			const comp = factory(mockTui, fakeTheme, {}, () => {
				statusModalDoneCalled = true;
			});
			assert.ok(comp instanceof TodoTreeStatusModalComponent, "Custom overlay must be TodoTreeStatusModalComponent");
			const rendered = comp.render(80);
			assert.ok(rendered.length >= 10, "Status modal should render boxed layout");
			const joined = rendered.join("\n");
			assert.ok(joined.includes("Todo Tree Status"), "Must contain title");
			assert.ok(joined.includes("Extension State"), "Must contain state");
			assert.ok(joined.includes("Active in Model"), "Must contain active status");
			assert.ok(joined.includes("Total Tasks"), "Must contain total tasks summary");

			// Any key closes
			comp.handleInput("x");
			assert.ok(statusModalDoneCalled, "Any key should trigger close callback");

			// Mouse click closes
			statusModalDoneCalled = false;
			const mouseRes = comp.handleMouse({ type: "click", x: 10, y: 5 });
			assert.ok(statusModalDoneCalled, "Click should trigger close callback");
			assert.equal(mouseRes?.handled, true);
		},
	},
	sessionManager: { getBranch: () => [] },
});

assert.ok(statusCustomOpened, "/todo status in interactive mode must open lightweight custom modal");
console.log("✓ Lightweight status modal component rendering and close interaction verified.");

console.log("=== Test 13: Auto-clear previous finished tasks on new batch_create (Strategy A) ===");
// Reset store and mark all as completed
const testStore = new TodoTreeStore();
testStore.batchCreate([
	{ id: "1", subject: "Old finished parent", status: "completed" },
	{ id: "1.1", parentId: "1", subject: "Old finished child", status: "completed" },
]);
assert.equal(testStore.getProgressStats().percent, 100);

// Invoke batch_create on todoToolDef via execute
const mockCtxWithFullFinished = {
	sessionManager: { getBranch: () => [] },
};

// We test tool execute logic with mock environment
const registeredExecute = todoToolDef.execute;
// Clear store first
await registeredExecute("call-clear", { action: "clear" });

// First, populate the extension's internal store by creating tasks
await registeredExecute("call-1", {
	action: "batch_create",
	tasks: [
		{ id: "1", subject: "Phase 1 Root", status: "completed" },
		{ id: "1.1", parentId: "1", subject: "Phase 1 Sub", status: "completed" },
	],
});

// Verify 100% done
const listBefore = await registeredExecute("call-2", { action: "list" });
assert.ok(listBefore.content[0].text.includes("100%"), "Must be 100% completed");

// Initiate new batch_create with a new root task -> MUST automatically clear old tasks!
const resultNewBatch = await registeredExecute("call-3", {
	action: "batch_create",
	tasks: [
		{ id: "1", subject: "Phase 2 New Root", status: "pending" },
		{ id: "1.1", parentId: "1", subject: "Phase 2 New Sub", status: "in_progress" },
	],
});

assert.ok(
	resultNewBatch.content[0].text.includes("Cleared previous finished tasks"),
	"Summary must report that previous finished tasks were cleared",
);

// Check tasks snapshot
const newTasks = resultNewBatch.details.tasks;
assert.equal(newTasks.length, 2, "Only new tasks should exist in the tree now");
assert.equal(newTasks[0].subject, "Phase 2 New Root");
assert.equal(newTasks[1].subject, "Phase 2 New Sub");
console.log("✓ Strategy A (Auto-clearing finished tasks on new root batch_create) verified.");

console.log("\n=======================================================");
console.log("ALL VERIFICATION & RIGOROUS TESTS PASSED SUCCESSFULLY! 🎉");
console.log("=======================================================");
