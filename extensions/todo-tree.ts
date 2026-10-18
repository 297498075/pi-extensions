import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, Component, KeyId, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Key, matchesKey, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

// ============================================================================
// 1. Data Models & Constants
// ============================================================================

export const SNAPSHOT_ENTRY_TYPE = "todo-tree-state";
export const MAX_TREE_DEPTH = 32;

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoNote {
	id: string;
	author: "user" | "agent";
	text: string;
	createdAt: number;
}

export interface TodoItem {
	id: string;
	parentId?: string | null;
	subject: string;
	description?: string;
	status: TodoStatus;
	notes?: TodoNote[];
	createdAt: number;
	updatedAt: number;
}

export interface TreeNode {
	item: TodoItem;
	children: TreeNode[];
	depth: number;
	isLastChild: boolean;
	ancestorHasNextSibling: boolean[];
	isDepthCapped?: boolean;
}

export interface ProgressStats {
	total: number;
	completed: number;
	inProgress: number;
	pending: number;
	cancelled: number;
	percent: number;
}

export function sanitizeText(text: string): string {
	if (!text) return "";
	return text
		// Strip OSC escape sequences (e.g. \x1b]0;title\x07)
		.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
		// Strip CSI escape sequences (e.g. \x1b[2J, color codes)
		.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
		// Replace linebreaks and tabs with space
		.replace(/[\r\n\t]/g, " ")
		// Strip unprintable ASCII control characters
		// eslint-disable-next-line no-control-regex
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
		// Collapse multiple spaces
		.replace(/\s+/g, " ")
		.trim();
}

// TypeBox Schema for LLM Tool
export const TodoActionSchema = Type.Union([
	Type.Literal("create"),
	Type.Literal("batch_create"),
	Type.Literal("update"),
	Type.Literal("list"),
	Type.Literal("delete"),
	Type.Literal("clear"),
]);

export const TodoStatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("completed"),
	Type.Literal("cancelled"),
]);

export const BatchTaskItemSchema = Type.Object({
	id: Type.Optional(
		Type.String({
			description: "Optional explicit hierarchical ID (e.g. '1', '1.1'). If omitted, will be auto-generated.",
		}),
	),
	parentId: Type.Optional(
		Type.String({
			description: "Parent task ID if this is a subtask (e.g. '1'). Omit for top-level tasks.",
		}),
	),
	subject: Type.String({
		description: "Brief, clear subject for the task.",
	}),
	description: Type.Optional(
		Type.String({
			description: "Optional detailed requirements or context for the task.",
		}),
	),
	status: Type.Optional(TodoStatusSchema),
});

export const TodoToolParamsSchema = Type.Object({
	action: TodoActionSchema,
	parentId: Type.Optional(
		Type.String({
			description:
				"Parent task ID when creating a subtask (e.g. '1' for child '1.1'). Omit for a top-level task.",
		}),
	),
	id: Type.Optional(
		Type.String({
			description:
				"Target task ID for update, delete, or explicit custom ID on create (e.g. '1.1').",
		}),
	),
	subject: Type.Optional(
		Type.String({
			description: "Task title or summary (required for create).",
		}),
	),
	description: Type.Optional(
		Type.String({
			description: "Optional detailed requirements or notes for the task.",
		}),
	),
	status: Type.Optional(
		TodoStatusSchema,
	),
	tasks: Type.Optional(
		Type.Array(BatchTaskItemSchema, {
			description: "List of tasks to create at once in batch_create.",
		}),
	),
	note: Type.Optional(
		Type.String({
			description: "Optional note or annotation to append to the task.",
		}),
	),
});

export type TodoToolParams = Static<typeof TodoToolParamsSchema>;

// ============================================================================
// 2. Configuration Management
// ============================================================================

export interface TodoTreeConfig {
	enabled: boolean;
	shortcut: string;
}

const DEFAULT_CONFIG: TodoTreeConfig = {
	enabled: false,
	shortcut: "ctrl+shift+t",
};

function getConfigFilePath(): string {
	const configDir = join(homedir(), ".config", "pi-todo-tree");
	return join(configDir, "config.json");
}

function loadConfig(): TodoTreeConfig {
	const filePath = getConfigFilePath();
	if (!existsSync(filePath)) return { ...DEFAULT_CONFIG };
	try {
		const raw = readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		return {
			enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_CONFIG.enabled,
			shortcut: typeof parsed.shortcut === "string" ? parsed.shortcut : DEFAULT_CONFIG.shortcut,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function saveConfig(config: TodoTreeConfig): void {
	const filePath = getConfigFilePath();
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, JSON.stringify(config, null, 2), "utf8");
	} catch (e) {
		console.error("[todo-tree] Failed to save config:", e);
	}
}

// ============================================================================
// 3. State Store (Hierarchical Tree with Dual-Direction Linkage & Explicit Caches)
// ============================================================================

export class TodoTreeStore {
	private tasks = new Map<string, TodoItem>();
	private collapsedNodes = new Set<string>();
	private listeners: Array<() => void> = [];

	// Performance Caching: Explicit null-cleared caches (no dead isDirty boolean)
	private cachedStats: ProgressStats | null = null;
	private cachedFlattenedTree: Array<{ node: TreeNode; hasChildren: boolean }> | null = null;
	private cachedActiveTasks: Array<{ task: TodoItem; breadcrumb: string }> | null = null;

	// Metrics for testing cache hits
	public buildTreeCount = 0;

	subscribe(fn: () => void): () => void {
		this.listeners.push(fn);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== fn);
		};
	}

	private invalidateData(): void {
		this.cachedStats = null;
		this.cachedFlattenedTree = null;
		this.cachedActiveTasks = null;
	}

	private notify(): void {
		this.invalidateData();
		for (const listener of this.listeners) {
			try {
				listener();
			} catch (e) {
				console.error("[todo-tree] listener error:", e);
			}
		}
	}

	getAllTasks(): TodoItem[] {
		return Array.from(this.tasks.values());
	}

	getTask(id: string): TodoItem | undefined {
		return this.tasks.get(id);
	}

	isCollapsed(id: string): boolean {
		return this.collapsedNodes.has(id);
	}

	toggleCollapsed(id: string): void {
		if (this.collapsedNodes.has(id)) {
			this.collapsedNodes.delete(id);
		} else {
			this.collapsedNodes.add(id);
		}
		// Collapsing only affects tree presentation, not tasks or stats
		this.cachedFlattenedTree = null;
		for (const listener of this.listeners) {
			try {
				listener();
			} catch (e) {
				console.error("[todo-tree] listener error:", e);
			}
		}
	}

	loadSnapshot(items: TodoItem[]): void {
		this.tasks.clear();
		this.collapsedNodes.clear();

		const tempMap = new Map<string, TodoItem>();
		for (const item of items) {
			if (item && item.id) {
				tempMap.set(item.id, {
					...item,
					subject: sanitizeText(item.subject),
					description: item.description ? sanitizeText(item.description) : undefined,
					status: item.status ?? "pending",
					notes: Array.isArray(item.notes)
						? item.notes.map((n) => ({ ...n, text: sanitizeText(n.text) }))
						: [],
				});
			}
		}

		// Cycle & depth guard with warning
		for (const [id, item] of tempMap.entries()) {
			if (item.parentId) {
				let currParentId: string | null | undefined = item.parentId;
				let depth = 0;
				const seen = new Set<string>([id]);
				let hasCycle = false;

				while (currParentId) {
					if (seen.has(currParentId)) {
						hasCycle = true;
						break;
					}
					seen.add(currParentId);
					const p = tempMap.get(currParentId);
					currParentId = p?.parentId;
					depth++;
					if (depth > MAX_TREE_DEPTH) {
						hasCycle = true;
						break;
					}
				}

				if (hasCycle || !tempMap.has(item.parentId)) {
					console.warn(
						`[todo-tree] Repaired invalid/cyclical parentId for task "#${id}" (was "${item.parentId}"). Reset to root.`,
					);
					item.parentId = null;
				}
			}
			this.tasks.set(id, item);
		}

		this.notify();
	}

	generateNextId(parentId?: string | null): string {
		if (!parentId) {
			let maxRoot = 0;
			for (const task of this.tasks.values()) {
				if (!task.parentId) {
					const num = parseInt(task.id, 10);
					if (!isNaN(num) && num > maxRoot) {
						maxRoot = num;
					}
				}
			}
			return String(maxRoot + 1);
		}

		let maxChild = 0;
		for (const task of this.tasks.values()) {
			if (task.parentId === parentId) {
				const suffix = task.id.startsWith(parentId + ".")
					? task.id.slice(parentId.length + 1)
					: task.id;
				const num = parseInt(suffix, 10);
				if (!isNaN(num) && num > maxChild) {
					maxChild = num;
				}
			}
		}
		return `${parentId}.${maxChild + 1}`;
	}

	createTask(params: {
		id?: string;
		parentId?: string | null;
		subject: string;
		description?: string;
		status?: TodoStatus;
	}): TodoItem {
		const parentId = params.parentId ?? null;
		if (parentId && !this.tasks.has(parentId)) {
			throw new Error(`Parent task "#${parentId}" not found.`);
		}

		// Depth check
		if (parentId) {
			let depth = 1;
			let curr = this.tasks.get(parentId);
			const visited = new Set<string>([parentId]);
			while (curr?.parentId) {
				depth++;
				if (depth >= MAX_TREE_DEPTH) {
					throw new Error(
						`Task nesting exceeded maximum supported depth (${MAX_TREE_DEPTH}). Cannot add subtask.`,
					);
				}
				if (visited.has(curr.parentId)) break;
				visited.add(curr.parentId);
				curr = this.tasks.get(curr.parentId);
			}
		}

		const id = params.id?.trim() || this.generateNextId(parentId);
		if (this.tasks.has(id)) {
			throw new Error(`Task with ID "#${id}" already exists.`);
		}

		const cleanSubject = sanitizeText(params.subject);
		if (!cleanSubject) {
			throw new Error("Task subject cannot be empty.");
		}

		const now = Date.now();
		const item: TodoItem = {
			id,
			parentId,
			subject: cleanSubject,
			description: params.description ? sanitizeText(params.description) : undefined,
			status: params.status ?? "pending",
			notes: [],
			createdAt: now,
			updatedAt: now,
		};

		this.tasks.set(id, item);
		this.checkParentStatus(parentId);
		this.notify();
		return item;
	}

	batchCreate(tasks: Array<{
		id?: string;
		parentId?: string | null;
		subject: string;
		description?: string;
		status?: TodoStatus;
	}>, replaceExisting = false): TodoItem[] {
		// Validate and apply to an isolated tree. A failed batch must not mutate
		// existing tasks, their parents, or the tree scheduled for auto-clearing.
		const staged = new TodoTreeStore();
		if (!replaceExisting) staged.loadSnapshot(structuredClone(this.getAllTasks()));
		const created = tasks.map(task => staged.createTask(task));
		this.tasks = staged.tasks;
		if (replaceExisting) this.collapsedNodes.clear();
		this.notify();
		return created;
	}

	updateTask(
		id: string,
		patch: {
			subject?: string;
			description?: string;
			status?: TodoStatus;
			note?: string;
		},
	): TodoItem {
		const task = this.tasks.get(id);
		if (!task) {
			throw new Error(`Task "#${id}" not found.`);
		}

		if (
			patch.subject === undefined &&
			patch.description === undefined &&
			patch.status === undefined &&
			patch.note === undefined
		) {
			throw new Error("Update requires at least one mutable field (subject, description, status, or note).");
		}

		if (patch.subject !== undefined) {
			const cleanSub = sanitizeText(patch.subject);
			if (!cleanSub) throw new Error("Task subject cannot be empty.");
			task.subject = cleanSub;
		}
		if (patch.description !== undefined) {
			task.description = sanitizeText(patch.description);
		}

		if (patch.status !== undefined) {
			task.status = patch.status;

			// Cascade to children if cancelled or completed, BUT protect already completed subtasks!
			if (patch.status === "cancelled" || patch.status === "completed") {
				this.cascadeChildrenStatus(id, patch.status);
			}

			// Parent status linkage (dual direction)
			if (task.parentId) {
				this.checkParentStatus(task.parentId);
			}
		}

		if (patch.note && patch.note.trim()) {
			task.notes = task.notes || [];
			task.notes.push({
				id: `note-${Date.now()}`,
				author: "agent",
				text: sanitizeText(patch.note),
				createdAt: Date.now(),
			});
		}

		task.updatedAt = Date.now();
		this.notify();
		return task;
	}

	addUserNote(id: string, text: string): void {
		const task = this.tasks.get(id);
		if (!task) return;
		const clean = sanitizeText(text);
		if (!clean) return;

		task.notes = task.notes || [];
		task.notes.push({
			id: `note-${Date.now()}`,
			author: "user",
			text: clean,
			createdAt: Date.now(),
		});
		task.updatedAt = Date.now();
		this.notify();
	}

	deleteTask(id: string): void {
		const task = this.tasks.get(id);
		if (!task) return;

		const toDelete: string[] = [id];
		const visited = new Set<string>([id]);

		const collectChildren = (parentId: string) => {
			for (const t of this.tasks.values()) {
				if (t.parentId === parentId && !visited.has(t.id)) {
					visited.add(t.id);
					toDelete.push(t.id);
					collectChildren(t.id);
				}
			}
		};
		collectChildren(id);

		for (const delId of toDelete) {
			this.tasks.delete(delId);
			this.collapsedNodes.delete(delId);
		}

		if (task.parentId) {
			this.checkParentStatus(task.parentId);
		}
		this.notify();
	}

	clear(): void {
		this.tasks.clear();
		this.collapsedNodes.clear();
		this.notify();
	}

	private cascadeChildrenStatus(
		parentId: string,
		newStatus: TodoStatus,
		visited = new Set<string>(),
	): void {
		if (visited.has(parentId)) return;
		visited.add(parentId);

		for (const t of this.tasks.values()) {
			if (t.parentId === parentId) {
				// Safety rule: Never overwrite an already completed task with cancelled!
				if (newStatus === "cancelled" && t.status === "completed") {
					continue;
				}
				if (t.status !== newStatus) {
					t.status = newStatus;
					t.updatedAt = Date.now();
					this.cascadeChildrenStatus(t.id, newStatus, visited);
				}
			}
		}
	}

	private checkParentStatus(
		parentId: string | null | undefined,
		visited = new Set<string>(),
	): void {
		if (!parentId) return;
		if (visited.has(parentId)) return;
		visited.add(parentId);

		const parent = this.tasks.get(parentId);
		if (!parent) return;

		const children: TodoItem[] = [];
		for (const t of this.tasks.values()) {
			if (t.parentId === parentId) {
				children.push(t);
			}
		}

		if (children.length === 0) return;

		// Pure state deduction
		const allCancelled = children.every((c) => c.status === "cancelled");
		if (allCancelled) {
			parent.status = "cancelled";
			parent.updatedAt = Date.now();
		} else {
			const activeChildren = children.filter((c) => c.status !== "cancelled");
			const allCompleted =
				activeChildren.length > 0 &&
				activeChildren.every((c) => c.status === "completed");
			const anyInProgress = activeChildren.some((c) => c.status === "in_progress");
			const anyCompleted = activeChildren.some((c) => c.status === "completed");
			const allPending = activeChildren.every((c) => c.status === "pending");

			if (allCompleted) {
				parent.status = "completed";
			} else if (anyInProgress || anyCompleted) {
				parent.status = "in_progress";
			} else if (allPending) {
				parent.status = "pending";
			}
			parent.updatedAt = Date.now();
		}

		if (parent.parentId) {
			this.checkParentStatus(parent.parentId, visited);
		}
	}

	buildTree(): TreeNode[] {
		this.buildTreeCount++;
		const rootItems: TodoItem[] = [];
		const childMap = new Map<string, TodoItem[]>();

		for (const task of this.tasks.values()) {
			if (!task.parentId) {
				rootItems.push(task);
			} else {
				const list = childMap.get(task.parentId) || [];
				list.push(task);
				childMap.set(task.parentId, list);
			}
		}

		const sortFn = (a: TodoItem, b: TodoItem) =>
			a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" });

		rootItems.sort(sortFn);
		for (const list of childMap.values()) {
			list.sort(sortFn);
		}

		const visited = new Set<string>();

		const buildNode = (
			item: TodoItem,
			depth: number,
			isLastChild: boolean,
			ancestorHasNextSibling: boolean[],
		): TreeNode => {
			visited.add(item.id);
			const rawChildren = childMap.get(item.id) || [];
			const childrenItems = rawChildren.filter((c) => !visited.has(c.id));
			const childrenNodes: TreeNode[] = [];
			let isDepthCapped = false;

			if (depth < MAX_TREE_DEPTH) {
				for (let i = 0; i < childrenItems.length; i++) {
					const isLast = i === childrenItems.length - 1;
					const nextAncestors = [...ancestorHasNextSibling, !isLast];
					childrenNodes.push(buildNode(childrenItems[i], depth + 1, isLast, nextAncestors));
				}
			} else if (childrenItems.length > 0) {
				isDepthCapped = true;
			}

			return {
				item,
				children: childrenNodes,
				depth,
				isLastChild,
				ancestorHasNextSibling,
				isDepthCapped,
			};
		};

		return rootItems.map((item, idx) =>
			buildNode(item, 0, idx === rootItems.length - 1, []),
		);
	}

	getFlattenedTree(): Array<{ node: TreeNode; hasChildren: boolean }> {
		if (this.cachedFlattenedTree !== null) {
			return this.cachedFlattenedTree;
		}

		const result: Array<{ node: TreeNode; hasChildren: boolean }> = [];
		const tree = this.buildTree();

		const traverse = (node: TreeNode) => {
			const hasChildren = node.children.length > 0;
			result.push({ node, hasChildren });
			if (hasChildren && !this.isCollapsed(node.item.id)) {
				for (const child of node.children) {
					traverse(child);
				}
			}
		};

		for (const root of tree) {
			traverse(root);
		}

		this.cachedFlattenedTree = result;
		return result;
	}

	getActiveInProgressTasks(): Array<{ task: TodoItem; breadcrumb: string }> {
		if (this.cachedActiveTasks !== null) {
			return this.cachedActiveTasks;
		}

		const result: Array<{ task: TodoItem; breadcrumb: string }> = [];
		const parentIds = new Set<string>();
		for (const t of this.tasks.values()) {
			if (t.parentId) parentIds.add(t.parentId);
		}

		for (const task of this.tasks.values()) {
			if (task.status === "in_progress") {
				const hasChildren = parentIds.has(task.id);
				let hasActiveChild = false;
				if (hasChildren) {
					for (const child of this.tasks.values()) {
						if (child.parentId === task.id && child.status === "in_progress") {
							hasActiveChild = true;
							break;
						}
					}
				}
				if (hasActiveChild) {
					continue;
				}

				const path: string[] = [];
				const visited = new Set<string>([task.id]);
				let curr: TodoItem | undefined = task;
				let depth = 0;

				while (curr?.parentId && depth < MAX_TREE_DEPTH) {
					if (visited.has(curr.parentId)) break;
					visited.add(curr.parentId);
					curr = this.tasks.get(curr.parentId);
					if (curr) path.unshift(curr.subject);
					depth++;
				}

				const breadcrumb = path.length > 0 ? `[${path.join(" > ")}] ` : "";
				result.push({ task, breadcrumb });
			}
		}

		result.sort((a, b) =>
			a.task.id.localeCompare(b.task.id, undefined, { numeric: true }),
		);

		this.cachedActiveTasks = result;
		return result;
	}

	getProgressStats(): ProgressStats {
		if (this.cachedStats !== null) {
			return this.cachedStats;
		}

		let total = 0;
		let completed = 0;
		let inProgress = 0;
		let pending = 0;
		let cancelled = 0;

		const parentIds = new Set<string>();
		for (const t of this.tasks.values()) {
			if (t.parentId) parentIds.add(t.parentId);
		}

		for (const t of this.tasks.values()) {
			const isLeaf = !parentIds.has(t.id);
			if (isLeaf) {
				if (t.status === "completed") completed++;
				else if (t.status === "in_progress") inProgress++;
				else if (t.status === "pending") pending++;
				else if (t.status === "cancelled") cancelled++;
				total++;
			}
		}

		const activeTotal = total - cancelled;
		const percent = activeTotal > 0 ? Math.round((completed / activeTotal) * 100) : 0;

		const stats: ProgressStats = {
			total: activeTotal,
			completed,
			inProgress,
			pending,
			cancelled,
			percent,
		};

		this.cachedStats = stats;
		return stats;
	}
}

// ============================================================================
// 4. UI Rendering Helpers & Formatting
// ============================================================================

function renderProgressBar(percent: number, width: number): string {
	const safeWidth = Math.max(4, width);
	const filled = Math.min(safeWidth, Math.max(0, Math.round((percent / 100) * safeWidth)));
	const empty = safeWidth - filled;
	return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

function wrapWithPrefix(
	text: string,
	maxWidth: number,
	firstPrefix: string,
	restPrefix: string,
): string[] {
	if (maxWidth <= 4) return [truncateToWidth(`${firstPrefix}${text}`, Math.max(1, maxWidth))];
	const firstW = visibleWidth(firstPrefix);
	const restW = visibleWidth(restPrefix);
	const lines: string[] = [];
	const rawParagraphs = text.split(/\r?\n/);

	for (let pIdx = 0; pIdx < rawParagraphs.length; pIdx++) {
		const raw = rawParagraphs[pIdx];
		let remaining = raw;
		let isFirstLineOfBlock = lines.length === 0;

		if (!remaining) {
			lines.push(isFirstLineOfBlock ? firstPrefix.trimEnd() : restPrefix.trimEnd());
			continue;
		}

		while (remaining.length > 0) {
			const currentPrefix = isFirstLineOfBlock ? firstPrefix : restPrefix;
			const currentPrefixW = isFirstLineOfBlock ? firstW : restW;
			const maxContentW = Math.max(8, maxWidth - currentPrefixW);

			if (visibleWidth(remaining) <= maxContentW) {
				lines.push(`${currentPrefix}${remaining}`);
				break;
			}

			let take = maxContentW;
			let chunk = sliceByColumn(remaining, 0, take);
			while (visibleWidth(chunk) > maxContentW && take > 1) {
				take--;
				chunk = sliceByColumn(remaining, 0, take);
			}

			lines.push(`${currentPrefix}${chunk}`);
			remaining = remaining.slice(chunk.length).trimStart();
			isFirstLineOfBlock = false;
		}
	}
	return lines;
}

function getStatusGlyph(status: TodoStatus): { glyph: string; colorKey: string } {
	switch (status) {
		case "completed":
			return { glyph: "✓", colorKey: "success" };
		case "in_progress":
			return { glyph: "⏳", colorKey: "accent" };
		case "cancelled":
			return { glyph: "✗", colorKey: "error" };
		case "pending":
		default:
			return { glyph: "○", colorKey: "text" };
	}
}

// ============================================================================
// 5. Main Screen Above-Editor Widget Component (Strict Width Guarantee)
// ============================================================================

export class TodoTreeWidgetComponent implements Component {
	private tui: any;
	private theme: any;
	private store: TodoTreeStore;
	private onOpenModal: () => void;
	private unsubscribeStore: () => void;
	private cachedLines: string[] | null = null;
	private cachedWidth = 0;

	constructor(tui: any, theme: any, store: TodoTreeStore, onOpenModal: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.store = store;
		this.onOpenModal = onOpenModal;

		this.unsubscribeStore = this.store.subscribe(() => {
			this.invalidate();
			this.tui?.requestRender?.();
		});
	}

	updateTuiAndTheme(tui: any, theme: any): void {
		this.tui = tui;
		this.theme = theme;
	}

	dispose(): void {
		this.unsubscribeStore();
	}

	invalidate(): void {
		this.cachedLines = null;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const tasks = this.store.getAllTasks();
		if (tasks.length === 0 || width < 10) {
			this.cachedLines = [];
			this.cachedWidth = width;
			return [];
		}

		const stats = this.store.getProgressStats();
		const activeItems = this.store.getActiveInProgressTasks();
		const lines: string[] = [];

		const buttonText = "[📋 ]";
		const buttonWidth = visibleWidth(buttonText);

		const hasActive = activeItems.length > 0;
		const dotChar = hasActive
			? "●"
			: stats.completed === stats.total && stats.total > 0
				? "✓"
				: "○";
		const dotColor = hasActive
			? "accent"
			: stats.completed === stats.total && stats.total > 0
				? "success"
				: "muted";
		const dotGlyph = this.theme.fg(dotColor, dotChar);

		// Dynamic adaptive prefix for narrow terminals
		let prefixText = ` ${dotChar} Todos [${stats.completed}/${stats.total} · ${stats.percent}%] ${renderProgressBar(stats.percent, 6)} `;
		let prefixStyled = ` ${dotGlyph} ${this.theme.fg("accent", `Todos [${stats.completed}/${stats.total} · ${stats.percent}%]`)} ${this.theme.fg("accent", renderProgressBar(stats.percent, 6))} `;

		// If viewport is too narrow, shrink prefix progressively
		if (visibleWidth(prefixText) + buttonWidth + 8 > width) {
			prefixText = ` ${dotChar} [${stats.completed}/${stats.total} · ${stats.percent}%] `;
			prefixStyled = ` ${dotGlyph} ${this.theme.fg("accent", `[${stats.completed}/${stats.total} · ${stats.percent}%]`)} `;
		}
		if (visibleWidth(prefixText) + buttonWidth + 4 > width) {
			prefixText = ` ${dotChar} [${stats.completed}/${stats.total}] `;
			prefixStyled = ` ${dotGlyph} ${this.theme.fg("accent", `[${stats.completed}/${stats.total}]`)} `;
		}

		const prefixLen = visibleWidth(prefixText);
		const availableForSubject = width - prefixLen - buttonWidth;

		if (hasActive) {
			if (activeItems.length === 1) {
				// Single active task: clean display without breadcrumbs
				const first = activeItems[0];
				const firstLabel = `#${first.task.id} ${first.task.subject}`;

				if (availableForSubject >= 4) {
					const truncatedSubject = truncateToWidth(firstLabel, availableForSubject - 1);
					const middleLen = visibleWidth(truncatedSubject);
					const padLen = Math.max(1, width - prefixLen - middleLen - buttonWidth);
					const btnStyled = this.theme.fg("accent", buttonText);
					const subjectStyled = this.theme.style(truncatedSubject, { bold: true });

					lines.push(`${prefixStyled}${subjectStyled}${" ".repeat(padLen)}${btnStyled}`);
				} else {
					// Extremely narrow: omit subject, show just progress and button
					const padLen = Math.max(0, width - prefixLen - buttonWidth);
					const btnStyled = this.theme.fg("accent", buttonText);
					lines.push(`${prefixStyled}${" ".repeat(padLen)}${btnStyled}`);
				}
			} else {
				// Multi-task in progress: line 1 is clean summary header, all active tasks displayed below
				const countLabel = `(${activeItems.length} in progress)`;
				const showCount = availableForSubject >= visibleWidth(countLabel) + 2;
				const middleText = showCount ? countLabel : "";
				const middleStyled = showCount ? this.theme.fg("accent", middleText) : "";
				const middleLen = showCount ? visibleWidth(middleText) : 0;
				const padLen = Math.max(1, width - prefixLen - middleLen - buttonWidth);
				const btnStyled = this.theme.fg("accent", buttonText);

				lines.push(`${prefixStyled}${middleStyled}${" ".repeat(padLen)}${btnStyled}`);

				// Display ALL parallel in-progress tasks uniformly below line 1 without breadcrumbs
				for (const item of activeItems) {
					const glyph = "  ⏳ ";
					const glyphStyled = this.theme.fg("accent", glyph);
					const glyphWidth = visibleWidth(glyph);
					const availableSub = Math.max(0, width - glyphWidth);

					if (availableSub > 2) {
						const label = `#${item.task.id} ${item.task.subject}`;
						const trunc = truncateToWidth(label, availableSub);
						lines.push(`${glyphStyled}${this.theme.fg("text", trunc)}`);
					}
				}
			}
		} else {
			const statusMsg =
				stats.completed === stats.total && stats.total > 0
					? "All completed"
					: `${stats.pending} pending`;

			if (availableForSubject >= 4) {
				const truncatedMsg = truncateToWidth(statusMsg, availableForSubject - 1);
				const middleLen = visibleWidth(truncatedMsg);
				const padLen = Math.max(1, width - prefixLen - middleLen - buttonWidth);
				const btnStyled = this.theme.fg("accent", buttonText);
				const msgStyled = this.theme.fg("muted", truncatedMsg);

				lines.push(`${prefixStyled}${msgStyled}${" ".repeat(padLen)}${btnStyled}`);
			} else {
				const padLen = Math.max(0, width - prefixLen - buttonWidth);
				const btnStyled = this.theme.fg("accent", buttonText);
				lines.push(`${prefixStyled}${" ".repeat(padLen)}${btnStyled}`);
			}
		}

		// Enforce absolute strict width guarantee: No line shall ever exceed width!
		const boundedLines = lines.map((l) => truncateToWidth(l, width));

		this.cachedLines = boundedLines;
		this.cachedWidth = width;
		return boundedLines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "click" && event.button === "left") {
			const width = this.cachedWidth || 80;
			const buttonWidth = visibleWidth("[📋 ]");
			// Accurate hit test: Only click on the right button area triggers modal!
			if (event.y === 0 && event.x >= width - buttonWidth - 2 && event.x <= width) {
				this.onOpenModal();
				return { handled: true };
			}
		}
		return undefined;
	}
}

// ============================================================================
// 6. Full Interactive Overlay Modal Component
// ============================================================================

export class TodoTreeOverlayComponent implements Component {
	private tui: any;
	private theme: any;
	private store: TodoTreeStore;
	private onClose: () => void;
	private onPromptUserNote?: (taskId: string) => void;
	private onPersist?: () => void;
	private unsubscribeStore?: () => void;

	private selectedIndex = 0;
	private scrollTop = 0;
	private detailScrollTop = 0;
	private lastSelectedTaskId: string | null = null;

	// Bounding box geometry
	private boxLeft = 0;
	private boxTop = 0;
	private boxWidth = 0;
	private boxHeight = 0;
	private listHeight = 10;
	private detailHeight = 5;
	private totalDetailLines = 0;

	constructor(
		tui: any,
		theme: any,
		store: TodoTreeStore,
		onClose: () => void,
		onPromptUserNote?: (taskId: string) => void,
		onPersist?: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.store = store;
		this.onClose = onClose;
		this.onPromptUserNote = onPromptUserNote;
		this.onPersist = onPersist;

		this.unsubscribeStore = this.store.subscribe(() => {
			this.tui?.requestRender?.();
		});

		const flat = this.store.getFlattenedTree();
		const inProgIdx = flat.findIndex((f) => f.node.item.status === "in_progress");
		if (inProgIdx >= 0) {
			this.selectedIndex = inProgIdx;
		}
	}

	private close(): void {
		this.unsubscribeStore?.();
		this.onClose();
	}

	invalidate(): void {
		// Stateless render pass
	}

	render(width: number): string[] {
		const totalLines = this.tui?.terminal?.rows || 24;

		this.boxWidth = Math.min(100, Math.max(50, Math.floor(width * 0.88)));
		this.boxHeight = Math.min(36, Math.max(16, Math.floor(totalLines * 0.86)));
		this.boxLeft = Math.max(0, Math.floor((width - this.boxWidth) / 2));
		this.boxTop = Math.max(0, Math.floor((totalLines - this.boxHeight) / 2));

		const flat = this.store.getFlattenedTree();
		const stats = this.store.getProgressStats();

		// Bottom fixed rows: TopBorder(1) + Stats(1) + Divider(1) + [TreeList] + Divider(1) + [Detail(6)] + Actions(1) + BottomBorder(1) = 12 fixed
		this.detailHeight = 6;
		this.listHeight = Math.max(4, this.boxHeight - 12);

		if (this.selectedIndex >= flat.length) this.selectedIndex = Math.max(0, flat.length - 1);
		if (this.selectedIndex < 0) this.selectedIndex = 0;

		if (this.selectedIndex < this.scrollTop) {
			this.scrollTop = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollTop + this.listHeight) {
			this.scrollTop = this.selectedIndex - this.listHeight + 1;
		}

		const maxScroll = Math.max(0, flat.length - this.listHeight);
		if (this.scrollTop > maxScroll) this.scrollTop = maxScroll;

		const lines: string[] = [];
		const innerWidth = this.boxWidth - 2;

		// Top padding to vertically center the box on terminal canvas
		for (let i = 0; i < this.boxTop; i++) {
			lines.push("");
		}

		// 1. Top border
		const titleStr = " 📋 Todo Tree ";
		const hintStr = " [Esc/q: Close · ↑/↓: Move] ";
		const topBorderDash = Math.max(
			2,
			innerWidth - visibleWidth(titleStr) - visibleWidth(hintStr) - 2,
		);
		const topBorder =
			this.theme.fg("accent", "┌─") +
			this.theme.style(titleStr, { bold: true, fg: "accent" }) +
			this.theme.fg("accent", "─".repeat(topBorderDash)) +
			this.theme.fg("muted", hintStr) +
			this.theme.fg("accent", "─┐");

		lines.push(`${" ".repeat(this.boxLeft)}${topBorder}`);

		// 2. Stats line with responsive fallback
		const statsBar = `${renderProgressBar(stats.percent, 10)} `;
		let statsText = `Progress: ${stats.completed}/${stats.total} (${stats.percent}%) · ${stats.inProgress} active · ${stats.pending} pending`;
		if (stats.cancelled > 0) {
			statsText += ` · ${stats.cancelled} cancelled`;
		}

		const statContentAvailable = Math.max(4, innerWidth - visibleWidth(statsBar) - 2);
		const truncStatsText = truncateToWidth(statsText, statContentAvailable);
		const statPad = Math.max(0, innerWidth - 2 - visibleWidth(truncStatsText) - visibleWidth(statsBar));
		const statLine =
			this.theme.fg("accent", "│ ") +
			this.theme.fg("text", truncStatsText) +
			" ".repeat(statPad) +
			this.theme.fg("accent", statsBar) +
			this.theme.fg("accent", "│");
		lines.push(`${" ".repeat(this.boxLeft)}${statLine}`);

		// 3. Divider
		lines.push(`${" ".repeat(this.boxLeft)}${this.theme.fg("accent", "├" + "─".repeat(innerWidth) + "┤")}`);

		// 4. Tree list rows
		const visibleRows = flat.slice(this.scrollTop, this.scrollTop + this.listHeight);
		const scrollbarActive = flat.length > this.listHeight;

		const thumbHeight = scrollbarActive
			? Math.max(1, Math.round((this.listHeight / flat.length) * this.listHeight))
			: 0;
		const thumbTop = scrollbarActive && maxScroll > 0
			? Math.round((this.scrollTop / maxScroll) * (this.listHeight - thumbHeight))
			: 0;

		const rowInteriorWidth = innerWidth - (scrollbarActive ? 1 : 0);

		for (let row = 0; row < this.listHeight; row++) {
			let lineContent = "";

			if (row < visibleRows.length) {
				const itemIdx = this.scrollTop + row;
				const isSelected = itemIdx === this.selectedIndex;
				const { node, hasChildren } = visibleRows[row];
				const item = node.item;

				let treePrefix = "";
				for (let d = 0; d < node.depth; d++) {
					treePrefix += node.ancestorHasNextSibling[d] ? "│  " : "   ";
				}
				treePrefix += node.depth === 0 ? "" : node.isLastChild ? "└─ " : "├─ ";

				const foldIcon = hasChildren
					? this.store.isCollapsed(item.id)
						? "▶ "
						: "▼ "
					: "  ";

				const { glyph, colorKey } = getStatusGlyph(item.status);
				const glyphStyled = this.theme.fg(colorKey, glyph);

				const noteBadge =
					item.notes && item.notes.length > 0
						? this.theme.fg("warning", ` 💬(${item.notes.length})`)
						: "";
				const noteBadgeWidth = visibleWidth(noteBadge);

				const depthCapWarning = node.isDepthCapped
					? this.theme.fg("warning", " ⚠[depth limit 32 reached]")
					: "";
				const depthCapWidth = visibleWidth(depthCapWarning);

				const idStr = `#${item.id} `;
				const pointerPrefix = isSelected ? "> " : "  ";

				const fixedWidth =
					visibleWidth(pointerPrefix) +
					visibleWidth(treePrefix) +
					visibleWidth(foldIcon) +
					visibleWidth(glyph) +
					1 +
					visibleWidth(idStr) +
					noteBadgeWidth +
					depthCapWidth;

				const availableSubjectWidth = Math.max(4, rowInteriorWidth - fixedWidth - 1);
				const truncatedSubject = truncateToWidth(item.subject, availableSubjectWidth);

				let styledSubject = "";
				if (item.status === "completed" || item.status === "cancelled") {
					styledSubject = this.theme.fg("muted", truncatedSubject);
				} else if (item.status === "in_progress") {
					styledSubject = this.theme.style(truncatedSubject, { bold: true, fg: "text" });
				} else {
					styledSubject = this.theme.fg("text", truncatedSubject);
				}

				const pointerStyled = isSelected
					? this.theme.style(pointerPrefix, { bold: true, fg: "accent" })
					: pointerPrefix;

				const styledLine =
					pointerStyled +
					this.theme.fg("muted", treePrefix) +
					this.theme.fg("accent", foldIcon) +
					glyphStyled +
					" " +
					this.theme.fg("accent", idStr) +
					styledSubject +
					noteBadge +
					depthCapWarning;

				const actualVisible =
					fixedWidth + visibleWidth(truncatedSubject);
				const rowPad = Math.max(0, rowInteriorWidth - actualVisible);
				lineContent = styledLine + " ".repeat(rowPad);
			} else {
				lineContent = " ".repeat(rowInteriorWidth);
			}

			let scrollbarChar = "";
			if (scrollbarActive) {
				if (row >= thumbTop && row < thumbTop + thumbHeight) {
					scrollbarChar = this.theme.fg("accent", "█");
				} else {
					scrollbarChar = this.theme.fg("scrollbarTrack", "│");
				}
			}

			const line = `${this.theme.fg("accent", "│")}${lineContent}${scrollbarChar}${this.theme.fg("accent", "│")}`;
			lines.push(`${" ".repeat(this.boxLeft)}${line}`);
		}

		// 5. Divider
		lines.push(`${" ".repeat(this.boxLeft)}${this.theme.fg("accent", "├" + "─".repeat(innerWidth) + "┤")}`);

		// 6. Selected task details & notes pane (up to 6 lines with scrollbar support)
		const selectedTask = flat[this.selectedIndex]?.node.item;
		if (selectedTask?.id !== this.lastSelectedTaskId) {
			this.lastSelectedTaskId = selectedTask ? selectedTask.id : null;
			this.detailScrollTop = 0;
		}

		const detailContentLines: Array<{ text: string; colorKey?: string; bold?: boolean }> = [];
		const maxContentWidth = Math.max(16, innerWidth - 4);

		if (selectedTask) {
			const { glyph, colorKey: statusColor } = getStatusGlyph(selectedTask.status);
			const titleStr = `#${selectedTask.id} ${selectedTask.subject} [${selectedTask.status.toUpperCase()}] ${glyph}`;
			detailContentLines.push({
				text: truncateToWidth(`ℹ ${titleStr}`, maxContentWidth),
				colorKey: "accent",
				bold: true,
			});

			if (selectedTask.description && selectedTask.description.trim()) {
				const descLines = wrapWithPrefix(
					selectedTask.description.trim(),
					maxContentWidth,
					"  Desc : ",
					"         ",
				);
				for (const dLine of descLines) {
					detailContentLines.push({ text: dLine, colorKey: "text" });
				}
			}

			const notes = selectedTask.notes || [];
			if (notes.length > 0) {
				detailContentLines.push({ text: `💬 Notes (${notes.length}):`, colorKey: "warning", bold: true });
				for (const note of notes) {
					const authorTag = note.author === "agent" ? "[Agent]" : "[User]";
					const firstPfx = `  • ${authorTag}: `;
					const restPfx = " ".repeat(visibleWidth(firstPfx));
					const noteLines = wrapWithPrefix(note.text, maxContentWidth, firstPfx, restPfx);
					for (const nLine of noteLines) {
						detailContentLines.push({
							text: nLine,
							colorKey: note.author === "agent" ? "accent" : "text",
						});
					}
				}
			} else {
				detailContentLines.push({ text: "💬 Notes (0): (Press [n] to add note)", colorKey: "muted" });
			}
		} else {
			detailContentLines.push({ text: "No task selected", colorKey: "muted" });
		}

		this.totalDetailLines = detailContentLines.length;
		const maxDetailScroll = Math.max(0, this.totalDetailLines - this.detailHeight);
		if (this.detailScrollTop > maxDetailScroll) this.detailScrollTop = maxDetailScroll;
		if (this.detailScrollTop < 0) this.detailScrollTop = 0;

		const detailScrollbarActive = this.totalDetailLines > this.detailHeight;
		const detailThumbHeight = detailScrollbarActive
			? Math.max(1, Math.round((this.detailHeight / this.totalDetailLines) * this.detailHeight))
			: 0;
		const detailThumbTop = detailScrollbarActive && maxDetailScroll > 0
			? Math.round((this.detailScrollTop / maxDetailScroll) * (this.detailHeight - detailThumbHeight))
			: 0;

		const detailInteriorWidth = innerWidth - (detailScrollbarActive ? 1 : 0);

		for (let row = 0; row < this.detailHeight; row++) {
			const lineIdx = this.detailScrollTop + row;
			let rowStr = "";
			if (lineIdx < detailContentLines.length) {
				const item = detailContentLines[lineIdx];
				const trunc = truncateToWidth(item.text, detailInteriorWidth - 2);
				let styled = this.theme.fg(item.colorKey || "text", trunc);
				if (item.bold) {
					styled = this.theme.style(trunc, { bold: true, fg: item.colorKey || "text" });
				}
				const pad = Math.max(0, detailInteriorWidth - 2 - visibleWidth(trunc));
				rowStr = ` ${styled}${" ".repeat(pad)} `;
			} else {
				rowStr = " ".repeat(detailInteriorWidth);
			}

			let scrollChar = "";
			if (detailScrollbarActive) {
				if (row >= detailThumbTop && row < detailThumbTop + detailThumbHeight) {
					scrollChar = this.theme.fg("accent", "█");
				} else {
					scrollChar = this.theme.fg("scrollbarTrack", "│");
				}
			}

			lines.push(`${" ".repeat(this.boxLeft)}${this.theme.fg("accent", "│")}${rowStr}${scrollChar}${this.theme.fg("accent", "│")}`);
		}

		// 7. Actions row
		const scrollHint = detailScrollbarActive && innerWidth >= 70 ? "  [PgUp/PgDn] Scroll" : "";
		const actions = `[Space] Fold  [n] Note  [c] Done  [x] Cancel${scrollHint}  [Esc] Close`;
		const actTrunc = truncateToWidth(actions, innerWidth - 2);
		const actPad = Math.max(0, innerWidth - 2 - visibleWidth(actTrunc));
		lines.push(
			`${" ".repeat(this.boxLeft)}${this.theme.fg("accent", "│ ")}${this.theme.fg("accent", actTrunc)}${" ".repeat(actPad)} ${this.theme.fg("accent", "│")}`,
		);

		// 8. Bottom border
		lines.push(`${" ".repeat(this.boxLeft)}${this.theme.fg("accent", "└" + "─".repeat(innerWidth) + "┘")}`);

		// Bottom padding
		const totalRendered = this.boxTop + this.boxHeight;
		for (let i = totalRendered; i < totalLines; i++) {
			lines.push("");
		}

		return lines;
	}

	handleInput(data: string): void {
		const flat = this.store.getFlattenedTree();

		if (
			matchesKey(data, Key.escape) ||
			data === "\x1b" ||
			data === "escape" ||
			data === "q" ||
			data === "Q" ||
			matchesKey(data, Key.enter) ||
			data === "\r" ||
			data === "\n" ||
			data === "enter"
		) {
			this.close();
			return;
		}

		if (matchesKey(data, Key.up) || data === "up" || data === "k") {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.detailScrollTop = 0;
				this.tui?.requestRender?.();
			}
			return;
		}

		if (matchesKey(data, Key.down) || data === "down" || data === "j") {
			if (this.selectedIndex < flat.length - 1) {
				this.selectedIndex++;
				this.detailScrollTop = 0;
				this.tui?.requestRender?.();
			}
			return;
		}

		if (matchesKey(data, Key.pageUp) || data === "pageup") {
			if (this.detailScrollTop > 0) {
				this.detailScrollTop = Math.max(0, this.detailScrollTop - 2);
			} else {
				this.selectedIndex = Math.max(0, this.selectedIndex - this.listHeight);
			}
			this.tui?.requestRender?.();
			return;
		}

		if (matchesKey(data, Key.pageDown) || data === "pagedown") {
			const maxDetail = Math.max(0, this.totalDetailLines - this.detailHeight);
			if (this.detailScrollTop < maxDetail) {
				this.detailScrollTop = Math.min(maxDetail, this.detailScrollTop + 2);
			} else {
				this.selectedIndex = Math.min(flat.length - 1, this.selectedIndex + this.listHeight);
			}
			this.tui?.requestRender?.();
			return;
		}

		if (matchesKey(data, Key.home) || data === "home") {
			this.selectedIndex = 0;
			this.tui?.requestRender?.();
			return;
		}

		if (matchesKey(data, Key.end) || data === "end") {
			this.selectedIndex = Math.max(0, flat.length - 1);
			this.tui?.requestRender?.();
			return;
		}

		if (matchesKey(data, Key.space) || data === "space" || data === " ") {
			const current = flat[this.selectedIndex];
			if (current && current.hasChildren) {
				this.store.toggleCollapsed(current.node.item.id);
			}
			return;
		}

		if (data === "c" || data === "C") {
			const current = flat[this.selectedIndex];
			if (current) {
				const nextStatus: TodoStatus =
					current.node.item.status === "completed" ? "pending" : "completed";
				this.store.updateTask(current.node.item.id, { status: nextStatus });
				// Critical fix: persist snapshot immediately on modal status change!
				this.onPersist?.();
			}
			return;
		}

		if (data === "x" || data === "X") {
			const current = flat[this.selectedIndex];
			if (current) {
				const nextStatus: TodoStatus =
					current.node.item.status === "cancelled" ? "pending" : "cancelled";
				this.store.updateTask(current.node.item.id, { status: nextStatus });
				// Critical fix: persist snapshot immediately on modal status change!
				this.onPersist?.();
			}
			return;
		}

		if (data === "n" || data === "N") {
			const current = flat[this.selectedIndex];
			if (current && this.onPromptUserNote) {
				this.onPromptUserNote(current.node.item.id);
			}
			return;
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "click") {
			const isInside =
				event.x >= this.boxLeft &&
				event.x < this.boxLeft + this.boxWidth &&
				event.y >= this.boxTop &&
				event.y < this.boxTop + this.boxHeight;

			if (!isInside) {
				this.close();
				return { handled: true };
			}

			const boxY = event.y - this.boxTop;

			// Top border right hint: click close
			if (boxY === 0 && event.x >= this.boxLeft + this.boxWidth - 28) {
				this.close();
				return { handled: true };
			}

			// Tree list row click
			const listRelativeY = boxY - 3;
			if (listRelativeY >= 0 && listRelativeY < this.listHeight) {
				const targetIndex = this.scrollTop + listRelativeY;
				const flat = this.store.getFlattenedTree();
				if (targetIndex < flat.length) {
					const wasSelected = this.selectedIndex === targetIndex;
					this.selectedIndex = targetIndex;
					this.detailScrollTop = 0;
					const itemEntry = flat[targetIndex];
					const { node, hasChildren } = itemEntry;

					if (hasChildren) {
						let prefixWidth = 0;
						for (let d = 0; d < node.depth; d++) {
							prefixWidth += 3;
						}
						if (node.depth > 0) {
							prefixWidth += 3; // "├─ " or "└─ "
						}

						// Fold icon column range on screen:
						const foldColStart = this.boxLeft + 1 + 2 + prefixWidth;
						const foldColEnd = foldColStart + 2;

						// Clicking on or near the fold icon ▶/▼ (or clicking an already selected row) toggles fold!
						if (
							(event.x >= this.boxLeft + 1 && event.x <= foldColEnd + 2) ||
							wasSelected
						) {
							this.store.toggleCollapsed(node.item.id);
						}
					}

					this.tui?.requestRender?.();
					return { handled: true };
				}
			}

			// Details pane row click: clicking inside details area triggers note prompt if clicking notes header
			const detailRelativeY = boxY - (3 + this.listHeight + 1);
			if (detailRelativeY >= 0 && detailRelativeY < this.detailHeight) {
				const flat = this.store.getFlattenedTree();
				const current = flat[this.selectedIndex];
				// If user clicks on details area
				this.tui?.requestRender?.();
				return { handled: true };
			}

			// Actions row click: [Space] Fold  [n] Note  [c] Done  [x] Cancel  [Esc] Close
			if (boxY === 3 + this.listHeight + 1 + this.detailHeight) {
				const flat = this.store.getFlattenedTree();
				const current = flat[this.selectedIndex];
				const relX = event.x - this.boxLeft;
				if (relX >= 2 && relX <= 16) {
					// [Space] Fold
					if (current && current.hasChildren) {
						this.store.toggleCollapsed(current.node.item.id);
					}
				} else if (relX >= 17 && relX <= 26) {
					// [n] Note
					if (current && this.onPromptUserNote) {
						this.onPromptUserNote(current.node.item.id);
					}
				} else if (relX >= 27 && relX <= 36) {
					// [c] Done
					if (current) {
						const nextStatus = current.node.item.status === "completed" ? "pending" : "completed";
						this.store.updateTask(current.node.item.id, { status: nextStatus });
						this.onPersist?.();
					}
				} else if (relX >= 37 && relX <= 48) {
					// [x] Cancel
					if (current) {
						const nextStatus = current.node.item.status === "cancelled" ? "pending" : "cancelled";
						this.store.updateTask(current.node.item.id, { status: nextStatus });
						this.onPersist?.();
					}
				} else if (relX >= 49) {
					// [Esc] Close
					this.close();
				}
				this.tui?.requestRender?.();
				return { handled: true };
			}
		}

		if (event.type === "wheel") {
			const delta = event.wheelDelta ?? (event as any).deltaY ?? 0;
			const boxY = event.y - this.boxTop;

			// If mouse is over details pane: scroll details!
			const detailStart = 3 + this.listHeight + 1;
			if (boxY >= detailStart && boxY < detailStart + this.detailHeight) {
				const maxDetail = Math.max(0, this.totalDetailLines - this.detailHeight);
				if (delta > 0) {
					this.detailScrollTop = Math.min(maxDetail, this.detailScrollTop + 1);
				} else if (delta < 0) {
					this.detailScrollTop = Math.max(0, this.detailScrollTop - 1);
				}
				this.tui?.requestRender?.();
				return { handled: true };
			}

			// Otherwise: scroll tree list
			const flat = this.store.getFlattenedTree();
			const maxScroll = Math.max(0, flat.length - this.listHeight);

			if (delta > 0) {
				this.scrollTop = Math.min(maxScroll, this.scrollTop + 2);
				this.selectedIndex = Math.min(flat.length - 1, this.selectedIndex + 2);
				this.detailScrollTop = 0;
			} else if (delta < 0) {
				this.scrollTop = Math.max(0, this.scrollTop - 2);
				this.selectedIndex = Math.max(0, this.selectedIndex - 2);
				this.detailScrollTop = 0;
			}
			this.tui?.requestRender?.();
			return { handled: true };
		}

		return undefined;
	}
}

// ============================================================================
// 6.5. Lightweight Status Modal Dialog Component
// ============================================================================

export interface TodoTreeStatusInfo {
	enabled: boolean;
	isToolActive: boolean;
	shortcut: string;
	stats: {
		total: number;
		completed: number;
		inProgress: number;
		pending: number;
		cancelled: number;
		percent: number;
	};
}

export class TodoTreeStatusModalComponent implements Component {
	private tui: any;
	private theme: any;
	private info: TodoTreeStatusInfo;
	private onClose: () => void;

	private boxLeft = 0;
	private boxTop = 0;
	private boxWidth = 0;
	private boxHeight = 0;

	constructor(tui: any, theme: any, info: TodoTreeStatusInfo, onClose: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.info = info;
		this.onClose = onClose;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const totalLines = this.tui?.terminal?.rows || 24;

		this.boxWidth = Math.min(68, Math.max(46, Math.floor(width * 0.7)));
		this.boxHeight = 12;
		this.boxLeft = Math.max(0, Math.floor((width - this.boxWidth) / 2));
		this.boxTop = Math.max(0, Math.floor((totalLines - this.boxHeight) / 2));

		const innerWidth = this.boxWidth - 2;
		const lines: string[] = [];

		// Top padding
		for (let i = 0; i < this.boxTop; i++) {
			lines.push("");
		}

		// 1. Top border with title
		const title = " Todo Tree Status ";
		const topDashTotal = Math.max(0, innerWidth - visibleWidth(title));
		const leftDash = Math.floor(topDashTotal / 2);
		const rightDash = topDashTotal - leftDash;
		lines.push(
			`${" ".repeat(this.boxLeft)}${this.theme.fg("accent", "┌" + "─".repeat(leftDash))}${this.theme.style(title, { bold: true, fg: "accent" })}${this.theme.fg("accent", "─".repeat(rightDash) + "┐")}`,
		);

		// Helper to format an inner line with borders
		const pushRow = (contentStr: string, rawLen: number) => {
			const pad = Math.max(0, innerWidth - 2 - rawLen);
			lines.push(
				`${" ".repeat(this.boxLeft)}${this.theme.fg("accent", "│ ")}${contentStr}${" ".repeat(pad)} ${this.theme.fg("accent", "│")}`,
			);
		};

		// 2. Status items
		const stateText = this.info.enabled ? "ENABLED" : "DISABLED (default)";
		const stateColored = this.info.enabled
			? this.theme.fg("success", "ENABLED")
			: this.theme.fg("muted", "DISABLED (default)");
		pushRow(`• Extension State : ${stateColored}`, `• Extension State : ${stateText}`.length);

		const activeText = this.info.isToolActive
			? "YES (declared to LLM)"
			: "NO (hidden from LLM)";
		const activeColored = this.info.isToolActive
			? this.theme.fg("success", "YES (declared to LLM)")
			: this.theme.fg("muted", "NO (hidden from LLM)");
		pushRow(`• Active in Model : ${activeColored}`, `• Active in Model : ${activeText}`.length);

		const shortcutText = `• Modal Shortcut  : ${this.info.shortcut}`;
		pushRow(this.theme.fg("text", shortcutText), shortcutText.length);

		const stats = this.info.stats;
		const tasksSummary = `• Total Tasks     : ${stats.total + stats.cancelled} (${stats.completed} done, ${stats.inProgress} active, ${stats.pending} pending, ${stats.cancelled} cancelled)`;
		const truncTasks = truncateToWidth(tasksSummary, innerWidth - 2);
		pushRow(this.theme.fg("text", truncTasks), visibleWidth(truncTasks));

		// Progress bar
		const barWidth = 14;
		const filled = Math.min(barWidth, Math.round((stats.percent / 100) * barWidth));
		const barStr = `[${"█".repeat(filled)}${"░".repeat(barWidth - filled)}]`;
		const progText = `• Progress        : ${stats.percent}% ${barStr}`;
		pushRow(this.theme.fg("accent", progText), progText.length);

		// Blank line
		pushRow("", 0);

		// 3. Hint / actions row
		const hint = "Press [Esc], [Enter] or any key to close";
		const hintTrunc = truncateToWidth(hint, innerWidth - 2);
		const hintPad = Math.max(0, innerWidth - 2 - visibleWidth(hintTrunc));
		lines.push(
			`${" ".repeat(this.boxLeft)}${this.theme.fg("accent", "│ ")}${this.theme.fg("muted", hintTrunc)}${" ".repeat(hintPad)} ${this.theme.fg("accent", "│")}`,
		);

		// 4. Bottom border
		lines.push(`${" ".repeat(this.boxLeft)}${this.theme.fg("accent", "└" + "─".repeat(innerWidth) + "┘")}`);

		return lines;
	}

	handleInput(_data: string): void {
		// Any key closes the lightweight status dialog
		this.onClose();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "click") {
			this.onClose();
			return { handled: true };
		}
		return undefined;
	}
}

// ============================================================================
// 7. English LLM Tool Definition & Guidance
// ============================================================================

export const TODO_TOOL_DESCRIPTION = `
Track and organize complex, multi-step engineering tasks using a hierarchical todo list.

WHEN TO USE:
- Tasks requiring multiple sequential or parallel steps (e.g. refactoring, multi-file edits, migrations).
- When a large task breaks down into distinct phases and specific subtasks.
- When explicitly asked by the user to track or plan steps.

WHEN NOT TO USE:
- Simple, single-step questions, read-only checks, or single-file trivial edits.

GUIDELINES:
1. Break down work into clear parent categories and actionable leaf subtasks.
2. Mark leaf subtasks as 'in_progress' when you start working on them. Multiple subtasks can be in progress simultaneously if working on them in parallel.
3. Update subtasks to 'completed' as soon as they are implemented and verified.
4. If scope changes or a task is no longer needed, mark it as 'cancelled' rather than leaving it stalled. Cancelled tasks do not block overall progress.
5. When all previous tasks are 100% completed, initiating a new batch_create with top-level tasks will automatically archive/clear finished tasks and start a fresh tree.
6. You can create subtasks under any existing parent task at any time using parentId.
`.trim();

// ============================================================================
// 8. Extension Entry Point
// ============================================================================

export const TODO_SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "status", label: "status", description: "查看 Todo Tree 状态模态悬浮窗" },
	{ value: "open", label: "open", description: "打开 Todo Tree 交互模态窗口" },
	{ value: "clear", label: "clear", description: "清空当前全部待办事项" },
	{ value: "on", label: "on", description: "启用 Todo Tree 插件与 LLM 工具" },
	{ value: "off", label: "off", description: "停用 Todo Tree 插件并隐藏工具" },
];

/**
 * todo/todos 命令参数补全
 */
export function getTodoArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const prefix = (argumentPrefix || "").trimStart();
	const filtered = TODO_SUBCOMMANDS.filter((item) =>
		item.value.toLowerCase().startsWith(prefix.toLowerCase()),
	);
	return filtered.length > 0 ? filtered : null;
}

export default function todoTreeExtension(pi: ExtensionAPI): void {
	const config = loadConfig();
	const store = new TodoTreeStore();

	let lastCtx: ExtensionContext | null = null;
	let activeModal: Component | null = null;
	let widgetComponent: TodoTreeWidgetComponent | null = null;
	let isPromptingUser = false;

	function persistSnapshot(): void {
		try {
			pi.appendEntry(SNAPSHOT_ENTRY_TYPE, {
				tasks: structuredClone(store.getAllTasks()),
				enabled: config.enabled,
			});
		} catch (e) {
			console.error("[todo-tree] Failed to append custom snapshot entry:", e);
		}
	}

	// Declarative + Native Tool Exposure Control
	function syncActiveTools(enabled: boolean): void {
		try {
			const current = pi.getActiveTools();
			if (enabled) {
				if (!current.includes("todo")) {
					pi.setActiveTools([...current, "todo"]);
				}
			} else {
				if (current.includes("todo")) {
					pi.setActiveTools(current.filter((t) => t !== "todo" && t !== "todos"));
				}
			}
		} catch {
			// Fallback if not supported
		}
	}

	function restoreFromBranch(ctx: ExtensionContext): void {
		// Navigation can lead to a branch that predates the first todo entry.
		// Never retain the previous branch's state in that case.
		config.enabled = loadConfig().enabled;
		store.loadSnapshot([]);
		try {
			const branch = ctx.sessionManager.getBranch();
			let restored = false;
			let restoredEnabled = false;
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE) {
					const data = entry.data as any;
					if (!restoredEnabled && typeof data?.enabled === "boolean") {
						config.enabled = data.enabled;
						restoredEnabled = true;
					}
					if (!restored && Array.isArray(data?.tasks)) {
						store.loadSnapshot(data.tasks);
						restored = true;
					}
				} else if (!restored && entry.type === "message" && entry.message.role === "toolResult" &&
					(entry.message.toolName === "todo" || entry.message.toolName === "todos")) {
					const details = entry.message.details as any;
					if (Array.isArray(details?.tasks)) {
						store.loadSnapshot(details.tasks);
						restored = true;
					}
				}
				if (restored && restoredEnabled) break;
			}
		} catch (e) {
			console.error("[todo-tree] Failed to restore branch:", e);
		}
	}

	// Mount widget using TUI factory (guarantees staying stably above rolling-tools)
	function syncWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI || !ctx.ui) return;

		if (!config.enabled) {
			if (widgetComponent) {
				widgetComponent.dispose();
				widgetComponent = null;
			}
			ctx.ui.setWidget("todos", undefined);
			return;
		}

		ctx.ui.setWidget(
			"todos",
			(tui: any, theme: any) => {
				if (!widgetComponent) {
					widgetComponent = new TodoTreeWidgetComponent(tui, theme, store, () => openModal(ctx));
				} else {
					widgetComponent.updateTuiAndTheme(tui, theme);
				}
				return widgetComponent;
			},
			{ placement: "aboveEditor" },
		);
	}

	// Open Lightweight Status Modal
	function openStatusModal(ctx: ExtensionContext): void {
		const stats = store.getProgressStats();
		const activeTools = pi.getActiveTools?.() ?? [];
		const isToolActive = activeTools.includes("todo");

		if (!ctx.hasUI || ctx.mode === "rpc" || !ctx.ui?.custom) {
			const info = [
				`Todo Tree Status:`,
				`• State: ${config.enabled ? "ENABLED" : "DISABLED (default)"}`,
				`• Active in Model: ${isToolActive ? "YES (declared to LLM)" : "NO (hidden from LLM)"}`,
				`• Shortcut: ${config.shortcut}`,
				`• Tasks: ${stats.total + stats.cancelled} (${stats.completed} completed, ${stats.inProgress} in progress, ${stats.pending} pending, ${stats.cancelled} cancelled)`,
				`• Progress: ${stats.percent}%`,
			].join("\n");
			ctx.ui?.notify?.(info, "info");
			return;
		}

		if (activeModal || isPromptingUser) return;

		const statusInfo: TodoTreeStatusInfo = {
			enabled: config.enabled,
			isToolActive,
			shortcut: config.shortcut,
			stats: {
				total: stats.total,
				completed: stats.completed,
				inProgress: stats.inProgress,
				pending: stats.pending,
				cancelled: stats.cancelled,
				percent: stats.percent,
			},
		};

		Promise.resolve(
			ctx.ui.custom(
				(tui: any, theme: any, _keybindings: any, done: (result: unknown) => void) => {
					const component = new TodoTreeStatusModalComponent(tui, theme, statusInfo, () => {
						activeModal = null;
						done(undefined);
					});
					activeModal = component;
					return component;
				},
				{
					overlay: true,
					overlayOptions: {
						width: "100%",
						maxHeight: "100%",
						anchor: "top-left",
						margin: 0,
					},
				},
			),
		).catch((err: unknown) => {
			activeModal = null;
			console.error("[todo-tree] status modal error:", err);
		});
	}

	// Open Fullscreen / Centered Overlay Modal
	function openModal(ctx: ExtensionContext): void {
		if (!ctx.hasUI || ctx.mode === "rpc" || !ctx.ui?.custom) return;
		if (activeModal || isPromptingUser) return;

		Promise.resolve(
			ctx.ui.custom(
				(tui: any, theme: any, _keybindings: any, done: (result: unknown) => void) => {
					const component = new TodoTreeOverlayComponent(
						tui,
						theme,
						store,
						() => {
							activeModal = null;
							done(undefined);
						},
						(taskId: string) => {
							activeModal = null;
							done(undefined);
							void promptAddUserNote(ctx, taskId);
						},
						() => {
							// On modal c/x status change
							persistSnapshot();
						},
					);
					activeModal = component;
					return component;
				},
				{
					overlay: true,
					overlayOptions: {
						width: "100%",
						maxHeight: "100%",
						anchor: "top-left",
						margin: 0,
					},
				},
			),
		).catch((err: unknown) => {
			activeModal = null;
			console.error("[todo-tree] modal error:", err);
		});
	}

	async function promptAddUserNote(ctx: ExtensionContext, taskId: string): Promise<void> {
		if (!ctx.ui?.input) return;
		const task = store.getTask(taskId);
		if (!task) return;

		isPromptingUser = true;

		try {
			const noteText = await ctx.ui.input(
				`Add Note for Task #${task.id} (${task.subject})`,
				"Type context note (leave blank to cancel)...",
			);

			if (noteText && noteText.trim()) {
				store.addUserNote(taskId, noteText.trim());
				persistSnapshot();
				ctx.ui.notify?.(`Added note to #${taskId}`, "info");

				if (ctx.ui.confirm) {
					const notifyAgent = await ctx.ui.confirm(
						"Remind Agent?",
						"Send this note to the LLM agent as a prompt message?",
					);
					if (notifyAgent) {
						pi.sendUserMessage(`[Todo Note for Task #${task.id}]: ${noteText.trim()}`, {
							deliverAs: "followUp",
						});
					}
				}
			}
		} finally {
			isPromptingUser = false;
			openModal(ctx);
		}
	}

	// Register LLM Tool with defaultActive: false (Declarative Clean Isolation)
	pi.registerTool({
		name: "todo",
		label: "Todo Tree",
		description: TODO_TOOL_DESCRIPTION,
		defaultActive: false, // Inactive by default upon registration!
		parameters: TodoToolParamsSchema,
		execute: async (_toolCallId, params: TodoToolParams) => {
			const action = params.action;

			const getTasksSnapshot = () =>
				store.getAllTasks().map((t) => ({
					id: t.id,
					parentId: t.parentId,
					subject: t.subject,
					description: t.description,
					status: t.status,
					createdAt: t.createdAt,
					updatedAt: t.updatedAt,
					notes: structuredClone(t.notes),
					completed: t.status === "completed" || t.status === "cancelled",
					done: t.status === "completed" || t.status === "cancelled",
				}));

			try {
				let summary = "";

				switch (action) {
					case "create": {
						if (!params.subject || !params.subject.trim()) {
							throw new Error("Field 'subject' is required for action 'create'.");
						}
						const item = store.createTask({
							id: params.id,
							parentId: params.parentId,
							subject: params.subject,
							description: params.description,
							status: params.status,
						});
						const parentDesc = item.parentId ? ` under #${item.parentId}` : "";
						summary = `✓ Created #${item.id} "${item.subject}"${parentDesc} (${item.status})`;
						break;
					}

					case "batch_create": {
						if (!params.tasks || !Array.isArray(params.tasks) || params.tasks.length === 0) {
							throw new Error("Array 'tasks' is required and cannot be empty for 'batch_create'.");
						}

						// Strategy A: If all existing tasks are completed/cancelled (100% done)
						// and a new batch_create is initiated, automatically clear the old finished tasks
						// to keep the view clean, avoid endless scrolling, and prevent snapshot bloating.
						const existingTasks = store.getAllTasks();
						let autoCleared = false;
						if (existingTasks.length > 0) {
							const stats = store.getProgressStats();
							const allFinished =
								stats.total > 0 &&
								stats.completed === stats.total &&
								stats.inProgress === 0 &&
								stats.pending === 0;

							// Also ensure new batch has at least one top-level task (initiating a new plan)
							const hasNewRoot = params.tasks.some((t) => !t.parentId);
							if (allFinished && hasNewRoot) autoCleared = true;
						}

						const created = store.batchCreate(params.tasks, autoCleared);
						summary = autoCleared
							? `✓ Cleared previous finished tasks & started new tree with ${created.length} tasks`
							: `✓ Batch created ${created.length} tasks`;
						break;
					}

					case "update": {
						if (!params.id) {
							throw new Error("Field 'id' is required for action 'update'.");
						}
						const item = store.updateTask(params.id, {
							subject: params.subject,
							description: params.description,
							status: params.status,
							note: params.note,
						});
						summary = `✓ Updated #${item.id} (status: ${item.status})`;
						break;
					}

					case "delete": {
						if (!params.id) {
							throw new Error("Field 'id' is required for action 'delete'.");
						}
						const target = store.getTask(params.id);
						store.deleteTask(params.id);
						summary = `✓ Deleted #${params.id}${target ? ` (${target.subject})` : ""}`;
						break;
					}

					case "clear": {
						const count = store.getAllTasks().length;
						store.clear();
						summary = `✓ Cleared ${count} tasks`;
						break;
					}

					case "list":
					default: {
						const stats = store.getProgressStats();
						summary = `Todo list: ${stats.completed}/${stats.total} completed (${stats.percent}%), ${stats.inProgress} in progress, ${stats.pending} pending.`;
						break;
					}
				}

				persistSnapshot();

				return {
					content: [{ type: "text", text: summary }],
					details: {
						action,
						tasks: getTasksSnapshot(),
						stats: store.getProgressStats(),
					},
				};
			} catch (err: any) {
				return {
					isError: true,
					content: [{ type: "text", text: `Error: ${err?.message || String(err)}` }],
					details: {
						action,
						error: err?.message || String(err),
						tasks: getTasksSnapshot(),
						stats: store.getProgressStats(),
					},
				};
			}
		},
	});

	// Lifecycle Events
	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		restoreFromBranch(ctx);
		syncActiveTools(config.enabled);
		syncWidget(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		lastCtx = ctx;
		restoreFromBranch(ctx);
		syncActiveTools(config.enabled);
		syncWidget(ctx);
		widgetComponent?.invalidate();
	});

	pi.on("session_shutdown", () => {
		activeModal = null;
		if (widgetComponent) {
			widgetComponent.dispose();
			widgetComponent = null;
		}
	});

	// Register Shortcut with clean validation
	try {
		pi.registerShortcut(config.shortcut as KeyId, {
			description: "Open Todo Tree modal",
			handler: (ctx) => {
				openModal(ctx);
			},
		});
	} catch (e) {
		console.warn(`[todo-tree] Could not register shortcut "${config.shortcut}":`, e);
	}

	const commandHandler = async (args: string, ctx: ExtensionContext) => {
		lastCtx = ctx;
		const trimmed = args.trim().toLowerCase();

		if (trimmed === "on" || trimmed === "enable") {
			config.enabled = true;
			saveConfig(config);
			syncActiveTools(true);
			persistSnapshot();
			syncWidget(ctx);
			ctx.ui?.notify?.("✓ Todo Tree is now ENABLED (Tool active for LLM, widget visible)", "info");
		} else if (trimmed === "off" || trimmed === "disable") {
			config.enabled = false;
			saveConfig(config);
			syncActiveTools(false);
			persistSnapshot();
			syncWidget(ctx);
			ctx.ui?.notify?.("✓ Todo Tree is now DISABLED (Tool hidden from LLM)", "info");
		} else if (trimmed === "toggle") {
			config.enabled = !config.enabled;
			saveConfig(config);
			syncActiveTools(config.enabled);
			persistSnapshot();
			syncWidget(ctx);
			ctx.ui?.notify?.(`Todo Tree is now ${config.enabled ? "ENABLED" : "DISABLED"}`, "info");
		} else if (trimmed === "open" || trimmed === "modal") {
			openModal(ctx);
		} else if (trimmed === "clear") {
			store.clear();
			persistSnapshot();
			ctx.ui?.notify?.("Todo Tree list cleared.", "info");
		} else if (trimmed === "status") {
			openStatusModal(ctx);
		} else {
			if (!config.enabled) {
				config.enabled = true;
				saveConfig(config);
				syncActiveTools(true);
				persistSnapshot();
				syncWidget(ctx);
				ctx.ui?.notify?.("Todo Tree enabled. Click [📋 ] or press shortcut to view.", "info");
			} else {
				openModal(ctx);
			}
		}
	};

	pi.registerCommand("todo", {
		description: "Hierarchical todo list (/todo on|off|toggle|open|status|clear)",
		getArgumentCompletions: getTodoArgumentCompletions,
		handler: commandHandler,
	});

	pi.registerCommand("todos", {
		description: "Alias for /todo",
		getArgumentCompletions: getTodoArgumentCompletions,
		handler: commandHandler,
	});
}
