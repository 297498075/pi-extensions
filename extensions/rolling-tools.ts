import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { InteractiveMode, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";

/**
 * 通知拦截规则
 *
 * match 支持：精确子串、`*`（匹配全部）或 `regex:<pattern>`。
 * 被拦截的通知仅在界面最下方的 footer 状态行显示，不再写入正文。
 */
interface InterceptNotificationRule {
	match: string;
	suppressToast?: boolean;
}

/**
 * 状态栏增强规则（支持通配符、可配置时长、相对时间戳与自适应语法着色）
 */
interface StatusEnhancementRule {
	keyPattern: string;
	durationMs?: number;
	showRelativeTime?: boolean;
	colorize?: boolean;
}

/**
 * 滚动条与工具静音配置结构
 */
interface RollingToolsConfig {
	enabled: boolean;
	maxRecentTools: number;
	managedTools: string[];
	silencedTools?: string[];
	widgetTools?: string[];
	genericPropertyFallbacks: string[];
	interceptNotifications: InterceptNotificationRule[];
	statusEnhancements?: StatusEnhancementRule[];
	/** 懒加载步长：overlay 中每次向上加载的条数 */
	lazyLoadStep?: number;
	/** 是否在会话间持久化工具滚动历史 */
	persistAcrossSessions?: boolean;
	/**
	 * 不被拦截的通知关键词（例外白名单）。
	 * 含任一关键词的 info 通知仍会进入正文；error / warning 类型始终放行。
	 */
	notificationKeywords?: string[];
	/** 是否剥掉插件在工具行里重复插入的提示头（如 SoL-Pi 的 “Money saved” 行） */
	stripToolNotificationHeaders?: boolean;
	/** 配置结构版本，用于旧版本自动迁移与提示 */
	configVersion?: number;
}

/** 当前配置结构版本。1 = 旧白名单；2 = 通配符全工具；3 = 通知统一收敛到 footer。 */
const CONFIG_VERSION = 3;

/** 通知例外关键词默认值：命中则不拦截（error / warning 类型另行始终放行）。 */
const DEFAULT_NOTIFICATION_KEYWORDS = [
	"error",
	"failed",
	"failure",
	"warning",
	"错误",
	"失败",
	"警告",
	"⚠",
	"❌",
	"🔴",
];

const DEFAULT_CONFIG: RollingToolsConfig = {
	enabled: true,
	maxRecentTools: 3,
	// 默认托管全部工具（含 edit / write / codemode 及任意三方工具）。
	// 具体静音与收录范围由 silencedTools / widgetTools 决定。
	managedTools: ["*"],
	// 默认：所有被托管的工具都从正文中静音（隐藏），仅出现在滚动块中。
	silencedTools: ["*"],
	// 默认：所有被托管的工具都收入滚动块。
	widgetTools: ["*"],
	lazyLoadStep: 10,
	persistAcrossSessions: true,
	configVersion: CONFIG_VERSION,
	genericPropertyFallbacks: [
		"command",
		"path",
		"pattern",
		"query",
		"url",
		"tool",
		"prompt",
		"id",
		"message",
	],
	interceptNotifications: [
		{
			// 默认拦截所有插件的 info 提示：只在界面最下方显示，不再写入正文。
			// error / warning 类型与命中 notificationKeywords 的通知仍会显示。
			match: "*",
			suppressToast: true,
		},
	],
	statusEnhancements: [
		{
			// 默认统一所有插件的 footer 状态行：8 秒后自动消失（可被下一个 tips 替换）。
			keyPattern: "*",
			durationMs: 8000,
			showRelativeTime: false,
			colorize: true,
		},
	],
	notificationKeywords: [...DEFAULT_NOTIFICATION_KEYWORDS],
	stripToolNotificationHeaders: true,
};

interface ToolItem {
	id: string;
	index: number;
	name: string;
	displayName?: string;
	summaryDisplay: string;
	fullPath?: string;
	fullCommand?: string;
	output?: string;
	/** 完整可展示内容（如 edit/write 的 diff 或写入正文），用于 overlay 大窗体 */
	detailContent?: string;
	/** detailContent 的语义标签，用于 overlay 标题 */
	detailKind?: "diff" | "content" | "command" | "output";
	status: "running" | "done" | "error";
	durationMs?: number;
	startTime: number;
}

interface ActiveError {
	toolName: string;
	index: number;
	summary: string;
	message: string;
}

type HeaderStatus =
	| { type: "idle" }
	| { type: "waiting_server"; startTime: number }
	| { type: "thinking"; startTime: number }
	| { type: "thinking_completed"; durationMs: number };

interface WidgetState {
	headerStatus: HeaderStatus;
	recentTools: ToolItem[];
	activeError: ActiveError | null;
	expandedItemId: string | null;
	copyFeedbackMessage: string | null;
	completedMessage: string | null;
}

type LineKind = "header" | "detail_copyable" | "detail_info" | "other";

interface RenderedLineInfo {
	item: ToolItem | null;
	width: number;
	kind: LineKind;
	textToCopy?: string;
	/** 该行最右侧是否存在 [⤢] 展开按钮 */
	hasOverlayButton?: boolean;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** 内存中保留的工具历史上限（widget 只展示最近 maxRecentTools 条，overlay 可浏览全部） */
const HISTORY_MEMORY_LIMIT = 500;
const DYNAMIC_HOOKS_KEY = Symbol.for("pi-rolling-tools.dynamicHooks.v3");

interface DynamicHooksState {
	installed: boolean;
	handleToolRender?: (target: any, width: number, origRender: Function) => string[];
	handleShowExtensionNotify?: (target: any, message: string, type: string | undefined, origFn: Function) => void;
	handleSetExtensionStatus?: (target: any, key: string, text: string | undefined, origFn: Function) => void;
}

const dynamicHooks: DynamicHooksState = (globalThis as any)[DYNAMIC_HOOKS_KEY] ?? {
	installed: false,
};
(globalThis as any)[DYNAMIC_HOOKS_KEY] = dynamicHooks;

/**
 * 跨平台剪贴板复制
 */
function copyToClipboard(text: string): void {
	try {
		if (process.platform === "win32") {
			const proc = spawn("clip");
			proc.stdin.write(text);
			proc.stdin.end();
		} else if (process.platform === "darwin") {
			const proc = spawn("pbcopy");
			proc.stdin.write(text);
			proc.stdin.end();
		} else {
			const proc = spawn("xclip", ["-selection", "clipboard"]);
			proc.stdin.write(text);
			proc.stdin.end();
		}
	} catch {}
}

/**
 * 跨平台打开文件
 */
function openFile(filePath: string): void {
	try {
		if (process.platform === "win32") {
			spawn("cmd", ["/c", "start", "", filePath], { detached: true, stdio: "ignore" }).unref();
		} else if (process.platform === "darwin") {
			spawn("open", [filePath], { detached: true, stdio: "ignore" }).unref();
		} else {
			spawn("xdg-open", [filePath], { detached: true, stdio: "ignore" }).unref();
		}
	} catch {}
}

function truncate(str: string, maxLen = 50): string {
	if (!str) return "";
	if (str.length <= maxLen) return str;
	return str.slice(0, maxLen - 3) + "...";
}

function ensureDirectoryExists(dirPath: string): void {
	try {
		if (!existsSync(dirPath)) {
			mkdirSync(dirPath, { recursive: true });
		}
	} catch {}
}

function getGlobalConfigDir(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(agentDir, "extensions", "rolling-tools");
}

function getGlobalConfigPath(): string {
	return join(getGlobalConfigDir(), "config.json");
}

function getLocalConfigPath(cwd: string): string {
	return join(cwd, ".pi", "rolling-tools.json");
}

function mergeConfig(base: RollingToolsConfig, override: Partial<RollingToolsConfig>): RollingToolsConfig {
	let mergedManagedTools = base.managedTools;
	if (Array.isArray(override.managedTools)) {
		mergedManagedTools = [...override.managedTools];
		// 兼容性适配：Pi 0.86+ 引入了原生 powershell 工具，若旧配置托管了 bash 则自动无缝兼容 powershell
		if (mergedManagedTools.includes("bash") && !mergedManagedTools.includes("powershell")) {
			const bashIdx = mergedManagedTools.indexOf("bash");
			mergedManagedTools.splice(bashIdx + 1, 0, "powershell");
		}
	}

	// 旧版本（无 configVersion 或 < 2）迁移：
	// 旧配置只有 managedTools 白名单，没有 silencedTools / widgetTools。
	// 若直接回退到新默认 ["*"]，会把用户从未选择过的工具（edit/write/三方工具）也一并静音，
	// 属于破坏性行为。因此旧配置下把 silencedTools / widgetTools 继承自旧 managedTools，
	// 保持原有语义不变；用户可通过 /rolling-tools migrate 主动升级到全工具语义。
	const overrideVersion = typeof override.configVersion === "number" ? override.configVersion : 1;
	const isLegacy = overrideVersion < CONFIG_VERSION;
	const hasExplicitSilenced = Array.isArray(override.silencedTools);
	const hasExplicitWidget = Array.isArray(override.widgetTools);

	const legacyManaged = Array.isArray(override.managedTools) ? mergedManagedTools : base.managedTools;

	return {
		enabled: typeof override.enabled === "boolean" ? override.enabled : base.enabled,
		maxRecentTools:
			typeof override.maxRecentTools === "number" && override.maxRecentTools > 0
				? override.maxRecentTools
				: base.maxRecentTools,
		managedTools: mergedManagedTools,
		silencedTools: hasExplicitSilenced
			? [...override.silencedTools!]
			: isLegacy
				? [...legacyManaged]
				: base.silencedTools,
		widgetTools: hasExplicitWidget
			? [...override.widgetTools!]
			: isLegacy
				? [...legacyManaged, "edit", "write"]
				: base.widgetTools,
		genericPropertyFallbacks: Array.isArray(override.genericPropertyFallbacks)
			? [...override.genericPropertyFallbacks]
			: base.genericPropertyFallbacks,
		interceptNotifications: Array.isArray(override.interceptNotifications)
			? [...override.interceptNotifications]
			: base.interceptNotifications,
		statusEnhancements: Array.isArray(override.statusEnhancements)
			? [...override.statusEnhancements]
			: base.statusEnhancements,
		lazyLoadStep:
			typeof override.lazyLoadStep === "number" && override.lazyLoadStep > 0
				? override.lazyLoadStep
				: base.lazyLoadStep,
		persistAcrossSessions:
			typeof override.persistAcrossSessions === "boolean"
				? override.persistAcrossSessions
				: base.persistAcrossSessions,
		notificationKeywords: Array.isArray(override.notificationKeywords)
			? [...override.notificationKeywords]
			: base.notificationKeywords,
		stripToolNotificationHeaders:
			typeof override.stripToolNotificationHeaders === "boolean"
				? override.stripToolNotificationHeaders
				: base.stripToolNotificationHeaders,
		configVersion: CONFIG_VERSION,
	};
}

/**
 * 读取并合并配置（默认值 -> 全局配置 -> 本地配置）
 */
interface LoadConfigResult {
	config: RollingToolsConfig;
	/** 是否检测到旧版本配置并做了兼容性迁移（用于向用户展示一次性提示） */
	legacyDetected: boolean;
	/** 检测到旧配置的文件路径（便于提示用户去修改） */
	legacyPath?: string;
	/** 检测到的旧配置版本（用于生成对应版本的升级提示） */
	legacyVersion?: number;
}

function loadConfig(cwd: string): LoadConfigResult {
	let config: RollingToolsConfig = { ...DEFAULT_CONFIG };
	let legacyDetected = false;
	let legacyPath: string | undefined;
	let legacyVersion: number | undefined;

	const globalPath = getGlobalConfigPath();
	try {
		if (existsSync(globalPath)) {
			const raw = readFileSync(globalPath, "utf-8");
			const parsed = JSON.parse(raw);
			const v = typeof parsed?.configVersion === "number" ? parsed.configVersion : 1;
			if (v < CONFIG_VERSION) {
				legacyDetected = true;
				legacyPath = globalPath;
				legacyVersion = v;
			}
			config = mergeConfig(config, parsed);
		} else {
			ensureDirectoryExists(dirname(globalPath));
			writeFileSync(globalPath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
		}
	} catch (e) {
		console.error("[rolling-tools] Failed to load global config:", e);
	}

	const localPath = getLocalConfigPath(cwd);
	try {
		if (existsSync(localPath)) {
			const raw = readFileSync(localPath, "utf-8");
			const parsed = JSON.parse(raw);
			const v = typeof parsed?.configVersion === "number" ? parsed.configVersion : 1;
			if (v < CONFIG_VERSION) {
				legacyDetected = true;
				legacyPath = localPath;
				legacyVersion = v;
			}
			config = mergeConfig(config, parsed);
		}
	} catch (e) {
		console.error("[rolling-tools] Failed to load local config:", e);
	}

	return { config, legacyDetected, legacyPath, legacyVersion };
}

/**
 * 将磁盘上的配置文件升级到最新结构版本（全工具语义）。
 * 保留用户已有的其他字段，仅将 managedTools / silencedTools / widgetTools 设为 ["*"]
 * 并写入 configVersion。优先升级本地配置（若存在），否则升级全局配置。
 */
function migrateConfigToLatest(cwd: string): {
	ok: boolean;
	config?: RollingToolsConfig;
	path?: string;
	error?: string;
} {
	try {
		const localPath = getLocalConfigPath(cwd);
		const globalPath = getGlobalConfigPath();
		const targetPath = existsSync(localPath) ? localPath : globalPath;

		let existing: Record<string, unknown> = {};
		if (existsSync(targetPath)) {
			existing = JSON.parse(readFileSync(targetPath, "utf-8")) as Record<string, unknown>;
		}

		const upgraded: Record<string, unknown> = {
			...existing,
			managedTools: ["*"],
			silencedTools: ["*"],
			widgetTools: ["*"],
			interceptNotifications: [{ match: "*", suppressToast: true }],
			statusEnhancements: [
				{ keyPattern: "*", durationMs: 8000, showRelativeTime: false, colorize: true },
			],
			notificationKeywords: [...DEFAULT_NOTIFICATION_KEYWORDS],
			stripToolNotificationHeaders: true,
			configVersion: CONFIG_VERSION,
		};
		if (typeof upgraded.lazyLoadStep !== "number") upgraded.lazyLoadStep = DEFAULT_CONFIG.lazyLoadStep;
		if (typeof upgraded.persistAcrossSessions !== "boolean") {
			upgraded.persistAcrossSessions = DEFAULT_CONFIG.persistAcrossSessions;
		}
		// 清理已废弃字段（v2 的 rollIntoWidget 等）
		if (Array.isArray(upgraded.interceptNotifications)) {
			upgraded.interceptNotifications = (upgraded.interceptNotifications as any[]).map((r) => {
				if (r && typeof r === "object" && "rollIntoWidget" in r) {
					const { rollIntoWidget, ...rest } = r as any;
					return rest;
				}
				return r;
			});
		}
		delete upgraded.solPiSavings;

		ensureDirectoryExists(dirname(targetPath));
		writeFileSync(targetPath, JSON.stringify(upgraded, null, 2), "utf-8");

		const reloaded = loadConfig(cwd);
		return { ok: true, config: reloaded.config, path: targetPath };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * 构造旧配置迁移提示文案。
 * - v1 → v2：旧白名单语义，保持原行为，提示如何切到全工具。
 * - v2 → v3：通知统一收敛到 footer，提示新字段与默认值（不写配置文件也可用）。
 */
function buildLegacyNotice(legacyPath?: string, fromVersion = 1): string {
	const where = legacyPath ? `\n• 配置文件: ${legacyPath}` : "";

	if (fromVersion < 2) {
		return [
			"rolling-tools: 检测到旧版配置，已自动保持原有行为（未强制切换为全工具）。",
			"新版默认会将所有工具（含 edit / write / codemode / 三方工具）收入滚动块并隐藏正文。",
			"如需启用新语义，请将配置中的 managedTools / silencedTools / widgetTools 设为 [\"*\"]，",
			`或执行 /rolling-tools migrate 自动升级。${where}`,
		].join("\n");
	}

	// v2 → v3
	return [
		"rolling-tools: 检测到 v2 配置，已按 v3 新默认运行（旧字段自动忽略，不写配置文件也可用）。",
		"v3 变化：",
		"• 所有插件的 info 提示只在界面最下方显示，8 秒后自动消失（error / warning 与关键词例外仍保留）",
		"• 工具行里重复的 “Money saved” 提示头已自动隐藏",
		"如需自定义，可在配置文件中添加以下字段（全部可选，省略即用默认值）：",
		'  "interceptNotifications": [{ "match": "*", "suppressToast": true }]',
		'  "statusEnhancements": [{ "keyPattern": "*", "durationMs": 8000, "showRelativeTime": false, "colorize": true }]',
		'  "notificationKeywords": ["error", "failed", "failure", "warning", "错误", "失败", "警告", "⚠", "❌", "🔴"]',
		'  "stripToolNotificationHeaders": true',
		`或执行 /rolling-tools migrate 写入完整默认配置。${where}`,
	].join("\n");
}

/**
 * 规则通配符匹配（支持精确匹配、前缀/后缀星号及中间通配）
 */
function matchesToolRule(rule: string, toolName: string): boolean {
	if (!rule || !toolName) return false;
	if (rule === "*" || rule === toolName) return true;
	if (rule.endsWith("*") && !rule.slice(0, -1).includes("*")) {
		return toolName.startsWith(rule.slice(0, -1));
	}
	if (rule.startsWith("*") && !rule.slice(1).includes("*")) {
		return toolName.endsWith(rule.slice(1));
	}
	if (rule.includes("*")) {
		const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
		return new RegExp(`^${escaped}$`).test(toolName);
	}
	return false;
}

function isManagedTool(toolName: string, rules: string[]): boolean {
	return rules.some((rule) => matchesToolRule(rule, toolName));
}

function shouldSilenceInTranscript(toolName: string, config: RollingToolsConfig): boolean {
	const rules = config.silencedTools ?? config.managedTools;
	return isManagedTool(toolName, rules);
}

function shouldIncludeInWidget(toolName: string, config: RollingToolsConfig): boolean {
	const rules = config.widgetTools ?? [...config.managedTools, "edit", "write"];
	return isManagedTool(toolName, rules);
}

/**
 * 通用属性启发式推导
 */
function extractGenericParameters(
	input: any,
	cwd: string,
	propertyPriority: string[],
): { summary: string; fullPath?: string; fullCommand?: string } {
	if (!input || typeof input !== "object") {
		return { summary: "" };
	}

	let summary = "";
	let fullPath: string | undefined;
	let fullCommand: string | undefined;

	for (const prop of propertyPriority) {
		const val = input[prop];
		if (val === undefined || val === null) continue;

		if (typeof val === "string") {
			const trimmed = val.trim();
			if (!trimmed) continue;

			if (prop === "path" || prop === "file" || prop === "filePath") {
				fullPath = resolve(cwd, trimmed);
				summary = `${prop}: ${trimmed}`;
			} else if (prop === "command" || prop === "cmd") {
				fullCommand = trimmed;
				const firstLine = trimmed.split("\n")[0] || "";
				summary = firstLine + (trimmed.includes("\n") ? " ↵" : "");
			} else {
				summary = `${prop}: ${trimmed}`;
			}
			break;
		} else if (typeof val === "number" || typeof val === "boolean") {
			summary = `${prop}: ${val}`;
			break;
		}
	}

	if (!fullPath && typeof input.path === "string" && input.path.trim()) {
		fullPath = resolve(cwd, input.path.trim());
	}
	if (!fullCommand && typeof input.command === "string" && input.command.trim()) {
		fullCommand = input.command.trim();
	}

	return { summary, fullPath, fullCommand };
}

/**
 * 提取简短摘要、完整路径与完整命令
 */
function extractSummaryAndMetadata(
	name: string,
	input: any,
	cwd: string,
	config: RollingToolsConfig,
): {
	summaryDisplay: string;
	fullPath?: string;
	fullCommand?: string;
	displayName?: string;
	detailContent?: string;
	detailKind?: "diff" | "content" | "command" | "output";
} {
	if (!input || typeof input !== "object") {
		return { summaryDisplay: "" };
	}

	// 1. 内置命令：bash 与 powershell
	if (name === "bash" || name === "powershell") {
		const rawCmd = typeof input.command === "string" ? input.command : "";
		const firstLine = rawCmd.split("\n")[0] || "";
		const isMultiline = rawCmd.includes("\n");
		const display = truncate(firstLine, 55) + (isMultiline ? " ↵" : "");
		return { summaryDisplay: display, fullCommand: rawCmd };
	}

	// 1.5 codemode：脚本全文存入 detailContent，便于在 overlay 中完整查看
	if (name === "codemode") {
		const code = typeof input.code === "string" ? input.code : "";
		if (!code) return { summaryDisplay: "" };
		const firstLine = code.split("\n").find((l: string) => l.trim().length > 0) || "";
		const lineCount = code.split("\n").length;
		return {
			summaryDisplay: `${truncate(firstLine.trim(), 42)} (${lineCount} lines)`,
			detailContent: code,
			detailKind: "content",
		};
	}

	// 2. 内置文件工具：read / edit / write
	if (name === "read" || name === "edit" || name === "write") {
		const rawPath = typeof input.path === "string" ? input.path : "";
		if (!rawPath) return { summaryDisplay: "" };
		const absPath = resolve(cwd, rawPath);
		// write：正文即待写入内容，可在 overlay 中完整展示
		if (name === "write" && typeof input.content === "string") {
			const lineCount = input.content.split("\n").length;
			return {
				summaryDisplay: `${truncate(rawPath, 40)} (+${lineCount} lines)`,
				fullPath: absPath,
				detailContent: input.content,
				detailKind: "content",
			};
		}
		// edit：diff 在 tool_result.details.diff 中回填，这里先给出摘要
		if (name === "edit") {
			return { summaryDisplay: truncate(rawPath, 50), fullPath: absPath, detailKind: "diff" };
		}
		return { summaryDisplay: truncate(rawPath, 50), fullPath: absPath };
	}

	// 3. 内置搜索：grep
	if (name === "grep") {
		const scope = input.path ? resolve(cwd, input.path) : cwd;
		const display = `"${input.pattern || ""}" in ${truncate(input.path || ".", 30)}`;
		return { summaryDisplay: display, fullPath: scope };
	}

	// 4. 内置文件查找：find
	if (name === "find") {
		return { summaryDisplay: truncate(input.pattern || "", 50) };
	}

	// 5. 内置目录列表：ls
	if (name === "ls") {
		const dirPath = input.path ? resolve(cwd, input.path) : cwd;
		return { summaryDisplay: truncate(input.path || ".", 40), fullPath: dirPath };
	}

	// 6. SoL-Pi: obs_recall
	if (name === "obs_recall") {
		const id = typeof input.id === "string" ? input.id : "";
		const offset = typeof input.offset === "number" ? ` @${input.offset}` : "";
		return { summaryDisplay: truncate(`id: ${id}${offset}`, 50) };
	}

	// 7. SoL-Pi: update_plan
	if (name === "update_plan") {
		const stepCount = Array.isArray(input.steps) ? input.steps.length : 0;
		const activeGoal = Array.isArray(input.steps)
			? (input.steps.find((s: any) => s.status === "in_progress")?.goal || "")
			: "";
		const display = activeGoal
			? `${stepCount} steps · ${truncate(activeGoal, 35)}`
			: `${stepCount} steps`;
		return { summaryDisplay: display };
	}

	// 8. Rider MCP 工具：rider_execute_tool
	if (name === "rider_execute_tool") {
		const cmd = typeof input.command === "string" ? input.command : "";
		const root = typeof input.rootFolder === "string" ? input.rootFolder : undefined;
		return {
			summaryDisplay: truncate(cmd, 50),
			fullCommand: cmd,
			fullPath: root,
		};
	}

	// 9. 通用 MCP 统一网关：mcp
	if (name === "mcp") {
		const server = typeof input.server === "string" ? input.server : "";
		const targetTool = typeof input.tool === "string" ? input.tool : "";
		const action = typeof input.action === "string" ? input.action : "";

		let innerSummary = "";
		let fullCmd: string | undefined;
		let fullPth: string | undefined;
		let innerDetail: string | undefined;
		let innerDetailKind: "diff" | "content" | "command" | "output" | undefined;

		if (input.args && typeof input.args === "object") {
			const inner = extractSummaryAndMetadata(targetTool || "inner", input.args, cwd, config);
			innerSummary = inner.summaryDisplay ? ` (${inner.summaryDisplay})` : "";
			fullCmd = inner.fullCommand;
			fullPth = inner.fullPath;
			innerDetail = inner.detailContent;
			innerDetailKind = inner.detailKind;
		}

		let prefix = "";
		if (server && targetTool) {
			prefix = `[${server}] ${targetTool}`;
		} else if (targetTool) {
			prefix = targetTool;
		} else if (action) {
			prefix = `action: ${action}`;
		}

		return {
			displayName: prefix || "mcp",
			summaryDisplay: truncate(prefix + innerSummary, 55),
			fullCommand: fullCmd,
			fullPath: fullPth,
			detailContent: innerDetail,
			detailKind: innerDetailKind,
		};
	}

	// 10. 命名空间 MCP 工具：mcp__<server>__<tool>
	if (name.startsWith("mcp__")) {
		const parts = name.slice(5).split("__");
		const server = parts[0] || "";
		const tool = parts.slice(1).join(":") || "";
		const niceName = server && tool ? `${server}:${tool}` : name;

		const { summary, fullPath, fullCommand } = extractGenericParameters(
			input,
			cwd,
			config.genericPropertyFallbacks,
		);
		return {
			displayName: niceName,
			summaryDisplay: summary ? truncate(summary, 50) : "",
			fullPath,
			fullCommand,
		};
	}

	// 11. 通用第三方工具回退机制
	const { summary, fullPath, fullCommand } = extractGenericParameters(
		input,
		cwd,
		config.genericPropertyFallbacks,
	);
	// 为三方工具附带可展示的长文本内容（如 subagent 的 prompt、recall 的 id 等）
	const genericDetail = pickGenericDetailContent(input);
	return {
		summaryDisplay: summary ? truncate(summary, 50) : truncate(JSON.stringify(input), 50),
		fullPath,
		fullCommand,
		detailContent: genericDetail?.content ?? fullCommand,
		detailKind: genericDetail?.kind ?? (fullCommand ? "command" : undefined),
	};
}

/**
 * 从任意三方工具输入中挑选适合在 overlay 中完整展示的长文本字段。
 * 仅做纯读取，不修改输入。
 */
function pickGenericDetailContent(
	input: any,
): { content: string; kind: "diff" | "content" | "command" | "output" } | undefined {
	if (!input || typeof input !== "object") return undefined;
	const candidates: Array<{ key: string; kind: "diff" | "content" | "command" | "output" }> = [
		{ key: "prompt", kind: "content" },
		{ key: "content", kind: "content" },
		{ key: "command", kind: "command" },
		{ key: "message", kind: "content" },
		{ key: "query", kind: "content" },
	];
	for (const { key, kind } of candidates) {
		const val = input[key];
		if (typeof val === "string" && val.trim().length > 0) {
			return { content: val, kind };
		}
	}
	return undefined;
}

/**
 * 会话持久化：写入滚动历史的快照（不参与 LLM 上下文）。
 * 只保留最近 N 条，并裁剪过长字段，避免 session 文件膨胀。
 */
const HISTORY_ENTRY_TYPE = "rolling-tools-history";
const PERSIST_MAX_ITEMS = 200;
const PERSIST_MAX_FIELD = 20000;

function serializeHistory(items: ToolItem[], total: number): { total: number; items: any[] } {
	const trimmed = items.slice(-PERSIST_MAX_ITEMS).map((t) => ({
		id: t.id,
		index: t.index,
		name: t.name,
		displayName: t.displayName,
		summaryDisplay: t.summaryDisplay,
		fullPath: t.fullPath,
		fullCommand: t.fullCommand ? t.fullCommand.slice(0, PERSIST_MAX_FIELD) : undefined,
		output: t.output ? t.output.slice(0, PERSIST_MAX_FIELD) : undefined,
		detailContent: t.detailContent ? t.detailContent.slice(0, PERSIST_MAX_FIELD) : undefined,
		detailKind: t.detailKind,
		status: t.status,
		durationMs: t.durationMs,
		startTime: t.startTime,
	}));
	return { total, items: trimmed };
}

function deserializeHistory(data: any): { items: ToolItem[]; total: number } | null {
	if (!data || !Array.isArray(data.items)) return null;
	const items: ToolItem[] = data.items.map((raw: any) => ({
		id: String(raw.id ?? ""),
		index: Number(raw.index ?? 0),
		name: String(raw.name ?? ""),
		displayName: raw.displayName,
		summaryDisplay: String(raw.summaryDisplay ?? ""),
		fullPath: raw.fullPath,
		fullCommand: raw.fullCommand,
		output: raw.output,
		detailContent: raw.detailContent,
		detailKind: raw.detailKind,
		status: raw.status === "error" ? "error" : raw.status === "running" ? "done" : "done",
		durationMs: typeof raw.durationMs === "number" ? raw.durationMs : undefined,
		startTime: Number(raw.startTime ?? Date.now()),
	}));
	return { items, total: Number(data.total ?? items.length) };
}

/**
 * 匹配通知拦截规则。
 * 支持 `*`（全部）、精确子串与 `regex:<pattern>`。
 */
function matchNotificationRule(
	message: string,
	rules: InterceptNotificationRule[],
): InterceptNotificationRule | undefined {
	for (const rule of rules) {
		if (!rule || !rule.match) continue;
		if (rule.match === "*") return rule;
		if (rule.match.startsWith("regex:")) {
			try {
				const reg = new RegExp(rule.match.slice(6));
				if (reg.test(message)) return rule;
			} catch {}
		} else if (message.includes(rule.match)) {
			return rule;
		}
	}
	return undefined;
}

/**
 * 判断一条通知是否属于“重要信息”，重要信息不被拦截。
 * - error / warning 类型：pi 会分流到 showError / showWarning，始终放行。
 * - info 类型但命中关键词（如 error / failed / 失败 / 警告）：放行。
 */
function isImportantNotification(
	message: string,
	type: string | undefined,
	keywords: string[] | undefined,
): boolean {
	if (type === "error" || type === "warning") return true;
	const lower = message.toLowerCase();
	return (keywords ?? []).some((k) => k && lower.includes(k.toLowerCase()));
}

/**
 * 原生动态组件：支持点击展开详情、滚动展示与剪贴板复制
 */
class RollingToolsWidgetComponent implements Component {
	private tui: any;
	private theme: any;
	private state: WidgetState;
	private lineMap: RenderedLineInfo[] = [];
	private copyFeedbackTimer: any = null;
	/** 点击 [⤢] 按钮时的回调，由外部注入以打开 overlay 大窗体 */
	private onOpenOverlay: ((item?: ToolItem) => void) | null = null;
	/** widget 中最多展示的条目数（overlay 仍可浏览全部历史） */
	private displayLimit: number;

	constructor(
		tui: any,
		theme: any,
		state: WidgetState,
		onOpenOverlay?: (item?: ToolItem) => void,
		displayLimit = 3,
	) {
		this.tui = tui;
		this.theme = theme;
		this.state = state;
		this.onOpenOverlay = onOpenOverlay ?? null;
		this.displayLimit = Math.max(1, displayLimit);
	}

	render(width: number): string[] {
		this.lineMap = [];
		const lines: string[] = [];
		const theme = this.theme;
		const renderWidth = Math.max(20, width);

		const pushLine = (
			text: string,
			item: ToolItem | null = null,
			kind: LineKind = "other",
			textToCopy?: string,
			hasOverlayButton = false,
		) => {
			lines.push(text);
			this.lineMap.push({
				item,
				width: visibleWidth(text),
				kind,
				textToCopy,
				hasOverlayButton,
			});
		};

		// 1. 常驻状态行（等待服务器响应 ➔ 思考中 ➔ 思考完成，共用一行平滑过渡）
		// 该行始终存在，作为滚动块的固定头部；[⤢] 大窗体按钮固定显示在本行最右侧。
		{
			const button = theme.fg("accent", "[⤢]");
			let statusText: string;
			if (this.state.headerStatus.type === "waiting_server") {
				const elapsedSec = ((Date.now() - this.state.headerStatus.startTime) / 1000).toFixed(1);
				const spinner = SPINNER_FRAMES[Math.floor(Date.now() / 150) % SPINNER_FRAMES.length];
				statusText = ` ${theme.fg("accent", "🌐")} ${theme.bold(theme.fg("toolTitle", `${spinner} 等待服务器响应...`))} ${theme.fg("muted", `(${elapsedSec}s)`)}`;
			} else if (this.state.headerStatus.type === "thinking") {
				const elapsedSec = ((Date.now() - this.state.headerStatus.startTime) / 1000).toFixed(1);
				const spinner = SPINNER_FRAMES[Math.floor(Date.now() / 150) % SPINNER_FRAMES.length];
				statusText = ` ${theme.fg("accent", "💡")} ${theme.bold(theme.fg("toolTitle", `${spinner} 思考中...`))} ${theme.fg("muted", `(${elapsedSec}s)`)}`;
			} else if (this.state.headerStatus.type === "thinking_completed") {
				const elapsedSec = (this.state.headerStatus.durationMs / 1000).toFixed(1);
				statusText = ` ${theme.fg("accent", "💡")} ${theme.bold(theme.fg("toolTitle", "思考完成"))} ${theme.fg("muted", `(${elapsedSec}s)`)}`;
			} else {
				statusText = ` ${theme.fg("accent", "•")} ${theme.fg("muted", "就绪")}`;
			}
			const pad = Math.max(1, renderWidth - visibleWidth(statusText) - visibleWidth(button) - 1);
			pushLine(`${statusText}${' '.repeat(pad)}${button}`, null, "header", undefined, true);
		}

		// 2. 滚动工具列表（widget 只展示最近 displayLimit 条，完整历史在 overlay 中查看）
		const visibleTools = this.state.recentTools.slice(-this.displayLimit);
		for (const t of visibleTools) {
			const isExpanded = this.state.expandedItemId === t.id;
			let icon = theme.fg("accent", "⏳");
			if (t.status === "done") icon = theme.fg("success", "✓");
			if (t.status === "error") icon = theme.fg("error", "✗");

			const arrow = isExpanded ? theme.fg("accent", "▾") : theme.fg("dim", "▸");
			const badge = theme.fg("dim", `[${t.index}]`);
			const labelName = t.displayName || t.name;
			const name = theme.bold(theme.fg("toolTitle", labelName));
			const summary = theme.fg("dim", t.summaryDisplay);
			const time = t.durationMs !== undefined ? theme.fg("muted", ` (${t.durationMs}ms)`) : "";

			pushLine(` ${icon} ${arrow} ${badge} ${name} ${summary}${time}`, t, "header");

			// 点击展开详情：展示完整路径/完整命令以及输出结果
			if (isExpanded) {
				if (t.fullPath) {
					pushLine(`   ${theme.fg("accent", `↳ ${t.fullPath}`)}`, t, "detail_copyable", t.fullPath);
				} else if (t.fullCommand) {
					const cmdLines = t.fullCommand.split("\n").slice(0, 8);
					for (const cmdLine of cmdLines) {
						pushLine(`   ${theme.fg("accent", `↳ $ ${cmdLine}`)}`, t, "detail_copyable", t.fullCommand);
					}
					if (t.fullCommand.split("\n").length > 8) {
						pushLine(
							`   ${theme.fg("dim", `  ... (${t.fullCommand.split("\n").length - 8} more command lines)`)}`,
							t,
							"detail_info",
						);
					}
				}

				if (t.output !== undefined && t.output !== null) {
					const cleanOutput = t.output.trim();
					if (cleanOutput.length === 0) {
						pushLine(`   ${theme.fg("muted", "↳ (no output)")}`, t, "detail_info");
					} else {
						const outLines = cleanOutput.split("\n");
						const maxShow = 6;
						const shown = outLines.slice(0, maxShow);
						for (const outLine of shown) {
							pushLine(
								`   ${theme.fg("muted", `↳ ${truncate(outLine, 80)}`)}`,
								t,
								"detail_copyable",
								cleanOutput,
							);
						}
						if (outLines.length > maxShow) {
							pushLine(
								`   ${theme.fg("dim", `  ... (${outLines.length - maxShow} more output lines)`)}`,
								t,
								"detail_info",
							);
						}
					}
				}
			}
		}

		// 3. 复制成功反馈（仅在 Widget 内部就地显示，绝对 0 污染）
		if (this.state.copyFeedbackMessage) {
			pushLine(`   ${theme.fg("success", `↳ ${this.state.copyFeedbackMessage}`)}`);
		}

		// 4. 独立临时报错 Alert 块
		if (this.state.activeError) {
			const errHeader = ` ${theme.fg("error", "🔴")} ${theme.bold(theme.fg("error", `[Error in #${this.state.activeError.index} ${this.state.activeError.toolName}]`))} ${theme.fg("dim", this.state.activeError.summary)}`;
			const errBody = `    ${theme.fg("error", truncate(this.state.activeError.message.replace(/\r?\n/g, " "), 100))}`;
			pushLine(errHeader);
			pushLine(errBody);
		}

		// 5. 主回复完成标识（仅在整个 Agent 回复完全生成完毕后才附带显示）
		if (this.state.completedMessage) {
			pushLine(` ${theme.fg("success", `✓ ${this.state.completedMessage}`)}`);
		}

		return lines;
	}

	private triggerCopy(textToCopy: string, label: string): void {
		copyToClipboard(textToCopy);
		this.state.copyFeedbackMessage = `✓ 已复制${label}至剪贴板: ${truncate(textToCopy, 45)}`;

		if (this.copyFeedbackTimer) clearTimeout(this.copyFeedbackTimer);
		this.copyFeedbackTimer = setTimeout(() => {
			this.state.copyFeedbackMessage = null;
			this.tui?.requestRender?.();
		}, 2500);

		this.tui?.requestRender?.();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const lineEntry = event.y >= 0 && event.y < this.lineMap.length ? this.lineMap[event.y] : null;
		const isWithinText = Boolean(lineEntry && event.x >= 0 && event.x <= lineEntry.width);
		const targetItem = isWithinText ? lineEntry?.item : null;

		if (event.type === "move") {
			return undefined;
		}

		if (event.type === "click" && isWithinText) {
			// 0. 点击最右侧 [⤢] 按钮：打开 overlay 大窗体
			if (lineEntry?.hasOverlayButton && event.button !== "right") {
				const buttonStart = Math.max(0, lineEntry.width - 4);
				if (event.x >= buttonStart) {
					this.onOpenOverlay?.(targetItem ?? undefined);
					return { handled: true };
				}
			}

			// 1. 点击了可复制行（包括 SoL-Pi 节省行或工具详情输出）
			if (lineEntry?.kind === "detail_copyable" && lineEntry.textToCopy) {
				const label = targetItem?.fullPath
					? "完整路径"
					: targetItem?.fullCommand
						? "完整命令"
						: targetItem
							? "输出内容"
							: "详情信息";
				this.triggerCopy(lineEntry.textToCopy, label);
				return { handled: true };
			}

			if (targetItem) {
				// 2. Ctrl + 左键：打开文件
				if (event.ctrl && targetItem.fullPath) {
					openFile(targetItem.fullPath);
					return { handled: true };
				}

				// 3. 右键点击：复制内容
				if (event.button === "right") {
					const textToCopy =
						lineEntry?.textToCopy ||
						targetItem.fullPath ||
						targetItem.fullCommand ||
						targetItem.output ||
						targetItem.summaryDisplay;
					if (textToCopy) {
						const label = targetItem.fullPath ? "完整路径" : targetItem.fullCommand ? "完整命令" : "内容";
						this.triggerCopy(textToCopy, label);
						return { handled: true };
					}
				}

				// 4. 左键点击标题行：切换展开/折叠状态
				this.state.expandedItemId = this.state.expandedItemId === targetItem.id ? null : targetItem.id;
				this.tui?.requestRender?.();
				return { handled: true };
			}
		}

		return undefined;
	}

	invalidate(): void {}
}

/**
 * 工具历史大窗体（overlay dialog）。
 *
 * 设计要点：
 * - 在 overlay 中承载完整工具历史，支持鼠标滚轮滚动。
 * - 向上滚动到顶部时，自动再加载 `step` 条更早的历史（懒加载）。
 * - 选中某条工具后，右侧详情区展示完整内容（edit diff / write 正文 / 命令 / 输出）。
 *
 * 注意：overlay 组件会收到 `wheel` 事件（TUI 在 routeWheel 之前先 dispatchMouseToOverlay），
 * 因此这里可以原生实现滚轮与“上滑到顶加载更多”。
 */
class ToolHistoryOverlayComponent implements Component {
	private tui: any;
	private theme: any;
	private allItems: ToolItem[];
	private step: number;
	private onClose: () => void;
	private requestRender: () => void;

	/** 当前已加载（可见）的条目数，从最新往回数 */
	private loadedCount: number;
	/** 当前选中的条目下标（相对于 allItems） */
	private selectedIndex: number;
	/** 详情区滚动偏移 */
	private detailScrollTop = 0;
	/** 列表区滚动偏移（已加载条目内的行偏移） */
	private listScrollTop = 0;
	/** 渲染缓存：用于鼠标命中检测 */
	private listRowMap: Array<{ row: number; index: number }> = [];
	private listViewportHeight = 1;
	private detailLineCount = 0;
	private detailViewportHeight = 1;
	private lastWidth = 80;
	/** 是否自动跟随最新条目（用户手动选择后关闭） */
	private followTail = true;
	/** 复制反馈（就地显示在底部提示行） */
	private copyFeedback: string | null = null;
	private copyFeedbackTimer: any = null;
	/** 居中方框在 overlay 内的几何位置（用于区分框内/框外点击） */
	private boxTop = 0;
	private boxLeft = 0;
	private boxWidth = 0;
	private boxHeight = 0;

	constructor(
		tui: any,
		theme: any,
		items: ToolItem[],
		step: number,
		onClose: () => void,
		requestRender: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.allItems = items;
		this.step = Math.max(1, step);
		this.onClose = onClose;
		this.requestRender = requestRender;
		// 初始只加载最近 step 条（懒加载起点）
		this.loadedCount = Math.min(this.step, items.length);
		this.selectedIndex = items.length > 0 ? items.length - 1 : -1;
	}

	/**
	 * 外部（agent 运行中）调用：同步最新历史。
	 * - 若用户未手动选择（followTail），自动选中最新条目。
	 * - 若用户未手动锁定已加载范围，自动扩展以包含新条目。
	 */
	refresh(): void {
		const total = this.allItems.length;
		if (total === 0) return;
		if (this.followTail) {
			this.selectedIndex = total - 1;
			this.detailScrollTop = 0;
		}
		// 新条目会追加到末尾，已加载窗口从末尾往前数，因此无需改动 loadedCount
		if (this.loadedCount > total) this.loadedCount = total;
		this.requestRender();
	}

	/** 已加载条目在 allItems 中的起始下标 */
	private get loadedStart(): number {
		return Math.max(0, this.allItems.length - this.loadedCount);
	}

	/** 外部指定选中项（用于从某一工具直接打开大窗体） */
	selectIndex(index: number): void {
		if (index < 0 || index >= this.allItems.length) return;
		this.selectedIndex = index;
		this.detailScrollTop = 0;
		this.followTail = index === this.allItems.length - 1;
		if (index < this.loadedStart) {
			this.loadedCount = Math.min(this.allItems.length, this.allItems.length - index);
		}
		const relIndex = index - this.loadedStart;
		if (relIndex < this.listScrollTop) this.listScrollTop = relIndex;
		if (relIndex >= this.listScrollTop + this.listViewportHeight) {
			this.listScrollTop = relIndex - this.listViewportHeight + 1;
		}
		this.requestRender();
	}

	private get loadedItems(): ToolItem[] {
		return this.allItems.slice(this.loadedStart);
	}

	/** 再加载 step 条更早的历史；返回是否真的加载了 */
	private loadMore(): boolean {
		if (this.loadedCount >= this.allItems.length) return false;
		this.loadedCount = Math.min(this.allItems.length, this.loadedCount + this.step);
		return true;
	}

	private get selectedItem(): ToolItem | undefined {
		return this.selectedIndex >= 0 ? this.allItems[this.selectedIndex] : undefined;
	}

	private statusIcon(t: ToolItem): string {
		const theme = this.theme;
		if (t.status === "done") return theme.fg("success", "✓");
		if (t.status === "error") return theme.fg("error", "✗");
		return theme.fg("accent", "⏳");
	}

	render(width: number): string[] {
		this.lastWidth = width;
		const theme = this.theme;
		this.listRowMap = [];

		const termRows = Math.max(10, this.tui?.terminal?.rows ?? 30);
		const termCols = Math.max(30, width);

		// 方框尺寸：占终端 90% 宽 / 80% 高（与 overlayOptions 一致），并居中
		const boxW = Math.max(30, Math.min(termCols - 2, Math.floor(termCols * 0.9)));
		const boxH = Math.max(8, Math.min(termRows - 2, Math.floor(termRows * 0.8)));
		const boxTop = Math.max(0, Math.floor((termRows - boxH) / 2));
		const boxLeft = Math.max(0, Math.floor((termCols - boxW) / 2));
		this.boxTop = boxTop;
		this.boxLeft = boxLeft;
		this.boxWidth = boxW;
		this.boxHeight = boxH;

		const borderColor = (s: string) => theme.fg("accent", s);
		const inner = Math.max(20, boxW - 4);
		const listWidth = Math.max(20, Math.floor(inner * 0.45));
		const detailWidth = Math.max(20, inner - listWidth - 3);

		const total = this.allItems.length;
		const loaded = this.loadedCount;
		const canLoadMore = loaded < total;
		const titleHint = canLoadMore
			? theme.fg("dim", `↑ 上滑到顶加载更多 (${loaded}/${total})`)
			: theme.fg("dim", `已全部加载 (${total})`);

		// 方框内部行（不含外框）
		const boxLines: string[] = [];
		const titleText = ` ${theme.bold(theme.fg("toolTitle", "工具历史"))}  ${titleHint}   ${theme.fg("muted", "[Esc/点击外部 关闭] · 点击左侧行复制详情")}`;
		const titlePad = Math.max(0, boxW - 2 - visibleWidth(titleText));
		boxLines.push(`${borderColor("┌")}${titleText}${' '.repeat(titlePad)}${borderColor("┐")}`);
		boxLines.push(`${borderColor("├")}${theme.fg("dim", "─".repeat(boxW - 2))}${borderColor("┤")}`);

		// 内容区高度 = 方框高 - 标题(1) - 标题分隔(1) - 底部分隔(1) - 提示(1) - 底边(1)
		const viewportHeight = Math.max(3, boxH - 5);
		this.listViewportHeight = viewportHeight;
		this.detailViewportHeight = viewportHeight;

		// 左栏：已加载的工具列表（带滚动偏移）
		const loadedItems = this.loadedItems;
		const listStart = Math.min(this.listScrollTop, Math.max(0, loadedItems.length - viewportHeight));
		this.listScrollTop = listStart;
		const listEnd = Math.min(loadedItems.length, listStart + viewportHeight);

		const listRows: string[] = [];
		for (let i = listStart; i < listEnd; i++) {
			const t = loadedItems[i];
			const absIndex = this.loadedStart + i;
			const isSel = absIndex === this.selectedIndex;
			const marker = isSel ? theme.fg("accent", "▸") : " ";
			const badge = theme.fg("dim", `[${t.index}]`);
			const name = isSel
				? theme.bold(theme.fg("accent", t.displayName || t.name))
				: theme.fg("toolTitle", t.displayName || t.name);
			const summary = theme.fg("dim", truncate(t.summaryDisplay, Math.max(8, listWidth - 18)));
			const row = `${marker}${this.statusIcon(t)} ${badge} ${name} ${summary}`;
			// 行号：标题(0) + 分隔(1) + 内容起始(2)
			this.listRowMap.push({ row: 2 + listRows.length, index: absIndex });
			listRows.push(row);
		}

		// 右栏：选中条目详情
		const detailLines = this.buildDetailLines(detailWidth);
		this.detailLineCount = detailLines.length;
		const detailStart = Math.min(this.detailScrollTop, Math.max(0, detailLines.length - viewportHeight));
		this.detailScrollTop = detailStart;
		const detailEnd = Math.min(detailLines.length, detailStart + viewportHeight);

		for (let row = 0; row < viewportHeight; row++) {
			const left = listRows[row] ?? "";
			const right = detailLines[detailStart + row] ?? "";
			const leftPadded = left + " ".repeat(Math.max(0, listWidth - visibleWidth(left)));
			const sep = theme.fg("dim", " │ ");
			const content = `${leftPadded}${sep}${right}`;
			const pad = Math.max(0, boxW - 2 - visibleWidth(content));
			boxLines.push(`${borderColor("│")}${content}${' '.repeat(pad)}${borderColor("│")}`);
		}

		// 底部提示（优先显示复制反馈）
		boxLines.push(`${borderColor("├")}${theme.fg("dim", "─".repeat(boxW - 2))}${borderColor("┤")}`);
		let hintText: string;
		if (this.copyFeedback) {
			hintText = theme.fg("success", `✓ ${this.copyFeedback}`);
		} else if (this.detailLineCount > viewportHeight) {
			hintText = theme.fg("muted", `详情 ${detailStart + 1}-${detailEnd}/${this.detailLineCount} · 滚轮滚动 · ↑↓ 选择 · Esc 关闭`);
		} else {
			hintText = theme.fg("muted", "滚轮滚动 · ↑↓ 选择 · 点击左侧行复制详情 · Esc 关闭");
		}
		const hintPad = Math.max(0, boxW - 2 - visibleWidth(hintText) - 1);
		boxLines.push(`${borderColor("│")} ${hintText}${' '.repeat(hintPad)}${borderColor("│")}`);
		boxLines.push(`${borderColor("└")}${theme.fg("dim", "─".repeat(boxW - 2))}${borderColor("┘")}`);

		// 把方框合成到全屏画布上（框外为空白），从而能接收框外点击以关闭
		const blank = " ".repeat(termCols);
		const lines: string[] = [];
		for (let r = 0; r < boxTop; r++) lines.push(blank);
		for (const bl of boxLines) {
			const leftPad = " ".repeat(boxLeft);
			const rightPad = " ".repeat(Math.max(0, termCols - boxLeft - visibleWidth(bl)));
			lines.push(`${leftPad}${bl}${rightPad}`);
		}
		const used = boxTop + boxLines.length;
		for (let r = used; r < termRows; r++) lines.push(blank);

		return lines;
	}

	/** 构建右侧详情行（已按宽度换行/截断） */
	private buildDetailLines(width: number): string[] {
		const theme = this.theme;
		const t = this.selectedItem;
		const out: string[] = [];
		if (!t) {
			out.push(theme.fg("muted", "(无选中条目)"));
			return out;
		}

		out.push(theme.bold(theme.fg("toolTitle", `${t.displayName || t.name}  [${t.index}]`)));
		if (t.durationMs !== undefined) {
			out.push(theme.fg("muted", `耗时 ${t.durationMs}ms · 状态 ${t.status}`));
		}
		if (t.fullPath) out.push(theme.fg("accent", `路径: ${t.fullPath}`));
		out.push("");

		// 优先展示 detailContent（edit diff / write 正文 / 三方工具长文本）
		const detail = t.detailContent;
		if (detail && detail.trim().length > 0) {
			const kindLabel =
				t.detailKind === "diff"
					? "变更 diff"
					: t.detailKind === "content"
						? "内容"
						: t.detailKind === "command"
							? "命令"
							: "详情";
			out.push(theme.fg("accent", `── ${kindLabel} ──`));
			for (const raw of detail.split("\n")) {
				out.push(...this.wrapLine(raw, width, (line) => this.colorizeDetailLine(line, t.detailKind)));
			}
			out.push("");
		} else if (t.fullCommand) {
			out.push(theme.fg("accent", "── 命令 ──"));
			for (const raw of t.fullCommand.split("\n")) {
				out.push(...this.wrapLine(raw, width, (line) => theme.fg("accent", line)));
			}
			out.push("");
		}

		// 输出内容
		if (t.output && t.output.trim().length > 0) {
			out.push(theme.fg("accent", "── 输出 ──"));
			for (const raw of t.output.replace(/\r\n/g, "\n").split("\n")) {
				out.push(...this.wrapLine(raw, width, (line) => theme.fg("muted", line)));
			}
		}

		if (out.length === 0) out.push(theme.fg("muted", "(无详情)"));
		return out;
	}

	private colorizeDetailLine(line: string, kind?: string): string {
		const theme = this.theme;
		if (kind === "diff") {
			if (line.startsWith("+")) return theme.fg("success", line);
			if (line.startsWith("-")) return theme.fg("error", line);
			if (line.startsWith("@@")) return theme.fg("accent", line);
			return theme.fg("dim", line);
		}
		return line;
	}

	/** 按显示宽度硬换行（保留 ANSI 无关的纯文本换行） */
	private wrapLine(raw: string, width: number, style: (line: string) => string): string[] {
		if (visibleWidth(raw) <= width) return [style(raw)];
		const out: string[] = [];
		let remaining = raw;
		while (visibleWidth(remaining) > width) {
			// 简化处理：按可见宽度切片（不处理 ANSI，因为源文本通常无 ANSI）
			let cut = 0;
			let w = 0;
			for (const ch of remaining) {
				const cw = visibleWidth(ch);
				if (w + cw > width) break;
				w += cw;
				cut += ch.length;
			}
			if (cut === 0) break;
			out.push(style(remaining.slice(0, cut)));
			remaining = remaining.slice(cut);
		}
		if (remaining.length > 0) out.push(style(remaining));
		return out;
	}

	handleInput(data: string): void {
		// Esc / q 关闭
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.onClose();
			return;
		}
		// 上下选择
		if (matchesKey(data, "up") || data === "k") {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.moveSelection(1);
			return;
		}
		// PageUp/PageDown 滚动详情
		if (matchesKey(data, "pageUp")) {
			this.detailScrollTop = Math.max(0, this.detailScrollTop - this.detailViewportHeight);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.detailScrollTop = Math.min(
				Math.max(0, this.detailLineCount - this.detailViewportHeight),
				this.detailScrollTop + this.detailViewportHeight,
			);
			this.requestRender();
		}
	}

	private moveSelection(delta: number): void {
		if (this.allItems.length === 0) return;
		const next = Math.max(0, Math.min(this.allItems.length - 1, this.selectedIndex + delta));
		if (next === this.selectedIndex) return;
		this.selectedIndex = next;
		this.detailScrollTop = 0;
		// 只要用户手动移动选择，就停止自动跟随最新条目
		this.followTail = false;
		// 确保选中项在已加载范围内
		if (next < this.loadedStart) {
			this.loadedCount = Math.min(this.allItems.length, this.allItems.length - next);
		}
		// 确保选中项在列表视口内
		const relIndex = next - this.loadedStart;
		if (relIndex < this.listScrollTop) this.listScrollTop = relIndex;
		if (relIndex >= this.listScrollTop + this.listViewportHeight) {
			this.listScrollTop = relIndex - this.listViewportHeight + 1;
		}
		this.requestRender();
	}

	/** 将某条工具的详情文本复制到剪贴板，并就地显示反馈 */
	private copyItemDetail(t: ToolItem): void {
		const text =
			t.detailContent ??
			t.fullCommand ??
			t.fullPath ??
			t.output ??
			t.summaryDisplay;
		if (!text) return;
		copyToClipboard(text);
		const label = t.detailContent
			? t.detailKind === "diff"
				? "diff"
				: "内容"
			: t.fullCommand
				? "命令"
				: t.fullPath
					? "路径"
					: "输出";
		this.copyFeedback = `已复制${label}: ${truncate(text.replace(/\r?\n/g, " "), 50)}`;
		if (this.copyFeedbackTimer) clearTimeout(this.copyFeedbackTimer);
		this.copyFeedbackTimer = setTimeout(() => {
			this.copyFeedback = null;
			this.requestRender();
		}, 2500);
		this.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// 点击方框外部 → 关闭窗体
		if (event.type === "click") {
			const inside =
				event.y >= this.boxTop &&
				event.y < this.boxTop + this.boxHeight &&
				event.x >= this.boxLeft &&
				event.x < this.boxLeft + this.boxWidth;
			if (!inside) {
				this.onClose();
				return { handled: true };
			}
		}

		if (event.type === "wheel") {
			const delta = event.wheelDelta ?? 0;
			// 判断鼠标位于左栏还是右栏（内容区从边框内开始，x 偏移 1）
			const inner = Math.max(20, this.boxWidth - 4);
			const listWidth = Math.max(20, Math.floor(inner * 0.45));
			const inList = event.x <= this.boxLeft + listWidth + 3;

			if (inList) {
				const loadedItems = this.loadedItems;
				const maxScroll = Math.max(0, loadedItems.length - this.listViewportHeight);
				const next = this.listScrollTop + delta;
				if (next < 0) {
					// 上滑到顶：先尝试加载更多
					if (this.loadMore()) {
						this.listScrollTop = 0;
						this.requestRender();
						return { handled: true };
					}
					this.listScrollTop = 0;
				} else {
					this.listScrollTop = Math.min(maxScroll, next);
				}
			} else {
				const maxScroll = Math.max(0, this.detailLineCount - this.detailViewportHeight);
				this.detailScrollTop = Math.max(0, Math.min(maxScroll, this.detailScrollTop + delta));
			}
			this.requestRender();
			return { handled: true };
		}

		if (event.type === "click") {
			// 列表行命中：选中并复制该行详情
			const hit = this.listRowMap.find((m) => m.row === event.y - this.boxTop);
			if (hit) {
				this.selectedIndex = hit.index;
				this.detailScrollTop = 0;
				// 点击了最后一条则恢复跟随，否则停止跟随
				this.followTail = hit.index === this.allItems.length - 1;
				const item = this.allItems[hit.index];
				if (item) this.copyItemDetail(item);
				this.requestRender();
				return { handled: true };
			}
		}

		return undefined;
	}

	invalidate(): void {}
}

/**
 * 查找匹配的状态栏增强配置规则
 */
function findStatusEnhancementRule(
	key: string,
	rules?: StatusEnhancementRule[],
): StatusEnhancementRule | undefined {
	if (!rules || !Array.isArray(rules)) return undefined;
	return rules.find((rule) => matchesToolRule(rule.keyPattern, key));
}

/**
 * 自适应语义色彩推导（抗上游格式变更，无需硬编码 SoL-Pi）
 * 1. 结构化范式：[图标/Emoji] [模块/机制名] [分隔符] [结果/量化指标]
 * 2. 指标高亮回退：自动提取数值与度量单位为强调绿色
 */
function autoColorizeStatusText(text: string): string {
	if (!text) return text;

	// 清理已有 ANSI 序列，防止嵌套污染
	const clean = text.replace(/\x1b\[[0-9;]*m/g, "");

	// 范式 1：前置符号 + 机制/标题 + 分隔符(·|:—-) + 详细数值
	const structuredMatch = clean.match(/^([^\w\s\d]*\s*)([A-Za-z0-9_\-\s]+?)\s*([·|:—\-])\s*(.*)$/u);
	if (structuredMatch) {
		const symbol = structuredMatch[1] ? `\x1b[33m${structuredMatch[1]}\x1b[39m` : "";
		const prefix = `\x1b[1;36m${structuredMatch[2]}\x1b[22;39m`;
		const sep = `\x1b[90m${structuredMatch[3]}\x1b[39m`;
		const detail = `\x1b[32m${structuredMatch[4]}\x1b[39m`;
		return `${symbol}${prefix} ${sep} ${detail}`;
	}

	// 范式 2：通用度量与数值强调回退
	return clean.replace(
		/(\b\d[\d,.]*\b(?:\s*(?:tokens|context tokens|MiB|KiB|B|ms|s|round-trip|avoided|removed|saved|%)|\b)?)/gi,
		(m) => `\x1b[32m${m}\x1b[39m`,
	);
}

let activeStatusInterval: any = null;
let activeStatusStartTime = 0;
let lastActiveStatusRawText = "";

/**
 * 匹配插件在工具行里重复插入的提示头（如 SoL-Pi 的 “⚡ SoL-Pi · X” / “Money saved · Y”）。
 * 带上 `·` 分隔符以尽量避免误伤工具自身的输出。
 */
const TOOL_NOTIFICATION_HEADER_RE = /(SoL-Pi\s*·|Money saved\s*·)/;

/**
 * 包装组件：渲染后过滤掉插件插入的提示头行。
 * 对任意三方插件通用，不依赖具体插件名或内部组件结构。
 */
class NotificationHeaderStripper implements Component {
	private inner: Component;

	constructor(inner: Component) {
		this.inner = inner;
	}

	render(width: number): string[] {
		const lines = this.inner.render(width);
		const filtered = lines.filter((line) => !TOOL_NOTIFICATION_HEADER_RE.test(line));
		return filtered;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.inner.handleMouse?.(event);
	}

	invalidate(): void {
		this.inner.invalidate?.();
	}
}

/**
 * 注册工具渲染器：剥掉插件在工具行里重复画的提示头（通道 C）。
 * 旧版 Pi 没有 registerToolRenderer 时静默降级。
 */
function installToolNotificationStripper(
	pi: ExtensionAPI,
	isEnabled: () => boolean,
): void {
	const register = (pi as any).registerToolRenderer;
	if (typeof register !== "function") return;

	register.call(pi, (toolName: string, next: () => any) => {
		const base = next();
		if (!base || !isEnabled()) return base;

		const wrap = (fn: any) => {
			if (typeof fn !== "function") return fn;
			return (...args: any[]) => {
				const component = fn(...args);
				return component ? new NotificationHeaderStripper(component) : component;
			};
		};

		return {
			...base,
			renderCall: wrap(base.renderCall),
			renderResult: wrap(base.renderResult),
		};
	});
}

/**
 * 安装原型劫持骨架（仅在进程初次加载时拦截一次，后续所有 reload 均由 dynamicHooks 委托热刷新）
 */
function ensureGlobalPrototypeHooksInstalled(): void {
	if (dynamicHooks.installed) return;
	dynamicHooks.installed = true;

	const origToolRender = ToolExecutionComponent.prototype.render;
	ToolExecutionComponent.prototype.render = function (this: any, width: number): string[] {
		if (dynamicHooks.handleToolRender) {
			return dynamicHooks.handleToolRender(this, width, origToolRender);
		}
		return origToolRender.call(this, width);
	};

	const interactiveProto = InteractiveMode.prototype as any;
	const origShowNotify = interactiveProto.showExtensionNotify;
	interactiveProto.showExtensionNotify = function (this: any, message: string, type?: string) {
		if (dynamicHooks.handleShowExtensionNotify) {
			return dynamicHooks.handleShowExtensionNotify(this, message, type, origShowNotify);
		}
		return origShowNotify.call(this, message, type);
	};

	const origSetStatus = interactiveProto.setExtensionStatus;
	interactiveProto.setExtensionStatus = function (this: any, key: string, text: string | undefined) {
		if (dynamicHooks.handleSetExtensionStatus) {
			return dynamicHooks.handleSetExtensionStatus(this, key, text, origSetStatus);
		}
		return origSetStatus.call(this, key, text);
	};
}

export default function rollingTools(pi: ExtensionAPI): void {
	let initialLoad = loadConfig(process.cwd());
	let currentConfig: RollingToolsConfig = initialLoad.config;
	let totalToolCount = 0;
	let statusTimer: any = null;
	let lastCtx: any = null;
	/** 待展示的旧配置迁移提示（仅提示一次） */
	let pendingLegacyNotice: string | undefined;
	if (initialLoad.legacyDetected) {
		pendingLegacyNotice = buildLegacyNotice(initialLoad.legacyPath, initialLoad.legacyVersion);
	}

	const state: WidgetState = {
		headerStatus: { type: "idle" },
		recentTools: [],
		activeError: null,
		expandedItemId: null,
		copyFeedbackMessage: null,
		completedMessage: null,
	};

	/** 当前打开的历史大窗体（用于实时刷新与去重） */
	let activeOverlay: ToolHistoryOverlayComponent | null = null;

	// 1. 安装底层全局原型钩子骨架（单例）
	ensureGlobalPrototypeHooksInstalled();

	// 1.5 注册工具渲染器：剥掉插件在工具行里重复画的提示头（通道 C）
	installToolNotificationStripper(pi, () => currentConfig.enabled && currentConfig.stripToolNotificationHeaders !== false);

	// 2. 动态更新委派处理函数（支持任意次数的 /reload 即刻生效！）
	dynamicHooks.handleToolRender = (target: any, width: number, origRender: Function) => {
		if (currentConfig.enabled && !target.expanded && shouldSilenceInTranscript(target.toolName, currentConfig)) {
			return [];
		}
		return origRender.call(target, width);
	};

	dynamicHooks.handleShowExtensionNotify = (
		target: any,
		message: string,
		type: string | undefined,
		origFn: Function,
	) => {
		// 重要信息（error / warning 类型，或命中关键词）不被拦截
		if (isImportantNotification(message, type, currentConfig.notificationKeywords)) {
			return origFn.call(target, message, type);
		}
		const matchedRule = matchNotificationRule(message, currentConfig.interceptNotifications);
		if (matchedRule?.suppressToast) {
			return;
		}
		return origFn.call(target, message, type);
	};

	dynamicHooks.handleSetExtensionStatus = (
		target: any,
		key: string,
		text: string | undefined,
		origFn: Function,
	) => {
		const rule = findStatusEnhancementRule(key, currentConfig.statusEnhancements);
		if (rule && rule.durationMs && rule.durationMs > 0) {
			if (text) {
				if (activeStatusInterval) {
					clearInterval(activeStatusInterval);
					activeStatusInterval = null;
				}
				lastActiveStatusRawText = text;
				activeStatusStartTime = Date.now();
				const targetDuration = rule.durationMs;

				const updateStatus = () => {
					const elapsedSec = Math.floor((Date.now() - activeStatusStartTime) / 1000);
					if (elapsedSec >= Math.floor(targetDuration / 1000)) {
						if (activeStatusInterval) {
							clearInterval(activeStatusInterval);
							activeStatusInterval = null;
						}
						lastActiveStatusRawText = "";
						origFn.call(target, key, undefined);
						return;
					}
					let formattedText = rule.colorize ? autoColorizeStatusText(lastActiveStatusRawText) : lastActiveStatusRawText;
					if (rule.showRelativeTime) {
						formattedText += ` \x1b[90m(${elapsedSec}s ago)\x1b[39m`;
					}
					origFn.call(target, key, formattedText);
				};

				updateStatus();
				activeStatusInterval = setInterval(updateStatus, 1000);
				if (typeof activeStatusInterval === "object" && "unref" in activeStatusInterval) {
					activeStatusInterval.unref();
				}
				return;
			} else {
				const targetDuration = rule.durationMs;
				const remaining = activeStatusStartTime + targetDuration - Date.now();
				if (remaining > 0 && lastActiveStatusRawText) {
					return;
				}
			}
		}
		return origFn.call(target, key, text);
	};

	function stopStatusTimer(): void {
		if (statusTimer) {
			clearInterval(statusTimer);
			statusTimer = null;
		}
	}

	function startStatusTimer(ctx: any): void {
		stopStatusTimer();
		statusTimer = setInterval(() => {
			syncWidget(ctx);
		}, 100);
	}

	/**
	 * 从当前 session 的 entries 中恢复最近一次滚动历史快照。
	 */
	function restoreHistoryFromSession(ctx: any): { items: ToolItem[]; total: number } | null {
		try {
			const entries = ctx?.sessionManager?.getEntries?.();
			if (!Array.isArray(entries)) return null;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry?.type === "custom" && entry?.customType === HISTORY_ENTRY_TYPE) {
					return deserializeHistory(entry.data);
				}
			}
		} catch (e) {
			console.error("[rolling-tools] Failed to restore history:", e);
		}
		return null;
	}

	/**
	 * 将当前滚动历史快照写入 session（不参与 LLM 上下文）。
	 */
	function persistHistory(): void {
		if (!currentConfig.persistAcrossSessions) return;
		try {
			pi.appendEntry(HISTORY_ENTRY_TYPE, serializeHistory(state.recentTools, totalToolCount));
		} catch (e) {
			console.error("[rolling-tools] Failed to persist history:", e);
		}
	}

	function syncWidget(ctx: any): void {
		if (!ctx?.hasUI) return;

		// 状态行为常驻行，因此只要功能开启就始终显示 widget
		const hasContent = currentConfig.enabled;

		if (!hasContent) {
			ctx.ui.setWidget("rolling-tools", undefined);
			return;
		}

		ctx.ui.setWidget(
			"rolling-tools",
			(tui: any, theme: any) =>
				new RollingToolsWidgetComponent(
					tui,
					theme,
					state,
					(item?: ToolItem) => {
						openHistoryOverlay(ctx, item);
					},
					currentConfig.maxRecentTools,
				),
			{ placement: "aboveEditor" },
		);

		// 若大窗体已打开，同步刷新它，使运行中的工具状态实时更新
		activeOverlay?.refresh();
	}

	/**
	 * 打开工具历史大窗体（overlay dialog）。
	 * 支持鼠标滚轮滚动，以及“上滑到顶再加载 step 条”的懒加载。
	 */
	function openHistoryOverlay(ctx: any, initialItem?: ToolItem): void {
		if (!ctx?.hasUI || !ctx.ui?.custom) {
			ctx?.ui?.notify?.("rolling-tools: 当前环境不支持大窗体", "warning");
			return;
		}
		if (activeOverlay) {
			// 已打开：仅切换选中项，不重复弹窗
			if (initialItem) {
				const idx = state.recentTools.findIndex((t) => t.id === initialItem.id);
				if (idx >= 0) activeOverlay.selectIndex(idx);
			}
			return;
		}
		if (state.recentTools.length === 0) {
			ctx.ui.notify("rolling-tools: 暂无工具历史", "info");
			return;
		}
		const step = currentConfig.lazyLoadStep && currentConfig.lazyLoadStep > 0 ? currentConfig.lazyLoadStep : 10;
		// 传入实时数组引用（而非快照），使 agent 运行中新增的工具能实时反映到大窗体
		const liveItems = state.recentTools;

		void ctx.ui
			.custom(
				(tui: any, theme: any, _keybindings: any, done: (result: unknown) => void) => {
					const component = new ToolHistoryOverlayComponent(
						tui,
						theme,
						liveItems,
						step,
						() => {
							activeOverlay = null;
							done(undefined);
						},
						() => tui?.requestRender?.(),
					);
					activeOverlay = component;
					// 若指定了初始条目，直接选中它
					if (initialItem) {
						const idx = liveItems.findIndex((t) => t.id === initialItem.id);
						if (idx >= 0) component.selectIndex(idx);
					}
					return component;
				},
				{
					overlay: true,
					overlayOptions: {
						// 全屏 overlay：方框在组件内部居中绘制，从而能接收框外点击以关闭
						width: "100%",
						maxHeight: "100%",
						anchor: "top-left",
						margin: 0,
					},
				},
			)
			.catch((err: unknown) => {
				activeOverlay = null;
				console.error("[rolling-tools] overlay error:", err);
			});
	}

	/**
	 * 安装 UI 通知 Hook（用于拦截并静音 SoL-Pi 弹窗）
	 */
	function installUiHooks(ctx: ExtensionContext): void {
		if (!ctx?.hasUI || !ctx.ui) return;
		const ui = ctx.ui as any;
		const hookKey = Symbol.for("pi-rolling-tools.contextUiHook.v1");
		if (ui[hookKey]) return;
		ui[hookKey] = true;

		const originalNotify = ui.notify?.bind(ui);
		if (originalNotify) {
			ui.notify = (message: string, type?: string) => {
				// 重要信息（error / warning 类型，或命中关键词）不被拦截
				if (isImportantNotification(message, type, currentConfig.notificationKeywords)) {
					return originalNotify(message, type);
				}
				const matchedRule = matchNotificationRule(message, currentConfig.interceptNotifications);
				if (matchedRule?.suppressToast) {
					return;
				}
				return originalNotify(message, type);
			};
		}

		const originalSetStatus = ui.setStatus?.bind(ui);
		if (originalSetStatus) {
			ui.setStatus = (key: string, text: string | undefined) => {
				return originalSetStatus(key, text);
			};
		}
	}

	// 2. 会话启动
	pi.on("session_start", async (event, ctx) => {
		lastCtx = ctx;
		const loaded = loadConfig(ctx?.cwd || process.cwd());
		currentConfig = loaded.config;
		if (loaded.legacyDetected) {
			pendingLegacyNotice = buildLegacyNotice(loaded.legacyPath, loaded.legacyVersion);
		}
		installUiHooks(ctx);

		// 恢复历史：
		// - reload/new/resume/fork：都尝试从当前 session 的 entries 中恢复。
		//   注意：/reload 会重新加载扩展模块，内存中的 state 是全新的，必须从 session 恢复。
		// - startup：全新进程，session 通常为空，恢复失败也不影响。
		if (currentConfig.persistAcrossSessions) {
			const restored = restoreHistoryFromSession(ctx);
			if (restored && restored.items.length > 0) {
				state.recentTools = restored.items;
				totalToolCount = restored.total;
			}
		}

		syncWidget(ctx);

		// 旧配置迁移提示（一次性，延后到 UI 就绪后展示）
		if (pendingLegacyNotice) {
			const notice = pendingLegacyNotice;
			pendingLegacyNotice = undefined;
			setTimeout(() => {
				try {
					ctx.ui?.notify?.(notice, "warning");
				} catch {
					/* ignore */
				}
			}, 800);
		}
	});

	// 3. 用户提问开始（新一轮 Agent 运行）：保留已有滚动历史，仅重置瞬时状态
	pi.on("agent_start", async (_event, ctx) => {
		lastCtx = ctx;
		installUiHooks(ctx);
		(ctx.ui as any)?.setToolsExpanded?.(false);

		stopStatusTimer();
		// 注意：不再清空 state.recentTools / totalToolCount，使滚动块跨轮次持续存在
		state.headerStatus = { type: "idle" };
		state.activeError = null;
		state.expandedItemId = null;
		state.copyFeedbackMessage = null;
		state.completedMessage = null;
		syncWidget(ctx);
	});

	// 4. 发起网络请求前：顶层状态行切换为“等待服务器响应”，开启动态计时
	pi.on("before_provider_request", (_event, ctx) => {
		state.headerStatus = { type: "waiting_server", startTime: Date.now() };
		startStatusTimer(ctx);
		syncWidget(ctx);
	});

	// 5. 消息流式事件
	pi.on("message_update", async (event, ctx) => {
		if (event.message?.role === "assistant" && Array.isArray(event.message.content)) {
			event.message.content = event.message.content.filter((c: any) => c.type !== "thinking");
		}

		const ev = (event as any).assistantMessageEvent;
		if (!ev) return;

		if (ev.type === "thinking_start" || ev.type === "thinking_delta") {
			if (state.headerStatus.type !== "thinking") {
				state.headerStatus = { type: "thinking", startTime: Date.now() };
				startStatusTimer(ctx);
				syncWidget(ctx);
			}
		} else if (ev.type === "thinking_end") {
			const thinkingStartTime =
				state.headerStatus.type === "thinking" ? state.headerStatus.startTime : Date.now();
			const actualDuration = Math.max(100, Date.now() - thinkingStartTime);
			stopStatusTimer();
			state.headerStatus = { type: "thinking_completed", durationMs: actualDuration };
			syncWidget(ctx);
		}

		// 正文流式输出时：保留“思考完成”状态作为常驻头部；仅清理临时错误
		const isTextStreaming =
			ev.type === "text_start" ||
			(ev.type === "text_delta" && typeof ev.delta === "string" && ev.delta.trim().length > 0);

		if (isTextStreaming) {
			stopStatusTimer();
			// 若仍处于等待/思考中，退回到已完成/就绪（不再保留计时器）
			if (state.headerStatus.type === "waiting_server" || state.headerStatus.type === "thinking") {
				state.headerStatus = { type: "idle" };
			}
			state.activeError = null;
			syncWidget(ctx);
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message?.role === "assistant" && Array.isArray(event.message.content)) {
			return {
				message: {
					...event.message,
					content: event.message.content.filter((c: any) => c.type !== "thinking"),
				},
			};
		}
	});

	// 6. 任务结束处理与 settled 最终状态标记
	pi.on("agent_end", async (_event, ctx) => {
		stopStatusTimer();
		// 保留“思考完成”状态；仅将等待/思考中收敛为就绪
		if (state.headerStatus.type === "waiting_server" || state.headerStatus.type === "thinking") {
			state.headerStatus = { type: "idle" };
		}
		// 持久化一次即可：每次工具都写会在 session 中产生 O(N²) 体积的快照
		persistHistory();
		syncWidget(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		stopStatusTimer();
		if (state.headerStatus.type === "waiting_server" || state.headerStatus.type === "thinking") {
			state.headerStatus = { type: "idle" };
		}
		state.completedMessage = "Completed";
		syncWidget(ctx);
	});

	// 7. 工具调用开始：记录进 recentTools 并滚动
	pi.on("tool_call", async (event, ctx) => {
		if (state.headerStatus.type === "waiting_server") {
			state.headerStatus = { type: "idle" };
			stopStatusTimer();
		}

		if (!shouldIncludeInWidget(event.toolName, currentConfig)) {
			return;
		}

		totalToolCount++;
		const cwd = ctx?.cwd || process.cwd();
		const { summaryDisplay, fullPath, fullCommand, displayName, detailContent, detailKind } =
			extractSummaryAndMetadata(event.toolName, event.input, cwd, currentConfig);

		state.recentTools.push({
			id: event.toolCallId,
			index: totalToolCount,
			name: event.toolName,
			displayName,
			summaryDisplay,
			fullPath,
			fullCommand,
			detailContent,
			detailKind,
			status: "running",
			startTime: Date.now(),
		});

		// 内存中的完整历史保留一个上限，避免无限增长；widget 只展示最近 maxRecentTools 条
		if (state.recentTools.length > HISTORY_MEMORY_LIMIT) {
			state.recentTools.splice(0, state.recentTools.length - HISTORY_MEMORY_LIMIT);
		}

		if (state.expandedItemId && !state.recentTools.some((t) => t.id === state.expandedItemId)) {
			state.expandedItemId = null;
		}

		syncWidget(ctx);
	});

	// 8. 工具调用完成：记录耗时、状态与输出内容
	pi.on("tool_result", async (event, ctx) => {
		const item = state.recentTools.find((t) => t.id === event.toolCallId);
		if (item) {
			item.status = event.isError ? "error" : "done";
			item.durationMs = Date.now() - item.startTime;

			const textContent = (event.content as any[])?.find((c) => c && c.type === "text");
			if (textContent && typeof textContent.text === "string") {
				item.output = textContent.text;
			}

			// edit：从 details.diff 回填完整 diff，供 overlay 大窗体展示
			const details = (event as any).details;
			if (!item.detailContent && details && typeof details.diff === "string" && details.diff.length > 0) {
				item.detailContent = details.diff;
				item.detailKind = "diff";
			}
		}

		if (event.isError) {
			const textContent = (event.content as any[])?.find((c) => c && c.type === "text");
			const rawError = textContent?.text || "Tool execution failed";
			state.activeError = {
				toolName: event.toolName,
				index: item?.index ?? totalToolCount,
				summary: item?.summaryDisplay || "",
				message: rawError.trim(),
			};
		} else {
			state.activeError = null;
		}

		// 不在此处持久化：逐个工具写快照会使 session 体积呈 O(N²) 增长，
		// 改由 agent_end / session_shutdown 在轮次边界统一写入。
		syncWidget(ctx);
	});

	// 9. 会话终止清理资源
	pi.on("session_shutdown", async () => {
		persistHistory();
		stopStatusTimer();
		if (activeStatusInterval) {
			clearInterval(activeStatusInterval);
			activeStatusInterval = null;
		}
	});

	// 10. 管理控制命令
	pi.registerCommand("rolling-tools", {
		description: "Manage rolling tools widget mode, configuration, and reload",
		handler: async (args, ctx) => {
			const action = (args || "").trim();
			if (action === "reload") {
				const loaded = loadConfig(ctx?.cwd || process.cwd());
				currentConfig = loaded.config;
				syncWidget(ctx);
				if (loaded.legacyDetected) {
					ctx.ui?.notify?.(buildLegacyNotice(loaded.legacyPath, loaded.legacyVersion), "warning");
				} else {
					ctx.ui?.notify?.("✓ rolling-tools: 配置已重载", "info");
				}
			} else if (action === "migrate") {
				const result = migrateConfigToLatest(ctx?.cwd || process.cwd());
				if (result.ok) {
					currentConfig = result.config!;
					syncWidget(ctx);
					ctx.ui?.notify?.(
						`✓ rolling-tools: 已升级到全工具语义（v${CONFIG_VERSION}）\n• 静音/收录规则已设为 ["*"]\n• 已写入: ${result.path}`,
						"info",
					);
				} else {
					ctx.ui?.notify?.(`rolling-tools: 升级失败 - ${result.error}`, "error");
				}
			} else if (action === "off") {
				currentConfig.enabled = false;
				syncWidget(ctx);
				ctx.ui?.notify?.("rolling-tools: 已禁用正文静音与滚动条", "info");
			} else if (action === "on") {
				currentConfig.enabled = true;
				syncWidget(ctx);
				ctx.ui?.notify?.("rolling-tools: 已启用正文静音与滚动条", "info");
			} else if (action === "status") {
				const info = [
					`rolling-tools 状态:`,
					`• 运行状态: ${currentConfig.enabled ? "已开启" : "已关闭"}`,
					`• widget 展示条数: ${currentConfig.maxRecentTools}（历史共 ${state.recentTools.length} 条）`,
					`• 静音工具规则: ${(currentConfig.silencedTools ?? currentConfig.managedTools).join(", ")}`,
					`• 收录工具规则: ${(currentConfig.widgetTools ?? currentConfig.managedTools).join(", ")}`,
					`• 懒加载步长: ${currentConfig.lazyLoadStep ?? 10} 条/次`,
					`• 跨会话持久化: ${currentConfig.persistAcrossSessions ? "已开启" : "已关闭"}`,
					`• 配置版本: v${currentConfig.configVersion ?? 1}${(currentConfig.configVersion ?? 1) < CONFIG_VERSION ? "（旧版，可执行 /rolling-tools migrate 升级）" : ""}`,
					`• 通知拦截: ${currentConfig.interceptNotifications.map((r) => r.match).join(", ") || "（无）"}（例外关键词 ${(currentConfig.notificationKeywords ?? []).length} 个）`,
					`• status 时长: ${currentConfig.statusEnhancements?.[0]?.durationMs ?? "默认"}ms`,
					`• 剥离工具行提示头: ${currentConfig.stripToolNotificationHeaders !== false ? "已开启" : "已关闭"}`,
				].join("\n");
				ctx.ui?.notify?.(info, "info");
			} else if (action === "history" || action === "open") {
				openHistoryOverlay(ctx);
			} else {
				currentConfig.enabled = !currentConfig.enabled;
				syncWidget(ctx);
				ctx.ui?.notify?.(`rolling-tools: ${currentConfig.enabled ? "已开启" : "已关闭"}`, "info");
			}
		},
	});
}
