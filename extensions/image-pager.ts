import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

export type AgentMessage = ContextEvent["messages"][number];

export type PagingStrategy = "turn-boundary" | "fifo";

/**
 * 图像换页配置接口
 */
export interface ImagePagerConfig {
	/**
	 * 是否启用图像虚拟换页
	 * @default true
	 */
	enabled: boolean;

	/**
	 * 换页策略：
	 * - "turn-boundary" (默认，强烈推荐，Cache-Friendly): 当前活跃轮次（最新提问后读取的图片）保留原始像素，
	 *   历史已完成轮次立即固化为静态智能指针并永久冻结。历史前缀永远单调递增，彻底消除因突发新图导致的历史几十轮 KV-Cache 毁灭性击穿。
	 * - "fifo": 传统数量滑动窗口，无视轮次边界，始终仅保留全局最新 N 张图片。
	 * @default "turn-boundary"
	 */
	strategy: PagingStrategy;

	/**
	 * 在活跃上下文中保留的最新图片张数（Hot Pages）
	 * 在 fifo 策略下严格遵循此数值；在 turn-boundary 策略下主要作为回退/保底数量
	 * @default 1
	 */
	keepRecentImages: number;

	/**
	 * 针对哪些 Model 启用（支持通配符 *）
	 * @default ["*"]
	 */
	models: string[];

	/**
	 * 排除不换页的 Model 列表
	 * @default []
	 */
	excludeModels: string[];

	/**
	 * 触发换页的单张图片最小字节数阈值（Base64 字符串长度）
	 * 小于该阈值的微小图片（如小图标）保留；默认 0 表示对所有历史图片均换页
	 * @default 0
	 */
	minBytesThreshold: number;

	/**
	 * 智能指针自愈提示词语言：en（英文，大模型遵从度最高）| zh（中文）
	 * @default "en"
	 */
	noticeLanguage: "en" | "zh";

	/**
	 * 自定义提示词模板（可选）。可用占位符：{fileName}, {filePath}, {mimeType}, {size}, {readTool}
	 */
	customTemplate?: string;

	/**
	 * 是否在图片换出时发出提示通知
	 * @default false
	 */
	notifyOnPageOut: boolean;

	/**
	 * 是否打印调试日志
	 * @default false
	 */
	debug: boolean;
}

export const DEFAULT_CONFIG: ImagePagerConfig = {
	enabled: true,
	strategy: "turn-boundary",
	keepRecentImages: 1,
	models: ["*"],
	excludeModels: [],
	minBytesThreshold: 0,
	noticeLanguage: "en",
	notifyOnPageOut: false,
	debug: false,
};

/**
 * 单条换出记录
 */
export interface PagedOutImageRecord {
	path: string;
	fileName: string;
	mimeType: string;
	bytes: number;
	timestamp: number;
}

/**
 * 统计信息接口
 */
export interface ImagePagerStats {
	totalContextRuns: number;
	totalImagesSeen: number;
	pagedOutImagesCount: number;
	hotImagesRetained: number;
	savedBytes: number;
	estimatedTokensSaved: number;
	lastRunTimestamp: number;
	recentPagedOutImages: PagedOutImageRecord[];
}

const STATS_REF_SYMBOL = Symbol.for("__pi_image_pager_stats_ref__");
if (!(globalThis as any)[STATS_REF_SYMBOL]) {
	(globalThis as any)[STATS_REF_SYMBOL] = {
		totalContextRuns: 0,
		totalImagesSeen: 0,
		pagedOutImagesCount: 0,
		hotImagesRetained: 0,
		savedBytes: 0,
		estimatedTokensSaved: 0,
		lastRunTimestamp: 0,
		recentPagedOutImages: [],
	};
}
export const stats: ImagePagerStats = (globalThis as any)[STATS_REF_SYMBOL];

/**
 * 格式化字节数
 */
export function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * 估算单张图片的视觉 Token 数（多模态模型通常将图片切片为 1000~1600+ Tokens）
 */
export function estimateVisualTokens(bytes: number): number {
	// 基准每张图大约 1200 visual tokens，根据 Base64 大小做适当递增切片加权
	const baseTokens = 1200;
	const variableTokens = Math.round(bytes / 2048);
	return Math.min(8192, baseTokens + variableTokens);
}

/**
 * 通配符匹配函数
 */
export function matchesPattern(value: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern === value) return true;
	if (pattern.includes("*")) {
		const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
		return new RegExp(`^${escaped}$`, "i").test(value);
	}
	return pattern.toLowerCase() === value.toLowerCase();
}

export function matchesAnyPattern(value: string, patterns: string[]): boolean {
	return patterns.some((p) => matchesPattern(value, p));
}

/**
 * 判断当前配置和模型是否应启用换页
 */
export function shouldEnableForModel(modelName: string | undefined, config: ImagePagerConfig): boolean {
	if (!config.enabled) return false;
	const name = modelName ?? "";
	if (config.excludeModels.length > 0 && matchesAnyPattern(name, config.excludeModels)) {
		return false;
	}
	if (config.models.length > 0) {
		return matchesAnyPattern(name, config.models);
	}
	return true;
}

/**
 * 获取全局配置路径
 */
export function getGlobalConfigDir(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(agentDir, "extensions", "image-pager");
}

export function getGlobalConfigPath(): string {
	return join(getGlobalConfigDir(), "config.json");
}

export function getProjectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "image-pager.json");
}

/**
 * 配置加载与合并
 */
export function mergeConfig(base: ImagePagerConfig, overrides: Partial<ImagePagerConfig>): ImagePagerConfig {
	return {
		...base,
		...overrides,
		strategy:
			overrides.strategy === "turn-boundary" || overrides.strategy === "fifo"
				? overrides.strategy
				: base.strategy,
		keepRecentImages:
			typeof overrides.keepRecentImages === "number" && overrides.keepRecentImages >= 0
				? overrides.keepRecentImages
				: base.keepRecentImages,
		minBytesThreshold:
			typeof overrides.minBytesThreshold === "number" && overrides.minBytesThreshold >= 0
				? overrides.minBytesThreshold
				: base.minBytesThreshold,
		models: Array.isArray(overrides.models) ? [...overrides.models] : base.models,
		excludeModels: Array.isArray(overrides.excludeModels) ? [...overrides.excludeModels] : base.excludeModels,
	};
}

export function loadConfig(cwd?: string): ImagePagerConfig {
	let config = { ...DEFAULT_CONFIG };

	const globalPath = getGlobalConfigPath();
	if (existsSync(globalPath)) {
		try {
			const content = readFileSync(globalPath, "utf-8");
			const parsed = JSON.parse(content);
			config = mergeConfig(config, parsed);
		} catch (e) {
			console.error(`[image-pager] Failed to parse global config at ${globalPath}:`, e);
		}
	}

	if (cwd) {
		const projectPath = getProjectConfigPath(cwd);
		if (existsSync(projectPath)) {
			try {
				const content = readFileSync(projectPath, "utf-8");
				const parsed = JSON.parse(content);
				config = mergeConfig(config, parsed);
			} catch (e) {
				console.error(`[image-pager] Failed to parse project config at ${projectPath}:`, e);
			}
		}
	}

	return config;
}

export function saveConfig(config: ImagePagerConfig, targetPath?: string): boolean {
	const filePath = targetPath || getGlobalConfigPath();
	try {
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
		return true;
	} catch (e) {
		console.error(`[image-pager] Failed to save config to ${filePath}:`, e);
		return false;
	}
}

/**
 * 规范化文件物理路径（统一路径展示格式）
 */
export function normalizeDisplayPath(rawPath: string, cwd?: string): string {
	let p = rawPath.trim();
	if (cwd && !isAbsolute(p)) {
		p = resolve(cwd, p);
	}
	return normalize(p).replace(/\\/g, "/");
}

/**
 * 构建智能指针自愈占位符文本
 */
export function buildSmartPointerNotice(
	options: {
		fileName: string;
		filePath?: string;
		mimeType: string;
		bytes: number;
		config: ImagePagerConfig;
	},
): string {
	const { fileName, filePath, mimeType, bytes, config } = options;
	const formattedSize = formatBytes(bytes);

	if (config.customTemplate) {
		return config.customTemplate
			.replace(/\{fileName\}/g, fileName)
			.replace(/\{filePath\}/g, filePath || "(unknown path)")
			.replace(/\{mimeType\}/g, mimeType)
			.replace(/\{size\}/g, formattedSize)
			.replace(/\{readTool\}/g, "read");
	}

	if (config.noticeLanguage === "zh") {
		if (filePath) {
			return `[系统提示：图片 "${fileName}" 已从工作上下文换出（Page-Out）以优化显存与推理延迟。
• 原始物理路径: "${filePath}"
• MIME 类型: ${mimeType}
• 换出体积: ${formattedSize} (Base64)
• 自愈唤醒指引: 本图片的原始像素已换出。如果你需要重新查看或核对上面对话中未记录的视觉微小细节，请直接对此路径调用 'read' 工具将其重新换入（Page-In）上下文。]`;
		}
		return `[系统提示：用户直传图片已从工作上下文换出（Page-Out）以优化显存与推理延迟。
• MIME 类型: ${mimeType}
• 换出体积: ${formattedSize} (Base64)
• 说明: 该图片由用户直接上传，无本地物理路径。如需再次查看原始像素，请提示用户重新提供该图片。]`;
	}

	// 默认英文模板（大模型遵从度最高）
	if (filePath) {
		return `[System Note: Image "${fileName}" has been paged out from context to save memory and inference time.
• Original File Path: "${filePath}"
• MIME Type: ${mimeType}
• Paged-out Size: ${formattedSize} (Base64)
• Self-Healing Guideline: The raw pixel data of this image is currently paged out from working memory. If you need to re-inspect or verify visual pixel details of this image that are not already documented in the conversation text above, invoke the 'read' tool on this path to page it back into context.]`;
	}

	return `[System Note: User-attached image paged out from context to save memory and inference time.
• MIME Type: ${mimeType}
• Paged-out Size: ${formattedSize} (Base64)
• Note: This image was directly attached by the user without a local file path. If visual pixel verification is required, please ask the user to re-attach or re-supply the image.]`;
}

/**
 * 内部定位项信息
 */
interface ImageOccurrence {
	messageIndex: number;
	contentIndex: number;
	mimeType: string;
	bytes: number;
	filePath?: string;
	fileName: string;
	isUserAttachment: boolean;
}

/**
 * 图像换页处理核心函数
 * 输入消息数组和配置，返回非破坏性修剪后的消息数组与本轮换页摘要
 */
export function pageOutContextImages(
	messages: AgentMessage[],
	config: ImagePagerConfig,
	cwd?: string,
): {
	messages: AgentMessage[];
	totalImages: number;
	pagedOutCount: number;
	retainedCount: number;
	savedBytes: number;
	estimatedTokens: number;
	pagedOutRecords: PagedOutImageRecord[];
} {
	if (!config.enabled) {
		return {
			messages,
			totalImages: 0,
			pagedOutCount: 0,
			retainedCount: 0,
			savedBytes: 0,
			estimatedTokens: 0,
			pagedOutRecords: [],
		};
	}

	// 1. 构建 toolCallId -> { toolName, filePath } 索引映射
	const toolCallMap = new Map<string, { toolName: string; filePath?: string }>();
	for (const msg of messages) {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "toolCall") {
					const toolName = block.name;
					const args = block.arguments as Record<string, any> | undefined;
					let filePath: string | undefined;
					if (args && typeof args === "object") {
						const candidate = args.path || args.file_path || args.filePath || args.target;
						if (typeof candidate === "string" && candidate.trim()) {
							filePath = normalizeDisplayPath(candidate, cwd);
						}
					}
					toolCallMap.set(block.id, { toolName, filePath });
				}
			}
		}
	}

	// 2. 收集整个上下文中的所有图片实体
	const occurrences: ImageOccurrence[] = [];

	for (let mIdx = 0; mIdx < messages.length; mIdx++) {
		const msg = messages[mIdx];

		if (msg.role === "toolResult" && Array.isArray(msg.content)) {
			const toolInfo = toolCallMap.get(msg.toolCallId);
			let filePath = toolInfo?.filePath;
			// details 中也可能包含 path
			if (!filePath && msg.details && typeof msg.details === "object") {
				const dPath = (msg.details as any).path || (msg.details as any).filePath;
				if (typeof dPath === "string" && dPath.trim()) {
					filePath = normalizeDisplayPath(dPath, cwd);
				}
			}

			for (let cIdx = 0; cIdx < msg.content.length; cIdx++) {
				const block = msg.content[cIdx];
				if (block.type === "image" && block.data) {
					const mimeType = block.mimeType || "image/jpeg";
					const bytes = block.data.length;
					const fileName = filePath ? basename(filePath) : `image_${occurrences.length + 1}`;
					occurrences.push({
						messageIndex: mIdx,
						contentIndex: cIdx,
						mimeType,
						bytes,
						filePath,
						fileName,
						isUserAttachment: false,
					});
				}
			}
		} else if (msg.role === "user" && Array.isArray(msg.content)) {
			for (let cIdx = 0; cIdx < msg.content.length; cIdx++) {
				const block = msg.content[cIdx];
				if (block.type === "image" && block.data) {
					const mimeType = block.mimeType || "image/jpeg";
					const bytes = block.data.length;
					const fileName = `user_attachment_${occurrences.length + 1}`;
					occurrences.push({
						messageIndex: mIdx,
						contentIndex: cIdx,
						mimeType,
						bytes,
						filePath: undefined,
						fileName,
						isUserAttachment: true,
					});
				}
			}
		}
	}

	const totalImages = occurrences.length;
	if (totalImages === 0) {
		return {
			messages,
			totalImages: 0,
			pagedOutCount: 0,
			retainedCount: 0,
			savedBytes: 0,
			estimatedTokens: 0,
			pagedOutRecords: [],
		};
	}

	// 3. 按照策略划分 Hot Pages 与 Cold Pages
	const coldOccurrences: ImageOccurrence[] = [];

	if (config.strategy === "turn-boundary") {
		// 寻找最后一条 user 消息的索引作为当前活跃轮次的分界线
		let lastUserMsgIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				lastUserMsgIndex = i;
				break;
			}
		}

		if (lastUserMsgIndex === -1) {
			// 没有找到 user 消息，回退为纯末尾切片
			const keepCount = Math.max(0, config.keepRecentImages);
			const cutoffIndex = Math.max(0, totalImages - keepCount);
			for (let i = 0; i < totalImages; i++) {
				if (i < cutoffIndex) {
					coldOccurrences.push(occurrences[i]);
				}
			}
		} else {
			// Cache-Friendly 核心机制：
			// 在最后一条 user 消息之前的图片全部属于历史已结轮次，立即固化为静态智能指针并永久冻结；
			// 在最后一条 user 消息之后的图片属于当前活跃轮次（刚刚读入），保留原始 Base64 像素供模型睁眼推理。
			for (const occ of occurrences) {
				if (occ.messageIndex < lastUserMsgIndex) {
					// 历史轮次图片：立即换出
					if (config.minBytesThreshold > 0 && occ.bytes < config.minBytesThreshold) {
						continue;
					}
					coldOccurrences.push(occ);
				} else {
					// 当前轮次图片：若 keepRecentImages 为 0 则全换出，否则保留
					if (config.keepRecentImages === 0) {
						if (config.minBytesThreshold > 0 && occ.bytes < config.minBytesThreshold) {
							continue;
						}
						coldOccurrences.push(occ);
					}
				}
			}
		}
	} else {
		// 传统的 FIFO 数量滑动窗口模式
		const keepCount = Math.max(0, config.keepRecentImages);
		const cutoffIndex = Math.max(0, totalImages - keepCount);
		for (let i = 0; i < totalImages; i++) {
			const occ = occurrences[i];
			if (i < cutoffIndex) {
				if (config.minBytesThreshold > 0 && occ.bytes < config.minBytesThreshold) {
					continue;
				}
				coldOccurrences.push(occ);
			}
		}
	}

	if (coldOccurrences.length === 0) {
		return {
			messages,
			totalImages,
			pagedOutCount: 0,
			retainedCount: totalImages,
			savedBytes: 0,
			estimatedTokens: 0,
			pagedOutRecords: [],
		};
	}

	// 4. 执行非破坏性替换
	// 按照 messageIndex 分组
	const coldByMessage = new Map<number, Map<number, ImageOccurrence>>();
	for (const occ of coldOccurrences) {
		let m = coldByMessage.get(occ.messageIndex);
		if (!m) {
			m = new Map<number, ImageOccurrence>();
			coldByMessage.set(occ.messageIndex, m);
		}
		m.set(occ.contentIndex, occ);
	}

	let savedBytes = 0;
	let estimatedTokens = 0;
	const pagedOutRecords: PagedOutImageRecord[] = [];
	const now = Date.now();

	const newMessages: AgentMessage[] = [];

	for (let mIdx = 0; mIdx < messages.length; mIdx++) {
		const originalMsg = messages[mIdx];
		const coldInThisMsg = coldByMessage.get(mIdx);

		if (!coldInThisMsg) {
			// 该消息不含需要换出的图片，直接复用
			newMessages.push(originalMsg);
			continue;
		}

		// 克隆消息对象并进行 content 替换
		if (originalMsg.role === "toolResult" && Array.isArray(originalMsg.content)) {
			const newContent = (originalMsg.content as any[]).map((block: any, cIdx: number) => {
				const coldOcc = coldInThisMsg.get(cIdx);
				if (coldOcc && block.type === "image") {
					savedBytes += coldOcc.bytes;
					const tokens = estimateVisualTokens(coldOcc.bytes);
					estimatedTokens += tokens;

					pagedOutRecords.push({
						path: coldOcc.filePath || "(user attachment)",
						fileName: coldOcc.fileName,
						mimeType: coldOcc.mimeType,
						bytes: coldOcc.bytes,
						timestamp: now,
					});

					const notice = buildSmartPointerNotice({
						fileName: coldOcc.fileName,
						filePath: coldOcc.filePath,
						mimeType: coldOcc.mimeType,
						bytes: coldOcc.bytes,
						config,
					});

					return {
						type: "text" as const,
						text: notice,
					};
				}
				return block;
			});

			newMessages.push({
				...originalMsg,
				content: newContent,
			});
		} else if (originalMsg.role === "user" && Array.isArray(originalMsg.content)) {
			const newContent = (originalMsg.content as any[]).map((block: any, cIdx: number) => {
				const coldOcc = coldInThisMsg.get(cIdx);
				if (coldOcc && block.type === "image") {
					savedBytes += coldOcc.bytes;
					const tokens = estimateVisualTokens(coldOcc.bytes);
					estimatedTokens += tokens;

					pagedOutRecords.push({
						path: "(user attachment)",
						fileName: coldOcc.fileName,
						mimeType: coldOcc.mimeType,
						bytes: coldOcc.bytes,
						timestamp: now,
					});

					const notice = buildSmartPointerNotice({
						fileName: coldOcc.fileName,
						filePath: undefined,
						mimeType: coldOcc.mimeType,
						bytes: coldOcc.bytes,
						config,
					});

					return {
						type: "text" as const,
						text: notice,
					};
				}
				return block;
			});

			newMessages.push({
				...originalMsg,
				content: newContent,
			});
		} else {
			newMessages.push(originalMsg);
		}
	}

	const pagedOutCount = coldOccurrences.length;
	const retainedCount = totalImages - pagedOutCount;

	return {
		messages: newMessages,
		totalImages,
		pagedOutCount,
		retainedCount,
		savedBytes,
		estimatedTokens,
		pagedOutRecords,
	};
}

/**
 * 命令行自动补全配置项
 */
export const SUBCOMMAND_COMPLETIONS: AutocompleteItem[] = [
	{ value: "status", label: "status", description: "查看当前换页状态与节省统计 (显示 10 秒)" },
	{ value: "on", label: "on", description: "开启智能图片换页" },
	{ value: "off", label: "off", description: "关闭智能图片换页" },
	{ value: "strategy turn-boundary", label: "strategy turn-boundary", description: "Cache-Friendly 模式 (保护前缀缓存)" },
	{ value: "strategy fifo", label: "strategy fifo", description: "FIFO 数量滑动窗口模式" },
	{ value: "keep 1", label: "keep 1", description: "保留 1 张活跃图片 (默认推荐)" },
	{ value: "keep 2", label: "keep 2", description: "保留 2 张活跃图片" },
	{ value: "keep 0", label: "keep 0", description: "换出所有历史图片 (极省模式)" },
	{ value: "lang en", label: "lang en", description: "智能指针使用英文提示词 (遵从度高)" },
	{ value: "lang zh", label: "lang zh", description: "智能指针使用中文提示词" },
	{ value: "reload", label: "reload", description: "从磁盘重新载入配置" },
	{ value: "reset", label: "reset", description: "重置统计计数器" },
];

/**
 * 参数自动补全解析函数
 */
export function getPagerArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const prefix = (argumentPrefix || "").trimStart();

	if (prefix.startsWith("strategy ")) {
		const sub = prefix.slice(9).trim();
		const options: AutocompleteItem[] = [
			{ value: "strategy turn-boundary", label: "turn-boundary", description: "Cache-Friendly 模式 (轮次边界不可变前缀)" },
			{ value: "strategy fifo", label: "fifo", description: "FIFO 模式 (数量滑动窗口)" },
		];
		const filtered = options.filter((o) => (o.label || o.value).startsWith(sub));
		return filtered.length > 0 ? filtered : options;
	}

	if (prefix.startsWith("keep ")) {
		const sub = prefix.slice(5).trim();
		const options: AutocompleteItem[] = [
			{ value: "keep 0", label: "0", description: "换出全部历史图片" },
			{ value: "keep 1", label: "1", description: "保留 1 张最新图片 (默认推荐)" },
			{ value: "keep 2", label: "2", description: "保留 2 张最新图片" },
			{ value: "keep 3", label: "3", description: "保留 3 张最新图片" },
		];
		const filtered = options.filter((o) => (o.label || o.value).startsWith(sub));
		return filtered.length > 0 ? filtered : options;
	}

	if (prefix.startsWith("lang ")) {
		const sub = prefix.slice(5).trim();
		const options: AutocompleteItem[] = [
			{ value: "lang en", label: "en", description: "英文提示词 (大模型遵从度最高)" },
			{ value: "lang zh", label: "zh", description: "中文提示词" },
		];
		const filtered = options.filter((o) => (o.label || o.value).startsWith(sub));
		return filtered.length > 0 ? filtered : options;
	}

	const filtered = SUBCOMMAND_COMPLETIONS.filter((item) =>
		item.value.toLowerCase().startsWith(prefix.toLowerCase()),
	);
	return filtered.length > 0 ? filtered : null;
}

/**
 * Extension 主入口
 */
export default function (pi: ExtensionAPI) {
	let currentConfig: ImagePagerConfig = loadConfig();
	let statusWidgetTimer: NodeJS.Timeout | undefined;

	// 显示状态卡片（10秒后自动消失，绝不长期占着屏幕）
	const showStatusWidget = (lines: string[], ctx: ExtensionContext) => {
		if (statusWidgetTimer) {
			clearTimeout(statusWidgetTimer);
			statusWidgetTimer = undefined;
		}

		if (ctx.ui?.setWidget) {
			ctx.ui.setWidget("image-pager-status", lines, { placement: "aboveEditor" });
			statusWidgetTimer = setTimeout(() => {
				try {
					ctx.ui?.setWidget?.("image-pager-status", undefined);
				} catch {}
				statusWidgetTimer = undefined;
			}, 10000);
		} else {
			ctx.ui?.notify?.(lines.join("\n"), "info");
		}
	};

	// 监听会话关闭，清理定时器
	pi.on("session_shutdown", async () => {
		if (statusWidgetTimer) {
			clearTimeout(statusWidgetTimer);
			statusWidgetTimer = undefined;
		}
	});

	// 监听会话启动
	pi.on("session_start", async (_event, ctx) => {
		currentConfig = loadConfig(ctx.cwd);
		if (currentConfig.debug) {
			console.log("[image-pager] Loaded configuration:", currentConfig);
		}
	});

	// 核心拦截点：context 事件
	// 在 LLM 调用前执行非破坏性图片换页
	pi.on("context", async (event, ctx) => {
		// 检查模型过滤条件
		const activeModel = ctx.model?.id || ctx.model?.name;
		if (!shouldEnableForModel(activeModel, currentConfig)) {
			if (currentConfig.debug) {
				console.log(`[image-pager] Skipping context for model "${activeModel}" (disabled or excluded)`);
			}
			return undefined;
		}

		const result = pageOutContextImages(event.messages, currentConfig, ctx.cwd);

		// 更新遥测与统计数据
		stats.totalContextRuns++;
		stats.totalImagesSeen += result.totalImages;
		stats.pagedOutImagesCount += result.pagedOutCount;
		stats.hotImagesRetained = result.retainedCount;
		stats.savedBytes += result.savedBytes;
		stats.estimatedTokensSaved += result.estimatedTokens;
		stats.lastRunTimestamp = Date.now();

		if (result.pagedOutRecords.length > 0) {
			// 保留最近 10 条换出记录
			stats.recentPagedOutImages = [...result.pagedOutRecords, ...stats.recentPagedOutImages].slice(0, 10);

			if (currentConfig.notifyOnPageOut) {
				ctx.ui?.notify?.(
					`[image-pager] Paged out ${result.pagedOutCount} images (${formatBytes(result.savedBytes)}, ~${result.estimatedTokens} tokens saved)`,
					"info",
				);
			}

			if (currentConfig.debug) {
				console.log(
					`[image-pager] Context optimized: ${result.pagedOutCount} paged out, ${result.retainedCount} retained, ${formatBytes(result.savedBytes)} saved.`,
				);
			}

			// 返回非破坏性替换后的消息列表
			return { messages: result.messages };
		}

		return undefined;
	});

	// 注册交互命令 /image-pager 与 /image-paging
	const commandHandler = async (args: string, ctx: ExtensionContext) => {
		const trimmed = (args || "").trim();
		const parts = trimmed ? trimmed.split(/\s+/) : [];
		// 默认无参数时直接执行 status
		const subCommand = parts[0]?.toLowerCase() || "status";

		switch (subCommand) {
			case "on":
			case "enable": {
				currentConfig.enabled = true;
				saveConfig(currentConfig, getProjectConfigPath(ctx.cwd));
				ctx.ui.notify("image-pager: Enabled (智能图片换页已开启)", "info");
				break;
			}
			case "off":
			case "disable": {
				currentConfig.enabled = false;
				saveConfig(currentConfig, getProjectConfigPath(ctx.cwd));
				ctx.ui.notify("image-pager: Disabled (智能图片换页已关闭)", "info");
				break;
			}
			case "strategy": {
				const strat = parts[1]?.toLowerCase();
				if (strat !== "turn-boundary" && strat !== "fifo") {
					ctx.ui.notify("Usage: /image-pager strategy <turn-boundary|fifo>", "warning");
					return;
				}
				currentConfig.strategy = strat;
				saveConfig(currentConfig, getProjectConfigPath(ctx.cwd));
				ctx.ui.notify(`image-pager: 换页策略已切换为 ${strat} (${strat === "turn-boundary" ? "Cache-Friendly 模式" : "FIFO 模式"})`, "info");
				break;
			}
			case "keep": {
				const num = parseInt(parts[1], 10);
				if (isNaN(num) || num < 0) {
					ctx.ui.notify("Usage: /image-pager keep <number> (e.g. /image-pager keep 1)", "warning");
					return;
				}
				currentConfig.keepRecentImages = num;
				saveConfig(currentConfig, getProjectConfigPath(ctx.cwd));
				ctx.ui.notify(`image-pager: 保留活跃图片数已设为 ${num} (更早历史图片自动换出)`, "info");
				break;
			}
			case "lang": {
				const lang = parts[1]?.toLowerCase();
				if (lang !== "en" && lang !== "zh") {
					ctx.ui.notify("Usage: /image-pager lang <en|zh>", "warning");
					return;
				}
				currentConfig.noticeLanguage = lang;
				saveConfig(currentConfig, getProjectConfigPath(ctx.cwd));
				ctx.ui.notify(`image-pager: 提示词语言已切换为 ${lang}`, "info");
				break;
			}
			case "reload": {
				currentConfig = loadConfig(ctx.cwd);
				ctx.ui.notify("image-pager: Configuration reloaded successfully.", "info");
				break;
			}
			case "reset": {
				stats.totalContextRuns = 0;
				stats.totalImagesSeen = 0;
				stats.pagedOutImagesCount = 0;
				stats.hotImagesRetained = 0;
				stats.savedBytes = 0;
				stats.estimatedTokensSaved = 0;
				stats.recentPagedOutImages = [];
				ctx.ui.notify("image-pager: Telemetry stats reset.", "info");
				break;
			}
			case "status":
			default: {
				const statusText = currentConfig.enabled ? "已开启 (Enabled)" : "已关闭 (Disabled)";
				const stratText =
					currentConfig.strategy === "turn-boundary"
						? "turn-boundary (Cache-Friendly 不可变前缀)"
						: "fifo (数量滑动窗口)";

				// 仅展示核心状态，不附带任何多余用法说明；卡片显示 10 秒后自动消失
				const lines = [
					`[image-pager] 状态: ${statusText} · 策略: ${stratText} · 活跃保留: ${currentConfig.keepRecentImages} 张`,
					`• 图像统计: 发现 ${stats.totalImagesSeen} 张 · 已换出 ${stats.pagedOutImagesCount} 张 · 活跃常驻 ${stats.hotImagesRetained} 张`,
					`• 节省收益: 节省 Payload ${formatBytes(stats.savedBytes)} · 估算节省 ~${stats.estimatedTokensSaved.toLocaleString()} Tokens`,
				];

				if (stats.recentPagedOutImages.length > 0) {
					const latest = stats.recentPagedOutImages[0];
					const shortPath = latest.path.length > 50 ? "..." + latest.path.slice(-47) : latest.path;
					lines.push(`• 最近换出: ${latest.fileName} (${formatBytes(latest.bytes)}) -> ${shortPath}`);
				}

				showStatusWidget(lines, ctx);
				break;
			}
		}
	};

	pi.registerCommand("image-pager", {
		description: "管理图像虚拟内存换页（Virtual Memory Paging for Multimodal Images）",
		getArgumentCompletions: getPagerArgumentCompletions,
		handler: commandHandler,
	});

	pi.registerCommand("image-paging", {
		description: "image-pager 别名",
		getArgumentCompletions: getPagerArgumentCompletions,
		handler: commandHandler,
	});
}
