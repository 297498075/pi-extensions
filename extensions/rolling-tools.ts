import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, InteractiveMode, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { showStatusModal } from "./lib/status-modal.ts";
import { copyToClipboard, openLocalFile } from "./lib/desktop-actions.ts";

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
	/**
	 * 自动消失时长（毫秒）。不设则不倒计时，仅做着色（最安全，不会误伤常驻状态）。
	 */
	durationMs?: number;
	showRelativeTime?: boolean;
	colorize?: boolean;
	/**
	 * 常驻状态 key 列表（支持通配）。命中的 key 完全放行：不倒计时、不拦截、
	 * 也不吞掉它们自己的清除调用（如 pi-blackhole 的仪表盘、MCP 的服务器状态）。
	 */
	persistentKeys?: string[];
}

type ViewMode = "fixed" | "running";

/**
 * 滚动条与工具静音配置结构
 */
interface RollingToolsConfig {
	enabled: boolean;
	maxRecentTools: number;
	managedTools: string[];
	silencedTools?: string[];
	widgetTools?: string[];
	/** 默认视图模式：fixed（固定展示最近行数）或 running（仅展示正在执行的任务） */
	defaultViewMode?: ViewMode;
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
	defaultViewMode: "fixed",
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
		"text",
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
			// 默认对所有插件的 footer 状态行只做着色，不主动倒计时。
			// 因为“通配 + 倒计时”会误伤常驻状态（如 pi-blackhole 的仪表盘）。
			// 需要“一闪而过”的 tips 请在规则里显式配 durationMs。
			keyPattern: "*",
			showRelativeTime: false,
			colorize: true,
			// 常驻状态：完全放行，不倒计时、不拦截其清除调用。
			persistentKeys: ["blackhole", "mcp"],
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
	rawInput?: any;
	output?: string;
	/** 完整可展示内容（如 edit/write 的 diff 或写入正文），用于 overlay 大窗体 */
	detailContent?: string;
	/** detailContent 的语义标签，用于 overlay 标题 */
	detailKind?: "diff" | "content" | "command" | "output";
	status: "preparing" | "running" | "done" | "error";
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
	viewMode: ViewMode;
}

type LineKind = "header" | "detail_copyable" | "detail_info" | "other";

interface ButtonBounds {
	modeBtnStart?: number;
	modeBtnEnd?: number;
	overlayBtnStart?: number;
	overlayBtnEnd?: number;
}

interface RenderedLineInfo {
	item: ToolItem | null;
	width: number;
	kind: LineKind;
	textToCopy?: string;
	buttonBounds?: ButtonBounds;
	/** 该行最右侧是否存在 ⊞ 展开按钮 */
	hasOverlayButton?: boolean;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Target history window; preparing/running calls are retained until terminal events. */
const HISTORY_MEMORY_LIMIT = 500;
const DYNAMIC_HOOKS_KEY = Symbol.for("pi-rolling-tools.dynamicHooks.v3");
const ASSISTANT_DISPLAY_FILTERED = Symbol.for("pi-rolling-tools.assistantDisplayFiltered.v1");

interface DynamicHooksState {
	installed: boolean;
	assistantInstalled?: boolean;
	handleAssistantContent?: (target: any, message: any, isStreaming: boolean | undefined, original: Function) => void;
	handleAssistantRender?: (target: any, width: number, original: Function) => string[];
	handleToolRender?: (target: any, width: number, origRender: Function) => string[];
	handleShowExtensionNotify?: (target: any, message: string, type: string | undefined, origFn: Function) => void;
	handleSetExtensionStatus?: (target: any, key: string, text: string | undefined, origFn: Function) => void;
}

const dynamicHooks: DynamicHooksState = (globalThis as any)[DYNAMIC_HOOKS_KEY] ?? {
	installed: false,
};
(globalThis as any)[DYNAMIC_HOOKS_KEY] = dynamicHooks;

function truncate(str: string, maxLen = 50): string {
	if (!str) return "";
	if (str.length <= maxLen) return str;
	return str.slice(0, maxLen - 3) + "...";
}

/**
 * Reflow the complete styled line, including long prefixes/tool names. Never
 * reserve a minimum payload width larger than the remaining terminal columns.
 */
function wrapPrefixedText(
	text: string,
	width: number,
	firstPrefix: string,
	continuationPrefix: string,
	styler: (s: string) => string = (s) => s,
): string[] {
	const columns = Math.max(1, Math.floor(width));
	const indent = truncateToWidth(continuationPrefix, Math.max(0, columns - 1), "");
	const continuationWidth = Math.max(1, columns - visibleWidth(indent));
	return wrapTextWithAnsi(firstPrefix + styler(text), columns).flatMap((line, index) =>
		index === 0 ? [line] : wrapTextWithAnsi(line, continuationWidth).map(part => indent + part),
	);
}

/** Keep the full command/path and tool name in fixed mode, wrapping as needed. */
function wrapToolHeaderLines(
	icon: string,
	arrow: string,
	badge: string,
	name: string,
	summaryText: string,
	timeColored: string,
	renderWidth: number,
	themeStyler: (s: string) => string,
): string[] {
	const prefix = ` ${icon} ${arrow} ${badge} ${name}${summaryText ? " " : ""}`;
	return wrapPrefixedText(themeStyler(summaryText) + timeColored, renderWidth, prefix, "     ");
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

/**
 * 合并 statusEnhancements：用户配置优先，但**始终并集**默认的 persistentKeys，
 * 避免用户自定义规则时意外丢掉对常驻状态（blackhole / mcp）的保护。
 */
function mergeStatusEnhancements(
	base?: StatusEnhancementRule[],
	override?: StatusEnhancementRule[],
): StatusEnhancementRule[] {
	const incoming = (override ?? []).map((r) => ({ ...r }));
	const defaultPersistent = (base ?? []).flatMap((r) => r.persistentKeys ?? []);
	if (defaultPersistent.length === 0 || incoming.length === 0) return incoming;

	// 将默认 persistentKeys 并集到用户规则的每一条上
	return incoming.map((rule) => {
		const merged = new Set([...(rule.persistentKeys ?? []), ...defaultPersistent]);
		return { ...rule, persistentKeys: [...merged] };
	});
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
		defaultViewMode:
			override.defaultViewMode === "running" || override.defaultViewMode === "fixed"
				? override.defaultViewMode
				: base.defaultViewMode ?? "fixed",
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
			? mergeStatusEnhancements(base.statusEnhancements, override.statusEnhancements)
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
				{
					keyPattern: "*",
					showRelativeTime: false,
					colorize: true,
					persistentKeys: ["blackhole", "mcp"],
				},
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
		"• 所有插件的 info 提示只在界面最下方显示（error / warning 与关键词例外仍保留）",
		"• 工具行里重复的 “Money saved” 提示头已自动隐藏",
		"• 常驻状态（blackhole / mcp）不受影响；需要“一闪而过”的 tips 请显式配 durationMs",
		"如需自定义，可在配置文件中添加以下字段（全部可选，省略即用默认值）：",
		'  "interceptNotifications": [{ "match": "*", "suppressToast": true }]',
		'  "statusEnhancements": [{ "keyPattern": "*", "showRelativeTime": false, "colorize": true, "persistentKeys": ["blackhole", "mcp"] }]',
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

	// 1.8 语音工具：voice_speak & voice_listen
	if (name === "voice_speak" || name === "voice_listen") {
		const text = typeof input.text === "string" ? input.text : typeof input.prompt === "string" ? input.prompt : "";
		const voice = typeof input.voice_id === "string" ? input.voice_id : "";
		const prefix = voice ? `[${voice}] ` : "";
		const cleanText = text.replace(/\r?\n/g, " ").trim();
		const display = cleanText ? `${prefix}${truncate(cleanText, 45)}` : (voice ? `[${voice}]` : "");
		return {
			displayName: name,
			summaryDisplay: display || truncate(JSON.stringify(input), 45),
			detailContent: text || undefined,
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
				summaryDisplay: `${rawPath} (+${lineCount} lines)`,
				fullPath: absPath,
				detailContent: input.content,
				detailKind: "content",
			};
		}
		// edit：diff 在 tool_result.details.diff 中回填，这里先给出摘要
		if (name === "edit") {
			return { summaryDisplay: rawPath, fullPath: absPath, detailKind: "diff" };
		}
		return { summaryDisplay: rawPath, fullPath: absPath };
	}

	// 3. 内置搜索：grep
	if (name === "grep") {
		const scope = input.path ? resolve(cwd, input.path) : cwd;
		const display = `"${input.pattern || ""}" in ${input.path || "."}`;
		return { summaryDisplay: display, fullPath: scope };
	}

	// 4. 内置文件查找：find
	if (name === "find") {
		return { summaryDisplay: input.pattern || "" };
	}

	// 5. 内置目录列表：ls
	if (name === "ls") {
		const dirPath = input.path ? resolve(cwd, input.path) : cwd;
		return { summaryDisplay: input.path || ".", fullPath: dirPath };
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
		{ key: "text", kind: "content" },
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
const PERSIST_MAX_ITEMS = 200; // Recent history tail; active calls are retained in addition.
const PERSIST_MAX_FIELD = 20000;

function tryParseJson(str: string): any {
	if (!str) return undefined;
	try {
		return JSON.parse(str);
	} catch {
		const trimmed = str.replace(/\.\.\.$/, "").trim();
		for (const suffix of ['"}', '}', '"]}', ']}']) {
			try {
				return JSON.parse(trimmed + suffix);
			} catch {}
		}
	}
	return undefined;
}

function backfillInputsFromSession(entries: any[], items: ToolItem[]): void {
	if (!Array.isArray(entries) || !Array.isArray(items)) return;
	const callInputs = new Map<string, any>();
	const toolResults = new Map<string, { isError: boolean; output?: string; durationMs?: number }>();
	const omittedTargetIds = new Set<string>();

	for (const entry of entries) {
		if (entry?.type === "message" && entry.message?.role === "assistant" && Array.isArray(entry.message.content)) {
			for (const c of entry.message.content) {
				if (c && c.type === "toolCall" && c.id && c.arguments) {
					callInputs.set(c.id, c.arguments);
				}
			}
		} else if (entry?.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId) {
			let output: string | undefined;
			if (Array.isArray(entry.message.content)) {
				const textC = entry.message.content.find((c: any) => c && c.type === "text");
				if (textC && typeof textC.text === "string") output = textC.text;
			}
			toolResults.set(entry.message.toolCallId, {
				isError: Boolean(entry.message.isError),
				output,
				durationMs: typeof entry.message.durationMs === "number" ? entry.message.durationMs : undefined,
			});
		} else if (entry?.type === "context_edit" && entry.targetId && entry.replacement === null) {
			omittedTargetIds.add(entry.targetId);
		}
	}

	// 找出所有属于被裁剪/丢弃的 assistant message 的 toolCallId
	const omittedToolCallIds = new Set<string>();
	if (omittedTargetIds.size > 0) {
		for (const entry of entries) {
			if (entry?.type === "message" && entry.message?.role === "assistant" && omittedTargetIds.has(entry.id)) {
				if (Array.isArray(entry.message.content)) {
					for (const c of entry.message.content) {
						if (c?.type === "toolCall" && c.id) {
							omittedToolCallIds.add(c.id);
						}
					}
				}
			}
		}
	}

	for (const item of items) {
		if ((item.rawInput === undefined || item.rawInput === null) && callInputs.has(item.id)) {
			item.rawInput = callInputs.get(item.id);
		}

		// 回填会话中真实的工具执行结果与状态（对齐 toolResult 与中途终止的 context_edit）
		const res = toolResults.get(item.id);
		if (res) {
			item.status = res.isError ? "error" : "done";
			if (!item.output && res.output) item.output = res.output;
			if (res.durationMs !== undefined) {
				item.durationMs = res.durationMs;
			}
		} else if (omittedToolCallIds.has(item.id) || isPendingTool(item)) {
			// 若未收到 toolResult 且属于已终止轮次，状态标记为 error 并注明中断
			item.status = "error";
			if (!item.output) item.output = "Terminated or aborted before completion";
		}
	}
}
function serializeHistory(
	items: ToolItem[],
	total: number,
	viewMode?: ViewMode,
): { total: number; items: any[]; viewMode?: ViewMode } {
	// Keep active calls even when newer completed tools have moved the tail.
	const trimmed = items.filter((item, index) => index >= items.length - PERSIST_MAX_ITEMS || isPendingTool(item)).map((t) => ({
		id: t.id,
		index: t.index,
		name: t.name,
		displayName: t.displayName,
		summaryDisplay: t.summaryDisplay,
		fullPath: t.fullPath,
		fullCommand: t.fullCommand ? t.fullCommand.slice(0, PERSIST_MAX_FIELD) : undefined,
		rawInput: t.rawInput,
		output: t.output ? t.output.slice(0, PERSIST_MAX_FIELD) : undefined,
		detailContent: t.detailContent ? t.detailContent.slice(0, PERSIST_MAX_FIELD) : undefined,
		detailKind: t.detailKind,
		status: t.status,
		durationMs: t.durationMs,
		startTime: t.startTime,
	}));
	return { total, items: trimmed, viewMode };
}

function deserializeHistory(data: any): { items: ToolItem[]; total: number; viewMode?: ViewMode } | null {
	if (!data || !Array.isArray(data.items)) return null;
	const items: ToolItem[] = data.items.map((raw: any) => ({
		id: String(raw.id ?? ""),
		index: Number(raw.index ?? 0),
		name: String(raw.name ?? ""),
		displayName: raw.displayName,
		summaryDisplay: String(raw.summaryDisplay ?? ""),
		fullPath: raw.fullPath,
		fullCommand: raw.fullCommand,
		rawInput: raw.rawInput,
		output: raw.output,
		detailContent: raw.detailContent,
		detailKind: raw.detailKind,
		status: raw.status === "error" ? "error" : raw.status === "running" ? "running" : raw.status === "preparing" ? "preparing" : "done",
		durationMs: typeof raw.durationMs === "number" ? raw.durationMs : undefined,
		startTime: Number(raw.startTime ?? Date.now()),
	}));
	const viewMode: ViewMode | undefined =
		data.viewMode === "running" || data.viewMode === "fixed" ? data.viewMode : undefined;
	return { items, total: Number(data.total ?? items.length), viewMode };
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
 * 格式化任务耗时：小于 1s 显示 (Xms)，大于等于 1s 显示 (X.Xs)
 */
function formatDuration(durationMs: number): string {
	if (durationMs < 1000) {
		return ` (${Math.floor(durationMs)}ms)`;
	}
	return ` (${(durationMs / 1000).toFixed(1)}s)`;
}

function isPendingTool(item: ToolItem): boolean {
	return item.status === "preparing" || item.status === "running";
}

function toolDisplayLabel(item: ToolItem): string {
	return `${item.displayName || item.name}${item.status === "preparing" ? " [生成参数]" : ""}`;
}

/**
 * 格式化正在运行的任务行（用于 running 模式直接合并到状态行，避免高度上下闪动）
 */
function formatRunningTasksLine(runningTools: ToolItem[], availableWidth: number, theme: any): string {
	const spinner = SPINNER_FRAMES[Math.floor(Date.now() / 150) % SPINNER_FRAMES.length];
	if (runningTools.length === 1) {
		const t = runningTools[0];
		const elapsed = Math.max(0, Date.now() - t.startTime);
		const timeStr = t.status === "preparing" ? "" : formatDuration(elapsed);
		const icon = theme.fg("accent", t.status === "preparing" ? "✎" : spinner);
		const badge = theme.fg("dim", `[${t.index}]`);
		const labelName = toolDisplayLabel(t);
		const name = theme.bold(theme.fg("toolTitle", labelName));
		const time = theme.fg("muted", timeStr);

		const prefixWidth = 1 + 1 + 1 + visibleWidth(`[${t.index}]`) + 1 + visibleWidth(labelName) + 1;
		const timeWidth = 1 + visibleWidth(timeStr);
		const maxSummaryWidth = Math.max(0, availableWidth - prefixWidth - timeWidth);
		const summary =
			maxSummaryWidth > 0 && t.summaryDisplay
				? " " + theme.fg("dim", truncateToWidth(t.summaryDisplay, maxSummaryWidth))
				: "";
		return truncateToWidth(` ${icon} ${badge} ${name}${summary}${time}`, availableWidth);
	}

	// 多个任务并发执行：优先并排展示
	const parts = runningTools.map((t) => {
		const elapsed = Math.max(0, Date.now() - t.startTime);
		const timeStr = t.status === "preparing" ? "" : formatDuration(elapsed);
		const icon = theme.fg("accent", t.status === "preparing" ? "✎" : spinner);
		const badge = theme.fg("dim", `[${t.index}]`);
		const labelName = toolDisplayLabel(t);
		const name = theme.bold(theme.fg("toolTitle", labelName));
		const summary = t.summaryDisplay ? " " + theme.fg("dim", truncateToWidth(t.summaryDisplay, 15)) : "";
		const time = " " + theme.fg("muted", timeStr);
		return `${icon} ${badge} ${name}${summary}${time}`;
	});

	const fullJoined = ` ` + parts.join(theme.fg("dim", " │ "));
	if (visibleWidth(fullJoined) <= availableWidth) {
		return fullJoined;
	}

	// 若宽度不够并排，显示最新的一个任务 + (+N) 并发徽标
	const latest = runningTools[runningTools.length - 1];
	const elapsed = Math.max(0, Date.now() - latest.startTime);
	const timeStr = latest.status === "preparing" ? "" : formatDuration(elapsed);
	const icon = theme.fg("accent", latest.status === "preparing" ? "✎" : spinner);
	const badge = theme.fg("dim", `[${latest.index}]`);
	const labelName = toolDisplayLabel(latest);
	const name = theme.bold(theme.fg("toolTitle", labelName));
	const moreBadge = theme.fg("accent", `(+${runningTools.length - 1})`);
	const time = theme.fg("muted", timeStr);

	const prefixWidth = 1 + 1 + 1 + visibleWidth(`[${latest.index}]`) + 1 + visibleWidth(labelName) + 1;
	const suffixWidth = 1 + visibleWidth(`(+${runningTools.length - 1})`) + 1 + visibleWidth(timeStr);
	const maxSummaryWidth = Math.max(0, availableWidth - prefixWidth - suffixWidth);
	const summary =
		maxSummaryWidth > 0 && latest.summaryDisplay
			? " " + theme.fg("dim", truncateToWidth(latest.summaryDisplay, maxSummaryWidth))
			: "";
	return truncateToWidth(` ${icon} ${badge} ${name}${summary} ${moreBadge}${time}`, availableWidth);
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
	/** 点击 ➕ 按钮时的回调，由外部注入以打开 overlay 大窗体 */
	private onOpenOverlay: ((item?: ToolItem) => void) | null = null;
	/** 切换视图模式时的回调 */
	private onToggleMode: ((newMode: ViewMode) => void) | null = null;
	/** widget 中最多展示的条目数（overlay 仍可浏览全部历史） */
	private displayLimit: number;
	private actionSignal?: AbortSignal;

	constructor(
		tui: any,
		theme: any,
		state: WidgetState,
		onOpenOverlay?: (item?: ToolItem) => void,
		displayLimit = 3,
		onToggleMode?: (newMode: ViewMode) => void,
		actionSignal?: AbortSignal,
	) {
		this.tui = tui;
		this.theme = theme;
		this.state = state;
		this.onOpenOverlay = onOpenOverlay ?? null;
		this.displayLimit = Math.max(1, displayLimit);
		this.onToggleMode = onToggleMode ?? null;
		this.actionSignal = actionSignal;
	}

	render(width: number): string[] {
		this.lineMap = [];
		const lines: string[] = [];
		const theme = this.theme;
		if (width < 1) return lines;
		const renderWidth = Math.max(1, Math.floor(width));

		const pushLine = (
			text: string,
			item: ToolItem | null = null,
			kind: LineKind = "other",
			textToCopy?: string,
			buttonBounds?: ButtonBounds,
		) => {
			// Final invariant for every branch, including errors and async feedback.
			for (const physicalLine of text.replace(/\r/g, "").split("\n")) {
				const bounded = truncateToWidth(physicalLine, renderWidth);
				lines.push(bounded);
				this.lineMap.push({
					item,
					width: visibleWidth(bounded),
					kind,
					textToCopy,
					buttonBounds,
					hasOverlayButton: Boolean(buttonBounds?.overlayBtnStart !== undefined),
				});
			}
		};

		// 1. 常驻状态行（等待服务器响应 ➔ 思考中 ➔ 思考完成，共用一行平滑过渡）
		// 该行始终存在，作为滚动块的固定头部；➕ 大窗体按钮与 🔽/⏏️ 模式切换按钮固定显示在本行最右侧。
		{
			const modeBtnRaw = this.state.viewMode === "fixed" ? "🔽" : "⏏️";
			const modeBtnColored =
				this.state.viewMode === "running"
					? theme.fg("accent", modeBtnRaw)
					: theme.fg("dim", modeBtnRaw);

			const overlayBtnRaw = "➕";
			const overlayBtnColored = theme.fg("accent", overlayBtnRaw);

			const buttonsRawWidth = visibleWidth(modeBtnRaw) + 1 + visibleWidth(overlayBtnRaw);
			const showButtons = renderWidth > buttonsRawWidth;
			const availableWidth = Math.max(0, renderWidth - (showButtons ? buttonsRawWidth + 1 : 0));

			const runningTools = this.state.recentTools.filter(isPendingTool);

			let statusText: string;
			let headerItem: ToolItem | null = null;

			if (this.state.viewMode === "running" && runningTools.length > 0) {
				// 仅显示正在运行任务模式：直接显示到状态行，避免高度在 1 行与 2 行之间频繁跳动
				statusText = formatRunningTasksLine(runningTools, availableWidth, theme);
				headerItem = runningTools[runningTools.length - 1];
			} else if (this.state.headerStatus.type === "waiting_server") {
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

			statusText = truncateToWidth(statusText, availableWidth);
			const pad = Math.max(1, renderWidth - visibleWidth(statusText) - buttonsRawWidth);
			const headerLine = showButtons ? `${statusText}${' '.repeat(pad)}${modeBtnColored} ${overlayBtnColored}` : statusText;
			const lineW = visibleWidth(headerLine);

			const overlayBtnStart = lineW - visibleWidth(overlayBtnRaw);
			const overlayBtnEnd = lineW;
			const modeBtnEnd = overlayBtnStart - 1;
			const modeBtnStart = modeBtnEnd - visibleWidth(modeBtnRaw);

			pushLine(headerLine, headerItem, "header", undefined, showButtons ? {
				modeBtnStart,
				modeBtnEnd,
				overlayBtnStart,
				overlayBtnEnd,
			} : undefined);
		}

		// 1.5 错误提示行（单行紧凑展示，running / fixed 两种模式下均可见；
		// 展开详情可查看完整错误输出，避免错误信息在 running 模式下无处可达）
		if (this.state.activeError) {
			const err = this.state.activeError;
			const label = `[#${err.index} ${err.toolName}]`;
			const prefix = ` ${theme.fg("error", "✗")} ${theme.bold(theme.fg("error", label))}`;
			const budget = Math.max(0, renderWidth - visibleWidth(prefix) - 1);
			const msg = truncateToWidth(err.message.replace(/\r?\n/g, " "), budget);
			pushLine(`${prefix} ${theme.fg("muted", msg)}`, null, "detail_info");
		}

		// 2. 滚动工具列表（仅在 fixed 模式下在下方展示固定行数；running 模式下已合并至状态行，避免频繁上下闪烁）
		if (this.state.viewMode === "fixed") {
			const visibleTools = this.state.recentTools.slice(-this.displayLimit);
			for (const t of visibleTools) {
				const isExpanded = this.state.expandedItemId === t.id;
				let icon = theme.fg("accent", t.status === "preparing" ? "✎" : "⏳");
				if (t.status === "done") icon = theme.fg("success", "✓");
				if (t.status === "error") icon = theme.fg("error", "✗");

				const arrow = isExpanded ? theme.fg("accent", "▾") : theme.fg("dim", "▸");
				const badge = theme.fg("dim", `[${t.index}]`);
				const labelName = toolDisplayLabel(t);
				const name = theme.bold(theme.fg("toolTitle", labelName));
				const summary = theme.fg("dim", t.summaryDisplay);

				let time = "";
				if (t.status === "running") {
					const elapsed = Math.max(0, Date.now() - t.startTime);
					const timeStr = formatDuration(elapsed);
					time = theme.fg("muted", timeStr);
				} else if (t.durationMs !== undefined) {
					const timeStr = formatDuration(t.durationMs);
					time = theme.fg("muted", timeStr);
				}

				const toolHeaderLines = wrapToolHeaderLines(
					icon,
					arrow,
					badge,
					name,
					t.summaryDisplay,
					time,
					renderWidth,
					(s) => theme.fg("dim", s),
				);
				for (const headerLine of toolHeaderLines) {
					pushLine(headerLine, t, "header");
				}

				// 点击展开详情：展示完整路径/完整命令以及输出结果
				if (isExpanded) {
					if (t.fullPath) {
						const pathLines = wrapPrefixedText(
							t.fullPath,
							renderWidth,
							"   ↳ ",
							"     ",
							(s) => theme.fg("accent", s),
						);
						for (const pLine of pathLines) {
							pushLine(pLine, t, "detail_copyable", t.fullPath);
						}
					} else if (t.fullCommand) {
						const cmdLines = t.fullCommand.split("\n").slice(0, 8);
						for (const cmdLine of cmdLines) {
							const wrappedCmds = wrapPrefixedText(
								cmdLine,
								renderWidth,
								"   ↳ $ ",
								"       ",
								(s) => theme.fg("accent", s),
							);
							for (const cLine of wrappedCmds) {
								pushLine(cLine, t, "detail_copyable", t.fullCommand);
							}
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
								const wrappedOuts = wrapPrefixedText(
									outLine,
									renderWidth,
									"   ↳ ",
									"     ",
									(s) => theme.fg("muted", s),
								);
								for (const oLine of wrappedOuts) {
									pushLine(oLine, t, "detail_copyable", cleanOutput);
								}
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
		}

		// 3. 复制成功反馈（仅在 Widget 内部就地显示，绝对 0 污染）
		if (this.state.copyFeedbackMessage) {
			pushLine(`   ${theme.fg(this.state.copyFeedbackMessage.startsWith("✗") ? "error" : "success", `↳ ${this.state.copyFeedbackMessage}`)}`);
		}

		// 4. 主回复完成标识（仅在整个 Agent 回复完全生成完毕后才附带显示）
		if (this.state.completedMessage) {
			pushLine(` ${theme.fg("success", `✓ ${this.state.completedMessage}`)}`);
		}

		return lines;
	}

	private triggerCopy(textToCopy: string, label: string): void {
		void copyToClipboard(textToCopy, this.actionSignal).then(result => {
			this.showActionFeedback(result.ok
				? `✓ 已复制${label}至剪贴板: ${truncate(textToCopy, 45)}`
				: `✗ 复制失败: ${result.error}`);
		});
	}

	private showActionFeedback(message: string): void {
		if (this.actionSignal?.aborted) return;
		this.state.copyFeedbackMessage = message;
		if (this.copyFeedbackTimer) clearTimeout(this.copyFeedbackTimer);
		this.copyFeedbackTimer = setTimeout(() => {
			this.state.copyFeedbackMessage = null;
			this.tui?.requestRender?.();
		}, 2500);
		if (typeof this.copyFeedbackTimer === "object" && this.copyFeedbackTimer && "unref" in this.copyFeedbackTimer) {
			this.copyFeedbackTimer.unref();
		}

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
			// 0. 头部按钮点击处理（模式切换按钮 🔽/⏏️ 与 ➕ 大窗体按钮）
			if (lineEntry?.buttonBounds && event.button !== "right") {
				const { modeBtnStart, overlayBtnStart } = lineEntry.buttonBounds;
				// 点击最右侧 ➕ 按钮：打开 overlay 大窗体
				if (overlayBtnStart !== undefined && event.x >= overlayBtnStart) {
					this.onOpenOverlay?.(targetItem ?? undefined);
					return { handled: true };
				}
				// 点击层级/模式切换按钮 🔽/⏏️：在“固定最近行数”与“仅显示正在执行”之间切换
				if (
					modeBtnStart !== undefined &&
					overlayBtnStart !== undefined &&
					event.x >= modeBtnStart &&
					event.x < overlayBtnStart
				) {
					this.state.viewMode = this.state.viewMode === "fixed" ? "running" : "fixed";
					this.onToggleMode?.(this.state.viewMode);
					this.tui?.requestRender?.();
					return { handled: true };
				}
			}

			// 兼容旧版仅标记 hasOverlayButton 的情况
			if (lineEntry?.hasOverlayButton && !lineEntry.buttonBounds && event.button !== "right") {
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
				if (event.ctrl && event.button === "left" && targetItem.fullPath) {
					const filePath = targetItem.fullPath;
					void openLocalFile(filePath, this.actionSignal).then(result => {
						this.showActionFeedback(result.ok ? `✓ 已发送打开请求: ${filePath}` : `✗ 打开失败: ${result.error}`);
					});
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
	private actionSignal?: AbortSignal;
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
		actionSignal?: AbortSignal,
	) {
		this.tui = tui;
		this.theme = theme;
		this.allItems = items;
		this.step = Math.max(1, step);
		this.onClose = onClose;
		this.requestRender = requestRender;
		this.actionSignal = actionSignal;
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
		if (t.status === "preparing") return theme.fg("accent", "✎");
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
				? theme.bold(theme.fg("accent", toolDisplayLabel(t)))
				: theme.fg("toolTitle", toolDisplayLabel(t));
			const fixedWidth = visibleWidth(`${marker}${this.statusIcon(t)} ${badge} ${name} `);
			const summaryMaxCols = Math.max(0, listWidth - fixedWidth);
			const summary = summaryMaxCols > 0
				? theme.fg("dim", truncateToWidth(t.summaryDisplay, summaryMaxCols))
				: "";
			const row = `${marker}${this.statusIcon(t)} ${badge} ${name}${summary ? ` ${summary}` : ""}`;
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
			// 严格按可见终端列宽进行左侧对齐截断/补齐，保证无论包含何种字符都不会溢出冲撞分隔线
			const leftColWidth = visibleWidth(left);
			const leftPadded = leftColWidth <= listWidth
				? left + " ".repeat(listWidth - leftColWidth)
				: truncateToWidth(left, listWidth);
			const sep = theme.fg("dim", " │ ");
			const content = `${leftPadded}${sep}${right}`;
			const pad = Math.max(0, boxW - 2 - visibleWidth(content));
			boxLines.push(`${borderColor("│")}${content}${' '.repeat(pad)}${borderColor("│")}`);
		}

		// 底部提示（优先显示复制反馈）
		boxLines.push(`${borderColor("├")}${theme.fg("dim", "─".repeat(boxW - 2))}${borderColor("┤")}`);
		let hintText: string;
		if (this.copyFeedback) {
			hintText = theme.fg(this.copyFeedback.startsWith("✗") ? "error" : "success", this.copyFeedback);
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

		out.push(theme.bold(theme.fg("toolTitle", `${toolDisplayLabel(t)}  [${t.index}]`)));
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

		// 展示完整输入参数（若存在且与 detailContent 不完全重复）
		let inputToShow: any = t.rawInput;
		if (inputToShow === undefined || inputToShow === null) {
			inputToShow = tryParseJson(t.summaryDisplay);
		}
		if (inputToShow !== undefined && inputToShow !== null) {
			out.push(theme.fg("accent", "── 输入参数 ──"));
			const formattedInput = typeof inputToShow === "string"
				? inputToShow
				: JSON.stringify(inputToShow, null, 2);
			for (const raw of formattedInput.split("\n")) {
				out.push(...this.wrapLine(raw, width, (line) => theme.fg("text", line)));
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
		const label = t.detailContent
			? t.detailKind === "diff"
				? "diff"
				: "内容"
			: t.fullCommand
				? "命令"
				: t.fullPath
					? "路径"
					: "输出";
		void copyToClipboard(text, this.actionSignal).then(result => {
			if (this.actionSignal?.aborted) return;
			this.copyFeedback = result.ok
				? `✓ 已复制${label}: ${truncate(text.replace(/\r?\n/g, " "), 50)}`
				: `✗ 复制失败: ${result.error}`;
			if (this.copyFeedbackTimer) clearTimeout(this.copyFeedbackTimer);
			this.copyFeedbackTimer = setTimeout(() => {
				this.copyFeedback = null;
				this.requestRender();
			}, 2500);
			this.copyFeedbackTimer.unref?.();
			this.requestRender();
		});
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
 * 判断某个 status key 是否属于“常驻状态”。
 * 常驻状态（如 pi-blackhole 的仪表盘、MCP 的服务器状态）完全放行：
 * 不倒计时，也不拦截它自己的清除调用。
 */
function isPersistentStatusKey(key: string, rules?: StatusEnhancementRule[]): boolean {
	if (!rules || !Array.isArray(rules)) return false;
	return rules.some((rule) =>
		(rule.persistentKeys ?? []).some((pattern) => matchesToolRule(pattern, key)),
	);
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
	if (!dynamicHooks.assistantInstalled) {
		dynamicHooks.assistantInstalled = true;
		const originalUpdate = AssistantMessageComponent.prototype.updateContent;
		const originalRender = AssistantMessageComponent.prototype.render;
		AssistantMessageComponent.prototype.updateContent = function (this: any, message: any, isStreaming?: boolean) {
			if (dynamicHooks.handleAssistantContent) dynamicHooks.handleAssistantContent(this, message, isStreaming, originalUpdate);
			else originalUpdate.call(this, message, isStreaming);
		};
		AssistantMessageComponent.prototype.render = function (this: any, width: number) {
			if (dynamicHooks.handleAssistantRender) return dynamicHooks.handleAssistantRender(this, width, originalRender);
			// A component rendered while the extension was loaded may still have a
			// filtered visual tree. Rebuild once from the retained original message.
			if (this[ASSISTANT_DISPLAY_FILTERED] && this.lastMessage) {
				this[ASSISTANT_DISPLAY_FILTERED] = false;
				this.updateContent(this.lastMessage);
			}
			return originalRender.call(this, width);
		};
	}
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

const ROLLING_TOOLS_SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "status", label: "status", description: "查看当前运行状态、视图模式与配置信息" },
	{ value: "mode", label: "mode", description: "切换视图模式 (running | fixed)" },
	{ value: "clear", label: "clear", description: "清空当前工具历史记录与错误提示" },
	{ value: "history", label: "history", description: "打开工具历史大窗体 (Overlay)" },
	{ value: "on", label: "on", description: "启用工具静音与滚动条" },
	{ value: "off", label: "off", description: "禁用工具静音与滚动条" },
	{ value: "reload", label: "reload", description: "从磁盘重新载入配置" },
	{ value: "migrate", label: "migrate", description: "升级配置文件到最新规范 (v3)" },
];

/**
 * rolling-tools 命令参数补全
 */
export function getRollingToolsArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const prefix = (argumentPrefix || "").trimStart();

	if (prefix.startsWith("mode")) {
		const sub = prefix.slice(4).trimStart();
		const options: AutocompleteItem[] = [
			{ value: "mode running", label: "running", description: "仅显示正在执行的任务（单行状态行）" },
			{ value: "mode fixed", label: "fixed", description: "固定展示最近 N 行工具历史" },
		];
		const filtered = options.filter(
			(o) => o.label.toLowerCase().startsWith(sub.toLowerCase()) || o.value.toLowerCase().startsWith(prefix.toLowerCase()),
		);
		return filtered.length > 0 ? filtered : options;
	}

	const filtered = ROLLING_TOOLS_SUBCOMMANDS.filter((item) =>
		item.value.toLowerCase().startsWith(prefix.toLowerCase()),
	);
	return filtered.length > 0 ? filtered : null;
}

export default function rollingTools(pi: ExtensionAPI): void {
	let initialLoad = loadConfig(process.cwd());
	let currentConfig: RollingToolsConfig = initialLoad.config;
	let totalToolCount = 0;
	let statusTimer: any = null;
	let lastCtx: any = null;
	let hooksActive = true;
	const desktopActions = new AbortController();
	const streamedDrafts = new Set<string>();
	const uiHookCleanups: Array<() => void> = [];
	let legacyNoticeTimer: ReturnType<typeof setTimeout> | undefined;
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
		viewMode: currentConfig.defaultViewMode ?? "fixed",
	};

	/** 当前打开的历史大窗体（用于实时刷新与去重） */
	let activeOverlay: ToolHistoryOverlayComponent | null = null;

	// 1. 安装底层全局原型钩子骨架（单例）
	ensureGlobalPrototypeHooksInstalled();

	// 1.5 注册工具渲染器：剥掉插件在工具行里重复画的提示头（通道 C）
	installToolNotificationStripper(pi, () => currentConfig.enabled && currentConfig.stripToolNotificationHeaders !== false);

	// Filter only the component's view, never agent messages or persisted signatures.
	dynamicHooks.handleAssistantContent = (target, message, isStreaming, original) => {
		const hide = currentConfig.enabled && hooksActive;
		const view = hide && Array.isArray(message.content)
			? { ...message, content: message.content.filter((block: any) => block.type !== "thinking") }
			: message;
		original.call(target, view, isStreaming);
		target.lastMessage = message;
		target[ASSISTANT_DISPLAY_FILTERED] = hide;
	};
	dynamicHooks.handleAssistantRender = (target, width, original) => {
		if (target.lastMessage && Boolean(target[ASSISTANT_DISPLAY_FILTERED]) !== currentConfig.enabled) {
			target.updateContent(target.lastMessage);
		}
		return original.call(target, width);
	};

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
		if (!currentConfig.enabled) return origFn.call(target, message, type);
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
		if (!currentConfig.enabled) return origFn.call(target, key, text);
		// 常驻状态（如 blackhole 仪表盘、MCP 服务器状态）：完全放行。
		// 不倒计时，也不拦截它们自己的清除调用，否则会卡住不消失。
		if (isPersistentStatusKey(key, currentConfig.statusEnhancements)) {
			return origFn.call(target, key, text);
		}

		const rule = findStatusEnhancementRule(key, currentConfig.statusEnhancements);

		// 只有显式配置了 durationMs 的规则才做“自动消失”。
		// 默认（durationMs 不设）仅做着色，不接管生命周期。
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
				// 外部（插件）主动清除：若仍在倒计时窗口内，交给我们的定时器统一收尾；
				// 否则直接放行。
				const remaining = activeStatusStartTime + rule.durationMs - Date.now();
				if (remaining > 0 && lastActiveStatusRawText) {
					return;
				}
			}
		}

		// 未配 durationMs，或规则未命中：仅做着色（如果有 colorize），不接管生命周期。
		if (rule?.colorize && typeof text === "string" && text.length > 0) {
			return origFn.call(target, key, autoColorizeStatusText(text));
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
		if (!currentConfig.enabled || !hooksActive) return;
		statusTimer = setInterval(() => {
			syncWidget(ctx);
		}, 100);
		if (typeof statusTimer === "object" && statusTimer && "unref" in statusTimer) {
			(statusTimer as any).unref();
		}
	}

	/**
	 * 从当前 session 的 entries 中恢复最近一次滚动历史快照。
	 */
	function restoreHistoryFromSession(
		ctx: any,
	): { items: ToolItem[]; total: number; viewMode?: ViewMode } | null {
		try {
			const entries = ctx?.sessionManager?.getBranch?.();
			if (!Array.isArray(entries)) return null;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry?.type === "custom" && entry?.customType === HISTORY_ENTRY_TYPE) {
					const res = deserializeHistory(entry.data);
					if (res && res.items) {
						backfillInputsFromSession(entries, res.items);
					}
					return res;
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
			pi.appendEntry(HISTORY_ENTRY_TYPE, serializeHistory(state.recentTools, totalToolCount, state.viewMode));
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
					() => {
						persistHistory();
					},
					desktopActions.signal,
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
		if (!ctx?.hasUI || ctx.mode === "rpc" || !ctx.ui?.custom) {
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
						desktopActions.signal,
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
		const hookKey = Symbol.for("pi-rolling-tools.contextUiHook.v2");
		if (ui[hookKey]) return;
		const owner = {};
		ui[hookKey] = owner;

		const originalNotifyMethod = ui.notify;
		const originalNotify = originalNotifyMethod?.bind(ui);
		if (originalNotify) {
			const wrappedNotify = (message: string, type?: string) => {
				if (!currentConfig.enabled || !hooksActive) return originalNotify(message, type);
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
			ui.notify = wrappedNotify;
			uiHookCleanups.push(() => {
				if (ui.notify === wrappedNotify) ui.notify = originalNotifyMethod;
				if (ui[hookKey] === owner) delete ui[hookKey];
			});
		}
	}

	// 2. 会话启动
	pi.on("session_start", async (event, ctx) => {
		streamedDrafts.clear();
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
		state.recentTools = [];
		totalToolCount = 0;
		if (currentConfig.persistAcrossSessions) {
			const restored = restoreHistoryFromSession(ctx);
			if (restored) {
				state.recentTools = restored.items;
				totalToolCount = restored.total;
				if (restored.viewMode) {
					state.viewMode = restored.viewMode;
				}
			}
		}

		syncWidget(ctx);

		// 旧配置迁移提示（一次性，延后到 UI 就绪后展示）
		if (pendingLegacyNotice) {
			const notice = pendingLegacyNotice;
			pendingLegacyNotice = undefined;
			legacyNoticeTimer = setTimeout(() => {
				legacyNoticeTimer = undefined;
				if (!hooksActive) return;
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

		// 工具调用流式输出时：提前捕获并实时更新正在准备执行的命令，
		// 避免思考完成后界面停滞数秒、直到工具执行完才“闪一下”
		if (event.message?.role === "assistant" && Array.isArray(event.message.content)) {
			const cwd = ctx?.cwd || process.cwd();
			let hasToolChanges = false;
			let hasStreamingTools = false;

			for (const c of event.message.content) {
				if (c && c.type === "toolCall" && c.id && c.name) {
					if (!shouldIncludeInWidget(c.name, currentConfig)) {
						continue;
					}
					const existing = state.recentTools.find((t) => t.id === c.id);
					if (existing && !isPendingTool(existing)) continue;
					if (!existing || existing.status === "preparing") {
						hasStreamingTools = true;
						streamedDrafts.add(c.id);
					}
					const { summaryDisplay, fullPath, fullCommand, displayName, detailContent, detailKind } =
						extractSummaryAndMetadata(c.name, c.arguments, cwd, currentConfig);

					if (existing) {
						existing.rawInput = c.arguments ?? existing.rawInput;
						if (
							existing.summaryDisplay !== summaryDisplay ||
							existing.fullPath !== fullPath ||
							existing.fullCommand !== fullCommand ||
							existing.detailContent !== detailContent
						) {
							existing.summaryDisplay = summaryDisplay || existing.summaryDisplay;
							if (fullPath) existing.fullPath = fullPath;
							if (fullCommand) existing.fullCommand = fullCommand;
							if (displayName) existing.displayName = displayName;
							if (detailContent) existing.detailContent = detailContent;
							if (detailKind) existing.detailKind = detailKind;
							hasToolChanges = true;
						}
					} else {
						totalToolCount++;
						state.recentTools.push({
							id: c.id,
							index: totalToolCount,
							name: c.name,
							displayName,
							summaryDisplay,
							fullPath,
							fullCommand,
							rawInput: c.arguments,
							detailContent,
							detailKind,
							status: "preparing",
							startTime: Date.now(),
						});

						trimToolHistory();
						hasToolChanges = true;
					}
				}
			}

			if (hasStreamingTools) {
				startStatusTimer(ctx);
				state.activeError = null;
			}
			if (hasToolChanges) {
				syncWidget(ctx);
			}
		}
	});

	function trimToolHistory(): void {
		let excess = Math.max(0, state.recentTools.length - HISTORY_MEMORY_LIMIT);
		for (let index = 0; excess > 0 && index < state.recentTools.length;) {
			if (isPendingTool(state.recentTools[index])) { index++; continue; }
			state.recentTools.splice(index, 1);
			excess--;
		}
	}

	/** Apply completion from hooks, execution events or persisted result messages. */
	function recordToolCompletion(event: {
		toolCallId: string; toolName: string; isError: boolean;
		content?: unknown; details?: unknown; durationMs?: number;
	}, authoritativeDuration = false): void {
		streamedDrafts.delete(event.toolCallId);
		const item = state.recentTools.find(tool => tool.id === event.toolCallId);
		const content = Array.isArray(event.content) ? event.content : [];
		const text = content.find((block: any) => block?.type === "text" && typeof block.text === "string")?.text;
		if (item) {
			const previous = item.status;
			item.status = event.isError ? "error" : "done";
			if (authoritativeDuration || event.durationMs !== undefined) {
				// Core duration excludes parameter streaming and approval waits.
				// Undefined on an execution-end event means execute() did not run.
				item.durationMs = event.durationMs;
			} else if (previous === "running" && item.durationMs === undefined) {
				item.durationMs = Math.max(0, Date.now() - item.startTime);
			}
			if (typeof text === "string") item.output = text;
			const details = event.details as { diff?: unknown } | undefined;
			if (!item.detailContent && typeof details?.diff === "string" && details.diff) {
				item.detailContent = details.diff;
				item.detailKind = "diff";
			}
		}
		if (event.isError) {
			state.activeError = {
				toolName: event.toolName,
				index: item?.index ?? totalToolCount,
				summary: item?.summaryDisplay || "",
				message: typeof text === "string" ? text.trim() : "Tool execution failed",
			};
		} else {
			state.activeError = null;
		}
		trimToolHistory();
	}

	function refreshToolActivity(ctx: ExtensionContext): void {
		if (state.recentTools.some(isPendingTool)) {
			if (!statusTimer) startStatusTimer(ctx);
		} else if (state.headerStatus.type !== "thinking" && state.headerStatus.type !== "waiting_server") {
			stopStatusTimer();
		}
		syncWidget(ctx);
	}

	function interruptTool(item: ToolItem, reason: string): void {
		const wasRunning = item.status === "running";
		item.status = "error";
		item.durationMs = wasRunning ? Math.max(0, Date.now() - item.startTime) : undefined;
		item.output = item.output || (wasRunning ? `执行中断：${reason}` : `未执行：${reason}`);
	}

	function closeUnfinishedTools(reason: string): boolean {
		streamedDrafts.clear();
		const unfinished = state.recentTools.filter(isPendingTool);
		for (const item of unfinished) interruptTool(item, reason);
		trimToolHistory();
		return unfinished.length > 0;
	}

	// A streamed tool-call draft is not proof of dispatch. Failed/aborted
	// responses can be omitted by core retries without ever emitting tool_result.
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role === "toolResult") {
			recordToolCompletion(message, true);
			refreshToolActivity(ctx);
			return;
		}
		if (message.role !== "assistant") return;
		const ids = new Set(message.content.filter(block => block.type === "toolCall").map(block => block.id));
		const failed = message.stopReason === "error" || message.stopReason === "aborted";
		const previews = new Set(streamedDrafts);
		streamedDrafts.clear();
		const reason = failed
			? message.errorMessage || (message.stopReason === "aborted" ? "模型响应已取消" : "模型响应失败")
			: "流式草稿未进入最终工具调用";
		for (const item of state.recentTools) {
			// Final errors may omit their partial content entirely. Also retire
			// preview calls retracted by a successful final message, but never
			// touch a real sibling execution or another call based on age/index.
			const withdrawn = failed ? previews.has(item.id) || ids.has(item.id) : previews.has(item.id) && !ids.has(item.id);
			if (item.status === "preparing" && withdrawn) interruptTool(item, reason);
		}
		trimToolHistory();
		if (failed && (state.headerStatus.type === "waiting_server" || state.headerStatus.type === "thinking")) {
			state.headerStatus = { type: "idle" };
		}
		refreshToolActivity(ctx);
	});

	// Core has awaited all dispatched calls at agent_end. Reconcile finalized
	// messages first, then close any draft/call missing its terminal event.
	pi.on("agent_end", async (event, ctx) => {
		for (const message of event.messages) {
			if (message.role === "toolResult") recordToolCompletion(message, true);
		}
		closeUnfinishedTools("本轮已结束，未收到该工具的完成事件");
		stopStatusTimer();
		if (state.headerStatus.type === "waiting_server" || state.headerStatus.type === "thinking") {
			state.headerStatus = { type: "idle" };
		}
		persistHistory();
		syncWidget(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const changed = closeUnfinishedTools("Agent 已停止，未收到该工具的完成事件");
		stopStatusTimer();
		if (state.headerStatus.type === "waiting_server" || state.headerStatus.type === "thinking") {
			state.headerStatus = { type: "idle" };
		}
		if (changed) persistHistory();
		state.completedMessage = "Completed";
		syncWidget(ctx);
	});

	function startTool(toolCallId: string, toolName: string, input: unknown, ctx: ExtensionContext): void {
		streamedDrafts.delete(toolCallId);
		if (!shouldIncludeInWidget(toolName, currentConfig)) return;
		if (state.headerStatus.type === "waiting_server") state.headerStatus = { type: "idle" };
		const metadata = extractSummaryAndMetadata(toolName, input, ctx.cwd || process.cwd(), currentConfig);
		const existing = state.recentTools.find(tool => tool.id === toolCallId);
		if (existing) {
			existing.rawInput = input ?? existing.rawInput;
			existing.summaryDisplay = metadata.summaryDisplay || existing.summaryDisplay;
			if (metadata.fullPath) existing.fullPath = metadata.fullPath;
			if (metadata.fullCommand) existing.fullCommand = metadata.fullCommand;
			if (metadata.displayName) existing.displayName = metadata.displayName;
			if (metadata.detailContent) existing.detailContent = metadata.detailContent;
			if (metadata.detailKind) existing.detailKind = metadata.detailKind;
			if (existing.status !== "running") {
				existing.startTime = Date.now();
				existing.durationMs = undefined;
			}
			existing.status = "running";
		} else {
			state.recentTools.push({
				id: toolCallId, index: ++totalToolCount, name: toolName,
				...metadata, rawInput: input, status: "running", startTime: Date.now(),
			});
			trimToolHistory();
		}
		if (state.expandedItemId && !state.recentTools.some(tool => tool.id === state.expandedItemId)) {
			state.expandedItemId = null;
		}
		refreshToolActivity(ctx);
	}

	pi.on("tool_execution_start", (event, ctx) => {
		startTool(event.toolCallId, event.toolName, event.args, ctx);
	});

	// Retain compatibility with hook-only integrations; don't restart a clock
	// that tool_execution_start has already started.
	pi.on("tool_call", (event, ctx) => {
		const existing = state.recentTools.find(tool => tool.id === event.toolCallId);
		if (existing && !isPendingTool(existing)) return;
		startTool(event.toolCallId, event.toolName, event.input, ctx);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		recordToolCompletion({
			toolCallId: event.toolCallId, toolName: event.toolName,
			isError: event.isError, content: event.result?.content, details: event.result?.details,
			durationMs: event.durationMs,
		}, true);
		refreshToolActivity(ctx);
	});

	pi.on("tool_result", (event, ctx) => {
		recordToolCompletion(event);
		refreshToolActivity(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		streamedDrafts.clear();
		stopStatusTimer();
		const restored = currentConfig.persistAcrossSessions ? restoreHistoryFromSession(ctx) : null;
		state.recentTools = restored?.items ?? [];
		totalToolCount = restored?.total ?? 0;
		if (restored?.viewMode) state.viewMode = restored.viewMode;
		state.headerStatus = { type: "idle" };
		state.activeError = null;
		syncWidget(ctx);
	});

	// Prototype wrappers are process-wide, but their delegates belong to this
	// runtime. Removing the extension must leave inert pass-through wrappers.
	const ownedHooks = {
		assistantContent: dynamicHooks.handleAssistantContent,
		assistantRender: dynamicHooks.handleAssistantRender,
		render: dynamicHooks.handleToolRender,
		notify: dynamicHooks.handleShowExtensionNotify,
		status: dynamicHooks.handleSetExtensionStatus,
	};
	pi.on("session_shutdown", async () => {
		closeUnfinishedTools("扩展运行时已关闭");
		persistHistory();
		hooksActive = false;
		desktopActions.abort();
		for (const cleanup of uiHookCleanups.splice(0)) cleanup();
		if (dynamicHooks.handleAssistantContent === ownedHooks.assistantContent) dynamicHooks.handleAssistantContent = undefined;
		if (dynamicHooks.handleAssistantRender === ownedHooks.assistantRender) dynamicHooks.handleAssistantRender = undefined;
		if (dynamicHooks.handleToolRender === ownedHooks.render) dynamicHooks.handleToolRender = undefined;
		if (dynamicHooks.handleShowExtensionNotify === ownedHooks.notify) dynamicHooks.handleShowExtensionNotify = undefined;
		if (dynamicHooks.handleSetExtensionStatus === ownedHooks.status) dynamicHooks.handleSetExtensionStatus = undefined;
		if (legacyNoticeTimer) clearTimeout(legacyNoticeTimer);
		stopStatusTimer();
		if (activeStatusInterval) {
			clearInterval(activeStatusInterval);
			activeStatusInterval = null;
		}
	});

	// 10. 管理控制命令
	pi.registerCommand("rolling-tools", {
		description: "Manage rolling tools widget mode, configuration, and reload",
		getArgumentCompletions: getRollingToolsArgumentCompletions,
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
				stopStatusTimer();
				if (activeStatusInterval) {
					clearInterval(activeStatusInterval);
					activeStatusInterval = null;
				}
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
					`• 当前视图模式: ${state.viewMode === "running" ? "仅显示正在执行的任务" : `固定最近 ${currentConfig.maxRecentTools} 行`}`,
					`• widget 展示条数: ${currentConfig.maxRecentTools}（历史共 ${state.recentTools.length} 条）`,
					`• 默认视图模式: ${currentConfig.defaultViewMode ?? "fixed"}`,
					`• 静音工具规则: ${(currentConfig.silencedTools ?? currentConfig.managedTools).join(", ")}`,
					`• 收录工具规则: ${(currentConfig.widgetTools ?? currentConfig.managedTools).join(", ")}`,
					`• 懒加载步长: ${currentConfig.lazyLoadStep ?? 10} 条/次`,
					`• 跨会话持久化: ${currentConfig.persistAcrossSessions ? "已开启" : "已关闭"}`,
					`• 配置版本: v${currentConfig.configVersion ?? 1}${(currentConfig.configVersion ?? 1) < CONFIG_VERSION ? "（旧版，可执行 /rolling-tools migrate 升级）" : ""}`,
					`• 通知拦截: ${currentConfig.interceptNotifications.map((r) => r.match).join(", ") || "（无）"}（例外关键词 ${(currentConfig.notificationKeywords ?? []).length} 个）`,
					`• status 时长: ${currentConfig.statusEnhancements?.[0]?.durationMs ?? "默认"}ms`,
					`• 剥离工具行提示头: ${currentConfig.stripToolNotificationHeaders !== false ? "已开启" : "已关闭"}`,
				].join("\n");
				await showStatusModal(ctx, "Rolling Tools", info.split("\n"));
			} else if (action === "mode" || action.startsWith("mode ")) {
				const target = action.slice(4).trim().toLowerCase();
				if (target === "running") {
					state.viewMode = "running";
				} else if (target === "fixed") {
					state.viewMode = "fixed";
				} else {
					state.viewMode = state.viewMode === "fixed" ? "running" : "fixed";
				}
				syncWidget(ctx);
				persistHistory();
				ctx.ui?.notify?.(
					`rolling-tools: 视图模式已切换为「${state.viewMode === "running" ? "仅显示正在执行的任务" : `固定最近 ${currentConfig.maxRecentTools} 行`}」`,
					"info",
				);
			} else if (action === "clear") {
				// The live overlay retains this array; clear it in place as well.
				state.recentTools.splice(0);
				streamedDrafts.clear();
				totalToolCount = 0;
				state.activeError = null;
				state.expandedItemId = null;
				state.completedMessage = null;
				persistHistory();
				syncWidget(ctx);
				activeOverlay?.refresh();
				ctx.ui?.notify?.("✓ rolling-tools: 工具历史已清空", "info");
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
