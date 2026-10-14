import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component, KeyId, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

// ============================================================================
// 1. Data Models & Schemas
// ============================================================================

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
}

export interface ProgressStats {
	total: number;
	completed: number;
	inProgress: number;
	pending: number;
	cancelled: number;
	percent: number;
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
	enabled: false, // Default off: small tasks don't need todo list
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
// 3. State Store (Hierarchical Tree)
// ============================================================================

export class TodoTreeStore {
	private tasks = new Map<string, TodoItem>();
	private collapsedNodes = new Set<string>();
	private listeners: Array<() => void> = [];

	subscribe(fn: () => void): () => void {
		this.listeners.push(fn);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== fn);
		};
	}

	private notify(): void {
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
		this.notify();
	}

	loadSnapshot(items: TodoItem[]): void {
		this.tasks.clear();
		for (const item of items) {
			if (item && item.id) {
				this.tasks.set(item.id, {
					...item,
					status: item.status ?? "pending",
					notes: Array.isArray(item.notes) ? item.notes : [],
				});
			}
		}
		this.notify();
	}

	generateNextId(parentId?: string | null): string {
		if (!parentId) {
			// Find max root integer
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

		// Find children of parentId
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

		const id = params.id?.trim() || this.generateNextId(parentId);
		if (this.tasks.has(id)) {
			throw new Error(`Task with ID "#${id}" already exists.`);
		}

		const now = Date.now();
		const item: TodoItem = {
			id,
			parentId,
			subject: params.subject.trim(),
			description: params.description?.trim(),
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
	}>): TodoItem[] {
		const created: TodoItem[] = [];
		for (const t of tasks) {
			const item = this.createTask(t);
			created.push(item);
		}
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

		if (patch.subject !== undefined) task.subject = patch.subject.trim();
		if (patch.description !== undefined) task.description = patch.description.trim();
		if (patch.status !== undefined) {
			const prevStatus = task.status;
			task.status = patch.status;

			// Cascade if parent is cancelled or completed
			if (patch.status === "cancelled" || patch.status === "completed") {
				this.cascadeChildrenStatus(id, patch.status);
			}

			// Parent status linkage
			if (task.parentId) {
				this.checkParentStatus(task.parentId);
			}
		}

		if (patch.note && patch.note.trim()) {
			task.notes = task.notes || [];
			task.notes.push({
				id: `note-${Date.now()}`,
				author: "agent",
				text: patch.note.trim(),
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
		task.notes = task.notes || [];
		task.notes.push({
			id: `note-${Date.now()}`,
			author: "user",
			text: text.trim(),
			createdAt: Date.now(),
		});
		task.updatedAt = Date.now();
		this.notify();
	}

	deleteTask(id: string): void {
		const task = this.tasks.get(id);
		if (!task) return;

		// Recursively delete children
		const toDelete: string[] = [id];
		const collectChildren = (parentId: string) => {
			for (const t of this.tasks.values()) {
				if (t.parentId === parentId) {
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

	private cascadeChildrenStatus(parentId: string, newStatus: TodoStatus): void {
		for (const t of this.tasks.values()) {
			if (t.parentId === parentId) {
				if (t.status !== "completed" && t.status !== "cancelled") {
					t.status = newStatus;
					t.updatedAt = Date.now();
					this.cascadeChildrenStatus(t.id, newStatus);
				}
			}
		}
	}

	private checkParentStatus(parentId: string | null | undefined): void {
		if (!parentId) return;
		const parent = this.tasks.get(parentId);
		if (!parent) return;

		const children: TodoItem[] = [];
		for (const t of this.tasks.values()) {
			if (t.parentId === parentId) {
				children.push(t);
			}
		}

		if (children.length === 0) return;

		const allDone = children.every(
			(c) => c.status === "completed" || c.status === "cancelled",
		);
		const anyInProgress = children.some((c) => c.status === "in_progress");

		if (allDone && children.some((c) => c.status === "completed")) {
			parent.status = "completed";
			parent.updatedAt = Date.now();
		} else if (anyInProgress && parent.status === "pending") {
			parent.status = "in_progress";
			parent.updatedAt = Date.now();
		}

		if (parent.parentId) {
			this.checkParentStatus(parent.parentId);
		}
	}

	buildTree(): TreeNode[] {
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

		// Sort naturally by ID
		const sortFn = (a: TodoItem, b: TodoItem) =>
			a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" });

		rootItems.sort(sortFn);
		for (const list of childMap.values()) {
			list.sort(sortFn);
		}

		const buildNode = (
			item: TodoItem,
			depth: number,
			isLastChild: boolean,
			ancestorHasNextSibling: boolean[],
		): TreeNode => {
			const childrenItems = childMap.get(item.id) || [];
			const childrenNodes: TreeNode[] = [];

			for (let i = 0; i < childrenItems.length; i++) {
				const isLast = i === childrenItems.length - 1;
				const nextAncestors = [...ancestorHasNextSibling, !isLast];
				childrenNodes.push(buildNode(childrenItems[i], depth + 1, isLast, nextAncestors));
			}

			return {
				item,
				children: childrenNodes,
				depth,
				isLastChild,
				ancestorHasNextSibling,
			};
		};

		return rootItems.map((item, idx) =>
			buildNode(item, 0, idx === rootItems.length - 1, []),
		);
	}

	getFlattenedTree(): Array<{ node: TreeNode; hasChildren: boolean }> {
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
		return result;
	}

	getActiveInProgressTasks(): Array<{ task: TodoItem; breadcrumb: string }> {
		const result: Array<{ task: TodoItem; breadcrumb: string }> = [];

		// Collect all IDs that are parents
		const parentIds = new Set<string>();
		for (const t of this.tasks.values()) {
			if (t.parentId) parentIds.add(t.parentId);
		}

		for (const task of this.tasks.values()) {
			if (task.status === "in_progress") {
				// If this task has children and any child is in_progress, skip the parent
				// so we only show the concrete active subtasks
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

				// Build breadcrumb
				const path: string[] = [];
				let curr: TodoItem | undefined = task;
				while (curr?.parentId) {
					curr = this.tasks.get(curr.parentId);
					if (curr) path.unshift(curr.subject);
				}

				const breadcrumb = path.length > 0 ? `[${path.join(" > ")}] ` : "";
				result.push({ task, breadcrumb });
			}
		}

		result.sort((a, b) =>
			a.task.id.localeCompare(b.task.id, undefined, { numeric: true }),
		);
		return result;
	}

	getProgressStats(): ProgressStats {
		let total = 0;
		let completed = 0;
		let inProgress = 0;
		let pending = 0;
		let cancelled = 0;

		// Calculate progress over leaf nodes (or all nodes if no hierarchy)
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

		return {
			total: activeTotal,
			completed,
			inProgress,
			pending,
			cancelled,
			percent,
		};
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

function getStatusGlyph(status: TodoStatus): { glyph: string; colorKey: string } {
	switch (status) {
		case "completed":
			return { glyph: "✓", colorKey: "success" };
		case "in_progress":
			return { glyph: "◐", colorKey: "accent" };
		case "cancelled":
			return { glyph: "✗", colorKey: "muted" };
		case "pending":
		default:
			return { glyph: "○", colorKey: "text" };
	}
}

// ============================================================================
// 5. Main Screen Above-Editor Widget Component
// ============================================================================

export class TodoTreeWidgetComponent implements Component {
	private tui: any;
	private theme: any;
	private store: TodoTreeStore;
	private onOpenModal: () => void;
	private cachedLines: string[] | null = null;
	private cachedWidth = 0;

	constructor(tui: any, theme: any, store: TodoTreeStore, onOpenModal: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.store = store;
		this.onOpenModal = onOpenModal;

		this.store.subscribe(() => {
			this.invalidate();
			this.tui?.requestRender?.();
		});
	}

	invalidate(): void {
		this.cachedLines = null;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const tasks = this.store.getAllTasks();
		if (tasks.length === 0) {
			this.cachedLines = [];
			this.cachedWidth = width;
			return [];
		}

		const stats = this.store.getProgressStats();
		const activeItems = this.store.getActiveInProgressTasks();
		const lines: string[] = [];

		const buttonText = "[📋 ]";
		const buttonWidth = visibleWidth(buttonText);

		// Line 1: Header / Progress
		const hasActive = activeItems.length > 0;
		const dotGlyph = hasActive
			? this.theme.fg("accent", "●")
			: stats.completed === stats.total && stats.total > 0
				? this.theme.fg("success", "✓")
				: this.theme.fg("muted", "○");

		const tagText = `Todos [${stats.completed}/${stats.total} · ${stats.percent}%]`;
		const barText = renderProgressBar(stats.percent, 8);
		const tagStyled = this.theme.fg("accent", tagText);
		const barStyled = this.theme.fg("accent", barText);

		let prefix = ` ${dotGlyph} ${tagStyled} ${barStyled} `;
		const prefixLen = visibleWidth(` ● ${tagText} ${barText} `);

		const availableForSubject = Math.max(10, width - prefixLen - buttonWidth - 2);

		if (hasActive) {
			const first = activeItems[0];
			const firstLabel = `${first.breadcrumb}#${first.task.id} ${first.task.subject}`;
			const truncatedSubject = truncateToWidth(firstLabel, availableForSubject);
			const subjectStyled = this.theme.style(truncatedSubject, { bold: true });

			const middleLen = visibleWidth(truncatedSubject);
			const padLen = Math.max(1, width - prefixLen - middleLen - buttonWidth);
			const btnStyled = this.theme.fg("accent", buttonText);

			lines.push(`${prefix}${subjectStyled}${" ".repeat(padLen)}${btnStyled}`);

			// Requirements: All in_progress tasks must be displayed without limit!
			for (let i = 1; i < activeItems.length; i++) {
				const item = activeItems[i];
				const glyph = this.theme.fg("accent", "  └─ ◐ ");
				const label = `${item.breadcrumb}#${item.task.id} ${item.task.subject}`;
				const trunc = truncateToWidth(label, width - 8);
				lines.push(`${glyph}${this.theme.fg("text", trunc)}`);
			}
		} else {
			// No active task currently in progress
			const statusMsg =
				stats.completed === stats.total && stats.total > 0
					? "All tasks completed"
					: `${stats.pending} pending tasks`;
			const msgStyled = this.theme.fg("muted", statusMsg);
			const msgLen = visibleWidth(statusMsg);
			const padLen = Math.max(1, width - prefixLen - msgLen - buttonWidth);
			const btnStyled = this.theme.fg("accent", buttonText);

			lines.push(`${prefix}${msgStyled}${" ".repeat(padLen)}${btnStyled}`);
		}

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "click") {
			// Click on line 0 rightmost area or anywhere on the widget can trigger the modal
			const width = this.cachedWidth || 80;
			if (event.y === 0 && event.x >= width - 8) {
				this.onOpenModal();
				return { handled: true };
			}
			// If double click anywhere on the widget, also open modal
			if (event.button === "left" && event.x >= 0 && event.x <= width) {
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

	private selectedIndex = 0;
	private scrollTop = 0;

	// Bounding box geometry
	private boxLeft = 0;
	private boxTop = 0;
	private boxWidth = 0;
	private boxHeight = 0;
	private listHeight = 10;
	private lastWidth = 80;

	constructor(
		tui: any,
		theme: any,
		store: TodoTreeStore,
		onClose: () => void,
		onPromptUserNote?: (taskId: string) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.store = store;
		this.onClose = onClose;
		this.onPromptUserNote = onPromptUserNote;

		// Select first in-progress task if available
		const flat = this.store.getFlattenedTree();
		const inProgIdx = flat.findIndex((f) => f.node.item.status === "in_progress");
		if (inProgIdx >= 0) {
			this.selectedIndex = inProgIdx;
		}
	}

	invalidate(): void {
		// Stateless render calculation
	}

	render(width: number): string[] {
		this.lastWidth = width;
		const totalLines = this.tui?.terminal?.rows || 24;

		// Calculate modal dimensions (centered)
		this.boxWidth = Math.min(100, Math.max(50, Math.floor(width * 0.88)));
		this.boxHeight = Math.min(32, Math.max(14, Math.floor(totalLines * 0.82)));
		this.boxLeft = Math.max(0, Math.floor((width - this.boxWidth) / 2));
		this.boxTop = Math.max(0, Math.floor((totalLines - this.boxHeight) / 2));

		const flat = this.store.getFlattenedTree();
		const stats = this.store.getProgressStats();

		// Header lines: 3, Footer lines: 4. Available for tree list:
		this.listHeight = Math.max(4, this.boxHeight - 7);

		// Clamp selectedIndex & scrollTop
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

		// Top border
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

		// Stats line
		const statsText = ` Progress: ${stats.completed}/${stats.total} done (${stats.percent}%) · ${stats.inProgress} in progress · ${stats.pending} pending · ${stats.cancelled} cancelled`;
		const statsBar = ` ${renderProgressBar(stats.percent, 12)} `;
		const statPad = Math.max(0, innerWidth - visibleWidth(statsText) - visibleWidth(statsBar));
		const statLine =
			this.theme.fg("accent", "│") +
			this.theme.fg("text", statsText) +
			" ".repeat(statPad) +
			this.theme.fg("accent", statsBar) +
			this.theme.fg("accent", "│");
		lines.push(`${" ".repeat(this.boxLeft)}${statLine}`);

		// Divider
		lines.push(`${" ".repeat(this.boxLeft)}${this.theme.fg("accent", "├" + "─".repeat(innerWidth) + "┤")}`);

		// Tree list with scrollbar
		const visibleRows = flat.slice(this.scrollTop, this.scrollTop + this.listHeight);
		const scrollbarActive = flat.length > this.listHeight;

		// Scrollbar thumb calculation
		const thumbHeight = scrollbarActive
			? Math.max(1, Math.round((this.listHeight / flat.length) * this.listHeight))
			: 0;
		const thumbTop = scrollbarActive && maxScroll > 0
			? Math.round((this.scrollTop / maxScroll) * (this.listHeight - thumbHeight))
			: 0;

		for (let row = 0; row < this.listHeight; row++) {
			let lineContent = "";

			if (row < visibleRows.length) {
				const itemIdx = this.scrollTop + row;
				const isSelected = itemIdx === this.selectedIndex;
				const { node, hasChildren } = visibleRows[row];
				const item = node.item;

				// Tree prefix formatting
				let treePrefix = "";
				for (let d = 0; d < node.depth; d++) {
					treePrefix += node.ancestorHasNextSibling[d] ? "│  " : "   ";
				}
				treePrefix += node.depth === 0 ? "" : node.isLastChild ? "└─ " : "├─ ";

				// Fold indicator
				const foldIcon = hasChildren
					? this.store.isCollapsed(item.id)
						? "▶ "
						: "▼ "
					: "  ";

				// Status glyph
				const { glyph, colorKey } = getStatusGlyph(item.status);
				const glyphStyled = this.theme.fg(colorKey, glyph);

				// Notes badge
				const noteBadge =
					item.notes && item.notes.length > 0
						? this.theme.fg("warning", ` 💬(${item.notes.length})`)
						: "";

				// Task Subject
				const idStr = `#${item.id} `;
				const subjectStr = item.subject;

				const rawRowText = ` ${treePrefix}${foldIcon}${glyph} ${idStr}${subjectStr}`;
				const maxTextWidth = innerWidth - (scrollbarActive ? 2 : 1);
				const truncated = truncateToWidth(rawRowText, maxTextWidth);

				// Apply styles
				let styledText =
					` ${this.theme.fg("muted", treePrefix)}` +
					`${this.theme.fg("accent", foldIcon)}` +
					`${glyphStyled} ` +
					`${this.theme.fg("accent", idStr)}`;

				if (item.status === "completed" || item.status === "cancelled") {
					styledText += this.theme.fg("muted", subjectStr);
				} else if (item.status === "in_progress") {
					styledText += this.theme.style(subjectStr, { bold: true, fg: "text" });
				} else {
					styledText += this.theme.fg("text", subjectStr);
				}

				styledText += noteBadge;

				if (isSelected) {
					// Highlight selected row with background or pointer
					styledText = this.theme.style(`> ${truncateToWidth(styledText, maxTextWidth - 2)}`, {
						bold: true,
					});
				} else {
					styledText = `  ${styledText}`;
				}

				const currentWidth = visibleWidth(isSelected ? `> ${truncated}` : `  ${truncated}`);
				const rowPad = Math.max(0, maxTextWidth - currentWidth);
				lineContent = styledText + " ".repeat(rowPad);
			} else {
				lineContent = " ".repeat(innerWidth - (scrollbarActive ? 1 : 0));
			}

			// Scrollbar track & thumb
			let scrollbarChar = " ";
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

		// Detail box for selected task
		lines.push(`${" ".repeat(this.boxLeft)}${this.theme.fg("accent", "├" + "─".repeat(innerWidth) + "┤")}`);

		const selectedTask = flat[this.selectedIndex]?.node.item;
		let detailText = " No task selected";
		if (selectedTask) {
			const statusLabel = `[${selectedTask.status.toUpperCase()}]`;
			const lastNote = selectedTask.notes && selectedTask.notes.length > 0
				? ` | Note: ${selectedTask.notes[selectedTask.notes.length - 1].text}`
				: selectedTask.description
					? ` | ${selectedTask.description}`
					: "";
			detailText = ` #${selectedTask.id} ${selectedTask.subject} ${statusLabel}${lastNote}`;
		}
		const truncDetail = truncateToWidth(detailText, innerWidth);
		const detailPad = Math.max(0, innerWidth - visibleWidth(truncDetail));
		lines.push(
			`${" ".repeat(this.boxLeft)}${this.theme.fg("accent", "│")}${this.theme.fg("muted", truncDetail)}${" ".repeat(detailPad)}${this.theme.fg("accent", "│")}`,
		);

		// Bottom action bar
		const actions = " [Space] Fold  [n] Note  [c] Done  [x] Cancel  [Esc] Close";
		const actTrunc = truncateToWidth(actions, innerWidth);
		const actPad = Math.max(0, innerWidth - visibleWidth(actTrunc));
		lines.push(
			`${" ".repeat(this.boxLeft)}${this.theme.fg("accent", "│")}${this.theme.fg("accent", actTrunc)}${" ".repeat(actPad)}${this.theme.fg("accent", "│")}`,
		);

		// Bottom border
		lines.push(`${" ".repeat(this.boxLeft)}${this.theme.fg("accent", "└" + "─".repeat(innerWidth) + "┘")}`);

		return lines;
	}

	handleKey(key: KeyId | string): boolean {
		const flat = this.store.getFlattenedTree();

		if (key === "escape" || key === "q" || key === "return") {
			this.onClose();
			return true;
		}

		if (key === "up" || key === "k") {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.tui?.requestRender?.();
			}
			return true;
		}

		if (key === "down" || key === "j") {
			if (this.selectedIndex < flat.length - 1) {
				this.selectedIndex++;
				this.tui?.requestRender?.();
			}
			return true;
		}

		if (key === "pageup") {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.listHeight);
			this.tui?.requestRender?.();
			return true;
		}

		if (key === "pagedown") {
			this.selectedIndex = Math.min(flat.length - 1, this.selectedIndex + this.listHeight);
			this.tui?.requestRender?.();
			return true;
		}

		if (key === "home") {
			this.selectedIndex = 0;
			this.tui?.requestRender?.();
			return true;
		}

		if (key === "end") {
			this.selectedIndex = Math.max(0, flat.length - 1);
			this.tui?.requestRender?.();
			return true;
		}

		// Space: Fold/Unfold
		if (key === "space") {
			const current = flat[this.selectedIndex];
			if (current && current.hasChildren) {
				this.store.toggleCollapsed(current.node.item.id);
			}
			return true;
		}

		// 'c': Toggle completed / pending
		if (key === "c") {
			const current = flat[this.selectedIndex];
			if (current) {
				const nextStatus: TodoStatus =
					current.node.item.status === "completed" ? "pending" : "completed";
				this.store.updateTask(current.node.item.id, { status: nextStatus });
			}
			return true;
		}

		// 'x': Cancel task
		if (key === "x") {
			const current = flat[this.selectedIndex];
			if (current) {
				const nextStatus: TodoStatus =
					current.node.item.status === "cancelled" ? "pending" : "cancelled";
				this.store.updateTask(current.node.item.id, { status: nextStatus });
			}
			return true;
		}

		// 'n': Add user note
		if (key === "n") {
			const current = flat[this.selectedIndex];
			if (current && this.onPromptUserNote) {
				this.onPromptUserNote(current.node.item.id);
			}
			return true;
		}

		return false;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// Click outside box closes modal
		if (event.type === "click") {
			const isInside =
				event.x >= this.boxLeft &&
				event.x < this.boxLeft + this.boxWidth &&
				event.y >= this.boxTop &&
				event.y < this.boxTop + this.boxHeight;

			if (!isInside) {
				this.onClose();
				return { handled: true };
			}

			// Click on row inside list
			const listRelativeY = event.y - (this.boxTop + 3);
			if (listRelativeY >= 0 && listRelativeY < this.listHeight) {
				const targetIndex = this.scrollTop + listRelativeY;
				const flat = this.store.getFlattenedTree();
				if (targetIndex < flat.length) {
					this.selectedIndex = targetIndex;
					// If clicking fold icon, toggle collapse
					if (event.x >= this.boxLeft + 2 && event.x <= this.boxLeft + 8) {
						if (flat[targetIndex].hasChildren) {
							this.store.toggleCollapsed(flat[targetIndex].node.item.id);
						}
					}
					this.tui?.requestRender?.();
					return { handled: true };
				}
			}
		}

		// Mouse wheel scrolling
		if (event.type === "wheel") {
			const delta = event.wheelDelta ?? (event as any).deltaY ?? 0;
			const flat = this.store.getFlattenedTree();
			const maxScroll = Math.max(0, flat.length - this.listHeight);

			if (delta > 0) {
				this.scrollTop = Math.min(maxScroll, this.scrollTop + 2);
				this.selectedIndex = Math.min(flat.length - 1, this.selectedIndex + 2);
			} else if (delta < 0) {
				this.scrollTop = Math.max(0, this.scrollTop - 2);
				this.selectedIndex = Math.max(0, this.selectedIndex - 2);
			}
			this.tui?.requestRender?.();
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
4. If scope changes or a task is no longer needed, mark it as 'cancelled' rather than leaving it stalled.
5. You can create subtasks under any existing parent task at any time using parentId.
`.trim();

// ============================================================================
// 8. Extension Entry Point
// ============================================================================

export default function todoTreeExtension(pi: ExtensionAPI): void {
	const config = loadConfig();
	const store = new TodoTreeStore();

	let lastCtx: ExtensionContext | null = null;
	let activeModal: TodoTreeOverlayComponent | null = null;
	let widgetComponent: TodoTreeWidgetComponent | null = null;

	// Persistence: restore from session branch
	function restoreFromBranch(ctx: ExtensionContext): void {
		try {
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "message" && entry.message.role === "toolResult") {
					if (entry.message.toolName === "todo" || entry.message.toolName === "todos") {
						const details = entry.message.details as any;
						if (details && Array.isArray(details.tasks)) {
							store.loadSnapshot(details.tasks);
						}
					}
				}
			}
		} catch (e) {
			console.error("[todo-tree] Failed to restore branch:", e);
		}
	}

	// Mount widget (Only once! Guarantees staying ABOVE rolling-tools)
	function syncWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI || !ctx.ui) return;

		if (!config.enabled) {
			ctx.ui.setWidget("todos", undefined);
			widgetComponent = null;
			return;
		}

		if (!widgetComponent) {
			widgetComponent = new TodoTreeWidgetComponent(
				(ctx.ui as any).terminal ?? {},
				ctx.ui.theme,
				store,
				() => openModal(ctx),
			);

			// In Map iteration, setting "todos" places it at current insertion point.
			// Because rolling-tools repeatedly calls setWidget on every tool call,
			// rolling-tools continuously pushes itself to the END (bottom) of the Map.
			// By keeping "todos" mounted without repeated setWidget calls, "todos"
			// stays stably ABOVE rolling-tools!
			ctx.ui.setWidget("todos", () => widgetComponent!, { placement: "aboveEditor" });
		} else {
			widgetComponent.invalidate();
		}
	}

	// Open Fullscreen / Centered Overlay Modal
	function openModal(ctx: ExtensionContext): void {
		if (!ctx.hasUI || !ctx.ui?.custom) return;
		if (activeModal) return;

		void ctx.ui
			.custom(
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
							// Prompt user for annotation
							activeModal = null;
							done(undefined);
							setTimeout(() => {
								promptAddUserNote(ctx, taskId);
							}, 50);
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
			)
			.catch((err: unknown) => {
				activeModal = null;
				console.error("[todo-tree] modal error:", err);
			});
	}

	// Prompt user to add note to a task
	async function promptAddUserNote(ctx: ExtensionContext, taskId: string): Promise<void> {
		if (!ctx.ui?.input) return;
		const task = store.getTask(taskId);
		if (!task) return;

		const noteText = await ctx.ui.input(
			`Add Note for Task #${task.id} (${task.subject})`,
			"Type context note (leave blank to cancel)...",
		);

		if (noteText && noteText.trim()) {
			store.addUserNote(taskId, noteText.trim());
			ctx.ui.notify?.(`Added note to #${taskId}`, "info");

			// Check if user also wants to notify LLM agent
			if (ctx.ui.confirm) {
				const notifyAgent = await ctx.ui.confirm(
					"Remind Agent?",
					"Send this note to the LLM agent as a prompt message?",
				);
				if (notifyAgent) {
					// Send as user message appended to conversation tail (Zero Prompt Cache invalidation!)
					pi.sendUserMessage(`[Todo Note for Task #${task.id}]: ${noteText.trim()}`, {
						deliverAs: "followUp",
					});
				}
			}
		}

		// Re-open modal
		openModal(ctx);
	}

	// --------------------------------------------------------------------------
	// 8.1 Register LLM Tool ("todo")
	// --------------------------------------------------------------------------
	pi.registerTool({
		name: "todo",
		label: "Todo Tree",
		description: TODO_TOOL_DESCRIPTION,
		parameters: TodoToolParamsSchema,
		execute: async (_toolCallId, params: TodoToolParams) => {
			const action = params.action;

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
						const created = store.batchCreate(params.tasks);
						summary = `✓ Batch created ${created.length} tasks`;
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
						const all = store.getAllTasks();
						const stats = store.getProgressStats();
						summary = `Todo list: ${stats.completed}/${stats.total} completed (${stats.percent}%), ${stats.inProgress} in progress, ${stats.pending} pending.`;
						break;
					}
				}

				const getTasksSnapshot = () =>
					store.getAllTasks().map((t) => ({
						id: t.id,
						parentId: t.parentId,
						subject: t.subject,
						description: t.description,
						status: t.status,
						notes: t.notes,
						// todo-loop.ts compatibility: cancelled items are considered done so they don't block
						completed: t.status === "completed" || t.status === "cancelled",
						done: t.status === "completed" || t.status === "cancelled",
					}));

				return {
					content: [{ type: "text", text: summary }],
					details: {
						action,
						tasks: getTasksSnapshot(),
						stats: store.getProgressStats(),
					},
				};
			} catch (err: any) {
				const getTasksSnapshot = () =>
					store.getAllTasks().map((t) => ({
						id: t.id,
						parentId: t.parentId,
						subject: t.subject,
						description: t.description,
						status: t.status,
						notes: t.notes,
						completed: t.status === "completed" || t.status === "cancelled",
						done: t.status === "completed" || t.status === "cancelled",
					}));

				return {
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

	// --------------------------------------------------------------------------
	// 8.2 Hide tool from LLM when disabled (0 token waste on small tasks)
	// --------------------------------------------------------------------------
	pi.on("before_provider_request", (event: any) => {
		if (config.enabled) return;

		// Filter out 'todo' tool from payload if disabled
		if (event?.payload && typeof event.payload === "object") {
			const payload = event.payload as Record<string, unknown>;
			if (Array.isArray(payload.tools)) {
				payload.tools = payload.tools.filter((t: any) => {
					const name = t?.function?.name ?? t?.name;
					return name !== "todo" && name !== "todos";
				});
			}
		}
	});

	// --------------------------------------------------------------------------
	// 8.3 Lifecycle Events
	// --------------------------------------------------------------------------
	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		restoreFromBranch(ctx);
		syncWidget(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		lastCtx = ctx;
		restoreFromBranch(ctx);
		widgetComponent?.invalidate();
	});

	pi.on("session_shutdown", () => {
		activeModal = null;
		widgetComponent = null;
	});

	// --------------------------------------------------------------------------
	// 8.4 Shortcuts & Commands
	// --------------------------------------------------------------------------
	try {
		pi.registerShortcut(config.shortcut as KeyId, {
			description: "Open Todo Tree modal",
			handler: (ctx) => {
				openModal(ctx);
			},
		});
	} catch {
		// Key parsing fallback
	}

	const commandHandler = async (args: string, ctx: ExtensionContext) => {
		lastCtx = ctx;
		const trimmed = args.trim().toLowerCase();

		if (trimmed === "on" || trimmed === "enable") {
			config.enabled = true;
			saveConfig(config);
			syncWidget(ctx);
			ctx.ui?.notify?.("✓ Todo Tree is now ENABLED (Tool active for LLM, widget visible)", "info");
		} else if (trimmed === "off" || trimmed === "disable") {
			config.enabled = false;
			saveConfig(config);
			syncWidget(ctx);
			ctx.ui?.notify?.("✓ Todo Tree is now DISABLED (Tool hidden from LLM)", "info");
		} else if (trimmed === "toggle") {
			config.enabled = !config.enabled;
			saveConfig(config);
			syncWidget(ctx);
			ctx.ui?.notify?.(`Todo Tree is now ${config.enabled ? "ENABLED" : "DISABLED"}`, "info");
		} else if (trimmed === "open" || trimmed === "modal") {
			openModal(ctx);
		} else if (trimmed === "clear") {
			store.clear();
			ctx.ui?.notify?.("Todo Tree list cleared.", "info");
		} else if (trimmed === "status") {
			const stats = store.getProgressStats();
			const info = [
				`Todo Tree Status:`,
				`• State: ${config.enabled ? "ENABLED" : "DISABLED (default)"}`,
				`• Shortcut: ${config.shortcut}`,
				`• Total Tasks: ${stats.total + stats.cancelled} (${stats.completed} completed, ${stats.inProgress} in progress, ${stats.pending} pending, ${stats.cancelled} cancelled)`,
				`• Progress: ${stats.percent}%`,
			].join("\n");
			ctx.ui?.notify?.(info, "info");
		} else {
			// Default with no arg: toggle or open
			if (!config.enabled) {
				config.enabled = true;
				saveConfig(config);
				syncWidget(ctx);
				ctx.ui?.notify?.("Todo Tree enabled. Use /todo open or click [📋 ] to view.", "info");
			} else {
				openModal(ctx);
			}
		}
	};

	pi.registerCommand("todo", {
		description: "Hierarchical todo list (/todo on|off|toggle|open|status|clear)",
		handler: commandHandler,
	});

	pi.registerCommand("todos", {
		description: "Alias for /todo",
		handler: commandHandler,
	});
}
