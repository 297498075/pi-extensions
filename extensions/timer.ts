import type {
	CustomEntry,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	Box,
	type Component,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { StatusModalComponent } from "./lib/status-modal.ts";

// ==========================================
// 常量与类型定义
// ==========================================

export const TIMER_CUSTOM_ENTRY_TYPE = "scheduled-timer";
export const TIMER_WIDGET_KEY = "scheduled-timer-countdown";

export type TimerTaskStatus = "pending" | "running" | "completed" | "cancelled";
export type TimerDeliveryMode = "steer" | "followUp";

export interface TimerTask {
	id: string;
	prompt: string;
	createdAt: number;
	delaySeconds: number;
	targetTime: number;
	status: TimerTaskStatus;
	deliverAs: TimerDeliveryMode;
	rawTime?: string;
	timerHandle?: NodeJS.Timeout;
	triggeredAt?: number;
	cancelledAt?: number;
}

export interface TimerEntryData {
	action: "created" | "triggered" | "cancelled";
	deliverAs?: TimerDeliveryMode;
	taskId: string;
	targetTime: number;
	delaySeconds: number;
	prompt: string;
	triggeredAt?: number;
	cancelledAt?: number;
}

export interface ParsedTimerInput {
	seconds: number;
	prompt: string;
	rawTime: string;
}

// ==========================================
// Schemas for Agent Tools
// ==========================================

export const TimerScheduleSchema = Type.Object({
	deliverAs: Type.Optional(
		Type.Union([Type.Literal("steer"), Type.Literal("followUp")], {
			default: "steer",
			description: "消息交付模式，默认 steer（steering）：Agent 忙时在下一个可处理边界插入，可跳过尚未执行的工具；followUp 等当前任务结束后再处理，不打断当前任务。空闲时两者均立即启动新一轮。",
		}),
	),
	prompt: Type.String({
		description: "到达定时时间后发送给 Agent 的提示词/任务内容",
	}),
	seconds: Type.Optional(
		Type.Integer({
			minimum: 0,
			description: "定时秒数 (与 minutes, hours 累加)",
		}),
	),
	minutes: Type.Optional(
		Type.Integer({
			minimum: 0,
			description: "定时分钟数 (与 seconds, hours 累加)",
		}),
	),
	hours: Type.Optional(
		Type.Integer({
			minimum: 0,
			description: "定时小时数 (与 seconds, minutes 累加)",
		}),
	),
	timeExpression: Type.Optional(
		Type.String({
			description:
				"时间表达式 (例如 '30 0 0 秒分时', '5m', '00:05:00', '1小时30分')。若提供此项则优先按表达式解析",
		}),
	),
});

export const TimerCancelSchema = Type.Object({
	taskId: Type.Optional(
		Type.String({
			description: "要取消的定时任务 ID (例如 't-1')，传 'all' 或省略则取消所有等待中的任务",
		}),
	),
});

export const TimerListSchema = Type.Object({});

export type TimerScheduleParams = Static<typeof TimerScheduleSchema>;
export type TimerCancelParams = Static<typeof TimerCancelSchema>;

// ==========================================
// 辅助与时间格式化函数
// ==========================================

export function formatDuration(totalSeconds: number): string {
	if (totalSeconds < 60) {
		return `${totalSeconds}秒`;
	}
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}小时`);
	if (minutes > 0) parts.push(`${minutes}分`);
	if (seconds > 0) parts.push(`${seconds}秒`);
	return parts.join("") || "0秒";
}

export function formatClockTime(totalSeconds: number): string {
	const clamped = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(clamped / 3600);
	const minutes = Math.floor((clamped % 3600) / 60);
	const seconds = clamped % 60;

	if (hours > 0) {
		return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
	}
	return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

export function formatDateTime(timestamp: number): string {
	const date = new Date(timestamp);
	return date.toLocaleTimeString();
}

function safeFg(theme: any, color: string, text: string): string {
	if (theme && typeof theme.fg === "function") {
		try {
			return theme.fg(color, text);
		} catch {}
	}
	return text;
}

function safeBg(theme: any, color: string, text: string): string {
	if (theme && typeof theme.bg === "function") {
		try {
			return theme.bg(color, text);
		} catch {}
	}
	return text;
}

function stripOuterQuotes(str: string): string {
	const s = str.trim();
	if (
		(s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
		(s.startsWith("'") && s.endsWith("'") && s.length >= 2)
	) {
		return s.slice(1, -1).trim();
	}
	return s;
}

// ==========================================
// 参数智能解析
// ==========================================

/**
 * 解析用户输入的命令参数
 * 支持格式：
 * 1. 冒号格式：01:30:00 提示词 或 02:30 提示词
 * 2. 空格三数字格式 (用户指定：秒 分 时)：30 2 0 提示词 (30秒 2分 0时 = 150秒)
 * 3. 空格两数字格式 (秒 分)：30 2 提示词 (30秒 2分 = 150秒)
 * 4. 自然时间单位：30s, 5m, 1h, 1h 30m, 1小时30分钟, 45秒 等
 * 5. 单个纯数字：30 提示词 (默认按 30 秒)
 */
export function parseTimerArgs(
	input: string,
): { success: true; data: ParsedTimerInput } | { success: false; error: string } {
	const trimmed = input.trim();
	if (!trimmed) {
		return {
			success: false,
			error: "缺少参数。用法: /timer [秒] [分] [时] <提示词> 或 /timer <时间> <提示词>",
		};
	}

	// 1. 冒号格式：hh:mm:ss 或 mm:ss
	const colonMatch = trimmed.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\s+(.*))?$/s);
	if (colonMatch) {
		let totalSeconds = 0;
		let rawTime = "";
		if (colonMatch[3] !== undefined) {
			const hours = parseInt(colonMatch[1], 10);
			const minutes = parseInt(colonMatch[2], 10);
			const seconds = parseInt(colonMatch[3], 10);
			totalSeconds = hours * 3600 + minutes * 60 + seconds;
			rawTime = `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
		} else {
			const minutes = parseInt(colonMatch[1], 10);
			const seconds = parseInt(colonMatch[2], 10);
			totalSeconds = minutes * 60 + seconds;
			rawTime = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
		}
		const prompt = stripOuterQuotes(colonMatch[4] ?? "");
		if (totalSeconds <= 0) {
			return { success: false, error: "定时时间必须大于 0 秒" };
		}
		return { success: true, data: { seconds: totalSeconds, prompt, rawTime } };
	}

	// 2. 空格分隔的 3 个纯数字 (秒 分 时)
	const threeNumsMatch = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)(?:\s+(.*))?$/s);
	if (threeNumsMatch) {
		const s = parseInt(threeNumsMatch[1], 10);
		const m = parseInt(threeNumsMatch[2], 10);
		const h = parseInt(threeNumsMatch[3], 10);
		const totalSeconds = s + m * 60 + h * 3600;
		const prompt = stripOuterQuotes(threeNumsMatch[4] ?? "");
		if (totalSeconds <= 0) {
			return { success: false, error: "定时时间必须大于 0 秒" };
		}
		return {
			success: true,
			data: {
				seconds: totalSeconds,
				prompt,
				rawTime: `${s}秒 ${m}分 ${h}时`,
			},
		};
	}

	// 3. 空格分隔的 2 个纯数字 (秒 分)
	const twoNumsMatch = trimmed.match(/^(\d+)\s+(\d+)(?:\s+(.*))?$/s);
	if (twoNumsMatch) {
		const s = parseInt(twoNumsMatch[1], 10);
		const m = parseInt(twoNumsMatch[2], 10);
		const totalSeconds = s + m * 60;
		const prompt = stripOuterQuotes(twoNumsMatch[3] ?? "");
		if (totalSeconds <= 0) {
			return { success: false, error: "定时时间必须大于 0 秒" };
		}
		return {
			success: true,
			data: {
				seconds: totalSeconds,
				prompt,
				rawTime: `${s}秒 ${m}分`,
			},
		};
	}

	// 4. 自然时间单位 (英文/中文)。Do not consume h/m/s from help/merge/send.
	// Digits still permit adjacent tokens such as 1h30m; Chinese text may follow a unit.
	const unitPattern =
		/^(\d+(?:\.\d+)?)\s*((?:hours?|h|minutes?|min|m|seconds?|sec|s)(?![a-z_])|小时|时|分钟|分|秒钟|秒)/i;
	let remaining = trimmed;
	let accumulatedSeconds = 0;
	const matchedTokens: string[] = [];

	while (true) {
		const m = remaining.match(unitPattern);
		if (!m) break;
		const value = parseFloat(m[1]);
		const unit = m[2].toLowerCase();
		matchedTokens.push(m[0].trim());

		if (unit.startsWith("h") || unit.includes("时")) {
			accumulatedSeconds += Math.round(value * 3600);
		} else if (unit.startsWith("m") || unit.includes("分")) {
			accumulatedSeconds += Math.round(value * 60);
		} else if (unit.startsWith("s") || unit.includes("秒")) {
			accumulatedSeconds += Math.round(value);
		}

		remaining = remaining.slice(m[0].length).trim();
	}

	if (matchedTokens.length > 0) {
		if (accumulatedSeconds <= 0) {
			return { success: false, error: "定时时间必须大于 0 秒" };
		}
		return {
			success: true,
			data: {
				seconds: accumulatedSeconds,
				prompt: stripOuterQuotes(remaining),
				rawTime: matchedTokens.join(" "),
			},
		};
	}

	// 5. 单个纯数字 (默认秒)
	const singleNumMatch = trimmed.match(/^(\d+)(?:\s+(.*))?$/s);
	if (singleNumMatch) {
		const s = parseInt(singleNumMatch[1], 10);
		const prompt = stripOuterQuotes(singleNumMatch[2] ?? "");
		if (s <= 0) {
			return { success: false, error: "定时时间必须大于 0 秒" };
		}
		return {
			success: true,
			data: {
				seconds: s,
				prompt,
				rawTime: `${s}秒`,
			},
		};
	}

	return {
		success: false,
		error: `无法识别的时间格式: "${trimmed}"。支持: "30 2 0" (秒 分 时)、"5m"、"00:05:00"、"30s" 等`,
	};
}

// ==========================================
// 定时任务管理器 (TimerManager)
// ==========================================

export class TimerManager {
	private readonly pi: ExtensionAPI;
	private context?: ExtensionContext;
	private tasks = new Map<string, TimerTask>();
	private nextId = 1;
	private countdownInterval?: NodeJS.Timeout;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	public attach(ctx: ExtensionContext): void {
		this.context = ctx;
	}

	public getPendingTasks(): TimerTask[] {
		return [...this.tasks.values()]
			.filter((t) => t.status === "pending")
			.sort((a, b) => a.targetTime - b.targetTime);
	}

	public getAllTasks(): TimerTask[] {
		return [...this.tasks.values()];
	}

	public getTask(id: string): TimerTask | undefined {
		return this.tasks.get(id);
	}

	/**
	 * 创建定时任务并启动计时与 Widget
	 */
	public createTask(
		seconds: number,
		prompt: string,
		rawTime?: string,
		ctx?: ExtensionContext,
		deliverAs: TimerDeliveryMode = "steer",
	): TimerTask {
		if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isSafeInteger(Math.round(seconds) * 1000) ||
			Math.round(seconds) * 1000 > 8_640_000_000_000_000 - Date.now()) {
			throw new Error("定时时长无效或超出支持范围");
		}
		if (!prompt.trim()) throw new Error("提示词不能为空");
		if (ctx) this.attach(ctx);

		const id = `t-${this.nextId++}`;
		const createdAt = Date.now();
		const delaySeconds = Math.max(1, Math.round(seconds));
		const targetTime = createdAt + delaySeconds * 1000;

		const task: TimerTask = {
			id,
			prompt,
			createdAt,
			delaySeconds,
			targetTime,
			status: "pending",
			deliverAs,
			rawTime: rawTime || formatDuration(delaySeconds),
		};

		this.tasks.set(id, task);
		this.armTask(task);

		// 1. 在正文聊天记录中追加持久化卡片
		try {
			this.pi.appendEntry<TimerEntryData>(TIMER_CUSTOM_ENTRY_TYPE, {
				action: "created",
				deliverAs,
				taskId: id,
				targetTime,
				delaySeconds,
				prompt,
			});
		} catch (err) {
			console.error("[timer] Failed to append entry for task creation:", err);
		}

		// 2. 启动/更新倒计时 Widget
		this.ensureWidgetRunning();

		// 3. 提示通知
		const targetTimeStr = formatDateTime(targetTime);
		this.notify(
			`⏱️ 定时任务 [#${id}] 已创建，将在 ${targetTimeStr} (${formatDuration(delaySeconds)}后) 发送提示词启动 Agent。`,
			"info",
		);

		return task;
	}

	private armTask(task: TimerTask): void {
		// Node clamps delays beyond 2^31-1 ms to 1 ms. Chain bounded waits
		// and recheck the target clock before delivering any message.
		const remaining = task.targetTime - Date.now();
		task.timerHandle = setTimeout(() => {
			task.timerHandle = undefined;
			if (task.status !== "pending") return;
			if (Date.now() < task.targetTime) this.armTask(task);
			else this.triggerTask(task.id);
		}, Math.max(1, Math.min(2_147_483_647, remaining)));
	}

	/**
	 * 取消指定任务或全部任务
	 */
	public cancelTask(id: string | "all"): { cancelled: string[]; count: number } {
		const cancelledIds: string[] = [];
		const targets =
			id === "all"
				? this.getPendingTasks()
				: [this.tasks.get(id)].filter((t): t is TimerTask => Boolean(t && t.status === "pending"));

		for (const task of targets) {
			if (task.timerHandle) {
				clearTimeout(task.timerHandle);
				task.timerHandle = undefined;
			}
			task.status = "cancelled";
			task.cancelledAt = Date.now();
			cancelledIds.push(task.id);

			try {
				this.pi.appendEntry<TimerEntryData>(TIMER_CUSTOM_ENTRY_TYPE, {
					action: "cancelled",
					deliverAs: task.deliverAs,
					taskId: task.id,
					targetTime: task.targetTime,
					delaySeconds: task.delaySeconds,
					prompt: task.prompt,
					cancelledAt: task.cancelledAt,
				});
			} catch (err) {
				console.error("[timer] Failed to append entry for task cancellation:", err);
			}
		}

		this.updateWidget();

		if (cancelledIds.length > 0) {
			this.notify(`🚫 已取消定时任务: ${cancelledIds.map((tid) => `#${tid}`).join(", ")}`, "info");
		}

		return { cancelled: cancelledIds, count: cancelledIds.length };
	}

	/**
	 * 倒计时归零，触发执行
	 */
	private triggerTask(id: string): void {
		const task = this.tasks.get(id);
		if (!task || task.status !== "pending") return;

		task.status = "completed";
		task.triggeredAt = Date.now();
		task.timerHandle = undefined;

		// 1. 在正文记录触发卡片
		try {
			this.pi.appendEntry<TimerEntryData>(TIMER_CUSTOM_ENTRY_TYPE, {
				action: "triggered",
				deliverAs: task.deliverAs,
				taskId: task.id,
				targetTime: task.targetTime,
				delaySeconds: task.delaySeconds,
				prompt: task.prompt,
				triggeredAt: task.triggeredAt,
			});
		} catch (err) {
			console.error("[timer] Failed to append entry for task trigger:", err);
		}

		// 2. 发送用户消息给 Agent 并启动任务
		try {
			// Always pass the selected mode: Pi handles idle/busy transitions atomically.
			this.pi.sendUserMessage(task.prompt, { deliverAs: task.deliverAs });
		} catch (err) {
			console.warn(`[timer] Send failed, retrying delivery as ${task.deliverAs}:`, err);
			try {
				this.pi.sendUserMessage(task.prompt, { deliverAs: task.deliverAs });
			} catch (fallbackErr) {
				console.error("[timer] Critical: failed to deliver scheduled message:", fallbackErr);
			}
		}

		// 3. 发送提示通知
		this.notify(`🚀 定时任务 [#${task.id}] 倒计时已到达，已发送消息启动任务！`, "info");

		// 4. 更新/清除 Widget
		this.updateWidget();
	}

	/**
	 * 维持输入框上方倒计时 Widget 刷新
	 */
	private ensureWidgetRunning(): void {
		if (this.countdownInterval) return;

		this.updateWidget();

		this.countdownInterval = setInterval(() => {
			this.updateWidget();
		}, 1000);
	}

	/**
	 * 刷新倒计时 Widget 显示
	 */
	public updateWidget(): void {
		const pending = this.getPendingTasks();

		// 无等待任务时，清除 Widget
		if (pending.length === 0) {
			if (this.countdownInterval) {
				clearInterval(this.countdownInterval);
				this.countdownInterval = undefined;
			}
			try {
				if (this.context?.ui?.setWidget) {
					this.context.ui.setWidget(TIMER_WIDGET_KEY, undefined);
				}
			} catch {}
			return;
		}

		const soonest = pending[0];
		const remainingSeconds = Math.max(0, Math.ceil((soonest.targetTime - Date.now()) / 1000));
		const clockStr = formatClockTime(remainingSeconds);

		const previewPrompt =
			soonest.prompt.length > 28 ? `${soonest.prompt.slice(0, 28)}...` : soonest.prompt;

		const moreInfo = pending.length > 1 ? ` (+${pending.length - 1} 更多待执行)` : "";
		const urgent = remainingSeconds <= 10;
		const icon = urgent ? "🔥" : "⏳";

		const line = `${icon} [定时任务倒计时] [#${soonest.id}] ${clockStr} 后触发${moreInfo} | 提示词: "${previewPrompt}" | 取消: /timer cancel ${soonest.id}`;

		try {
			if (this.context?.ui?.setWidget) {
				this.context.ui.setWidget(TIMER_WIDGET_KEY, [line], {
					placement: "aboveEditor",
				});
			}
		} catch (err) {
			console.error("[timer] Error setting widget:", err);
		}
	}

	public notify(message: string, level: "info" | "warning" | "error" = "info"): void {
		if (this.context?.ui?.notify) {
			this.context.ui.notify(message, level);
		}
	}

	public dispose(): void {
		if (this.countdownInterval) {
			clearInterval(this.countdownInterval);
			this.countdownInterval = undefined;
		}
		for (const task of this.tasks.values()) {
			if (task.timerHandle) {
				clearTimeout(task.timerHandle);
				task.timerHandle = undefined;
			}
		}
		try {
			if (this.context?.ui?.setWidget) {
				this.context.ui.setWidget(TIMER_WIDGET_KEY, undefined);
			}
		} catch {}
		this.context = undefined;
	}
}

// ==========================================
// 状态查询模态窗口 (遵循 AGENTS.md 规范)
// ==========================================

export class TimerStatusModalComponent implements Component {
	private readonly modal: StatusModalComponent;

	constructor(tui: any, theme: any, manager: TimerManager, onClose: () => void) {
		this.modal = new StatusModalComponent(tui, theme, "⏱️ 定时任务管理器 (Scheduled Tasks)", () => {
			const pending = manager.getPendingTasks();
			const all = manager.getAllTasks();
			return [
				`活跃中: ${pending.length} 个 | 已触发: ${all.filter(t => t.status === "completed").length} 个 | 已取消: ${all.filter(t => t.status === "cancelled").length} 个`,
				...(pending.length ? pending.flatMap(task => [
					`[#${task.id}] 倒计时 ${formatClockTime(Math.max(0, Math.ceil((task.targetTime - Date.now()) / 1000)))} (预定 ${formatDateTime(task.targetTime)})`,
					`交付模式: ${task.deliverAs} | 提示词: ${task.prompt}`,
				]) : ["(当前暂无等待执行的定时任务)"]),
				"",
				"创建: /timer [秒] [分] [时] <提示词>",
				"取消: /timer cancel <id> 或 /timer cancel all",
			];
		}, onClose, { maxWidth: 76, maxHeight: 16, center: true });
	}

	invalidate(): void { this.modal.invalidate(); }
	render(width: number): string[] { return this.modal.render(width); }
	handleInput(data: string): void { this.modal.handleInput(data); }
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.modal.handleMouse(event); }
}

// ==========================================
// 模态弹窗打开器
// ==========================================

export function openTimerStatusModal(ctx: ExtensionContext, manager: TimerManager): void {
	if (!ctx.hasUI || ctx.mode === "rpc" || !ctx.ui?.custom) {
		const pending = manager.getPendingTasks();
		const info = [
			`[定时任务状态]`,
			`等待中任务数: ${pending.length}`,
			...pending.map(
				(t) =>
					`#${t.id} - 剩余 ${formatClockTime(Math.max(0, Math.ceil((t.targetTime - Date.now()) / 1000)))} - 提示词: ${t.prompt}`,
			),
		].join("\n");
		manager.notify(info, "info");
		return;
	}

	ctx.ui
		.custom(
			(tui: any, theme: any, _keybindings: any, done: (result: unknown) => void) => {
				return new TimerStatusModalComponent(tui, theme, manager, () => done(undefined));
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
			console.error("[timer] status modal error:", err);
		});
}

// ==========================================
// 正文 Entry Renderer 注册
// ==========================================

export function registerTimerEntryRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<TimerEntryData>(
		TIMER_CUSTOM_ENTRY_TYPE,
		(entry: CustomEntry<TimerEntryData>, { expanded }: { expanded: boolean }, theme: Theme) => {
			const data = entry.data;
			if (!data) return undefined;

			const box = new Box(1, 0, (text: string) => safeBg(theme, "customMessageBg", text));

			const targetTimeStr = formatDateTime(data.targetTime);
			const durationStr = formatDuration(data.delaySeconds);

			if (data.action === "created") {
				box.addChild(
					new Text(safeFg(theme, "accent", `⏱️ 定时任务已创建 [#${data.taskId}]`), 0, 0),
				);
				box.addChild(
					new Text(
						`${safeFg(theme, "muted", "目标触发时间: ")}${targetTimeStr} (${durationStr}后)`,
						0,
						0,
					),
				);
				box.addChild(new Text(`${safeFg(theme, "accent", "提示词: ")}${data.prompt}`, 0, 0));
				box.addChild(
					new Text(
						safeFg(
							theme,
							"dim",
							"倒计时由输入框上方实时显示，到达后将自动发送并启动 Agent 任务",
						),
						0,
						0,
					),
				);
			} else if (data.action === "triggered") {
				const triggerTimeStr = formatDateTime(data.triggeredAt || Date.now());
				box.addChild(
					new Text(safeFg(theme, "success", `🚀 定时任务已触发 [#${data.taskId}]`), 0, 0),
				);
				box.addChild(
					new Text(`${safeFg(theme, "muted", "触发时间: ")}${triggerTimeStr}`, 0, 0),
				);
				box.addChild(
					new Text(
						safeFg(theme, "success", "已向 Agent 发送提示词，正在启动 Agent 任务..."),
						0,
						0,
					),
				);
				box.addChild(new Text(`${safeFg(theme, "accent", "提示词: ")}${data.prompt}`, 0, 0));
			} else if (data.action === "cancelled") {
				const cancelTimeStr = formatDateTime(data.cancelledAt || Date.now());
				box.addChild(
					new Text(safeFg(theme, "warning", `🚫 定时任务已取消 [#${data.taskId}]`), 0, 0),
				);
				box.addChild(
					new Text(`${safeFg(theme, "muted", "取消时间: ")}${cancelTimeStr}`, 0, 0),
				);
				box.addChild(
					new Text(`${safeFg(theme, "dim", "原定提示词: ")}${data.prompt}`, 0, 0),
				);
			}

			if (expanded) {
				const meta = `Task ID: ${data.taskId} | 设定延迟: ${data.delaySeconds}秒 | 记录时间: ${new Date(data.targetTime - data.delaySeconds * 1000).toLocaleString()}`;
				box.addChild(new Text(safeFg(theme, "dim", meta), 0, 0));
			}

			return box;
		},
	);
}

// ==========================================
// 命令处理逻辑 (/timer & /schedule)
// ==========================================

export async function handleTimerCommand(
	args: string,
	ctx: ExtensionCommandContext,
	manager: TimerManager,
): Promise<void> {
	manager.attach(ctx);
	const raw = args.trim();

	// 1. 无参数：交互式输入或帮助
	if (!raw) {
		if (ctx.hasUI && ctx.ui?.input) {
			const timeStr = await ctx.ui.input(
				"请输入定时时间 (如 '30 0 0 秒分时'、'5m'、'00:05:00'):",
			);
			if (!timeStr || !timeStr.trim()) {
				ctx.ui.notify("已取消创建定时任务", "info");
				return;
			}
			const promptStr = await ctx.ui.input("请输入到达时间后发送给 Agent 的提示词:");
			if (!promptStr || !promptStr.trim()) {
				ctx.ui.notify("已取消创建定时任务（未提供提示词）", "info");
				return;
			}
			const parsed = parseTimerArgs(timeStr.trim());
			if (!parsed.success) {
				ctx.ui.notify(parsed.error, "warning");
				return;
			}
			manager.createTask(parsed.data.seconds, stripOuterQuotes(promptStr), parsed.data.rawTime, ctx);
			return;
		}

		ctx.ui.notify(
			"用法: /timer [秒] [分] [时] <提示词>\n或: /timer <时间单位: 5m|30s|1h30m> <提示词>\n子命令: /timer status | list | cancel [id|all]",
			"info",
		);
		return;
	}

	const firstToken = raw.split(/\s+/)[0]?.toLowerCase();

	// 2. 子命令: status (AGENTS.md 要求使用模态窗口呈现)
	if (firstToken === "status") {
		openTimerStatusModal(ctx, manager);
		return;
	}

	// list is also a read-only status query: use the same visible modal.
	if (firstToken === "list") {
		openTimerStatusModal(ctx, manager);
		return;
	}

	// 4. 子命令: cancel
	if (firstToken === "cancel") {
		const rest = raw.slice(firstToken.length).trim();
		const pending = manager.getPendingTasks();

		if (pending.length === 0) {
			ctx.ui.notify("当前没有等待执行的定时任务", "info");
			return;
		}

		if (rest.toLowerCase() === "all") {
			manager.cancelTask("all");
			return;
		}

		if (rest) {
			const targetId = rest.startsWith("#") ? rest.slice(1) : rest;
			const task = manager.getTask(targetId);
			if (!task || task.status !== "pending") {
				ctx.ui.notify(`未找到处于等待状态的任务: ${rest}`, "warning");
				return;
			}
			manager.cancelTask(targetId);
			return;
		}

		// 若只有一个待执行任务，直接取消
		if (pending.length === 1) {
			manager.cancelTask(pending[0].id);
			return;
		}

		// 多个任务且支持交互选择
		if (ctx.hasUI && ctx.ui?.select) {
			const options = pending.map((t) => {
				const rem = Math.max(0, Math.ceil((t.targetTime - Date.now()) / 1000));
				return `#${t.id}: 倒计时 ${formatClockTime(rem)} - "${t.prompt.slice(0, 24)}"`;
			});
			options.push("全部取消 (Cancel All)");

			const selected = await ctx.ui.select("请选择要取消的定时任务:", options);
			if (!selected) {
				ctx.ui.notify("已取消操作", "info");
				return;
			}
			if (selected === "全部取消 (Cancel All)") {
				manager.cancelTask("all");
				return;
			}
			const match = selected.match(/^#([a-zA-Z0-9-]+):/);
			if (match) {
				manager.cancelTask(match[1]);
			}
			return;
		}

		ctx.ui.notify("请指定要取消的任务 ID，例如: /timer cancel t-1 或 /timer cancel all", "warning");
		return;
	}

	// 5. 子命令: help
	if (firstToken === "help") {
		ctx.ui.notify(
			[
				"⏱️ 定时任务扩展使用指南:",
				"1. 按「秒 分 时」设置: /timer 30 2 0 帮我检查代码 (2分30秒后触发)",
				"2. 按自然时间设置: /timer 5m 帮我重构代码 或 /timer 30s 提醒我",
				"3. 按时钟冒号设置: /timer 00:05:00 帮我执行测试",
				"4. 查看状态弹窗: /timer status",
				"5. 查看待执行列表: /timer list",
				"6. 取消定时任务: /timer cancel [id|all]",
			].join("\n"),
			"info",
		);
		return;
	}

	// 6. 解析并创建定时任务
	const parsed = parseTimerArgs(raw);
	if (!parsed.success) {
		ctx.ui.notify(parsed.error, "warning");
		return;
	}

	let prompt = parsed.data.prompt;
	if (!prompt) {
		if (ctx.hasUI && ctx.ui?.input) {
			const promptStr = await ctx.ui.input("请输入到达时间后发送给 Agent 的提示词:");
			if (!promptStr || !promptStr.trim()) {
				ctx.ui.notify("已取消创建定时任务（未提供提示词）", "info");
				return;
			}
			prompt = promptStr.trim();
		} else {
			ctx.ui.notify("缺少提示词。请在时间后附带要发送给 Agent 的任务内容。", "warning");
			return;
		}
	}

	manager.createTask(parsed.data.seconds, prompt, parsed.data.rawTime, ctx);
}

// ==========================================
// Extension 导出入口
// ==========================================

const TIMER_SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "status", label: "status", description: "查看定时任务状态与历史模态窗" },
	{ value: "list", label: "list", description: "列出当前所有等待执行的定时任务" },
	{ value: "cancel", label: "cancel", description: "取消指定的定时任务 (支持 cancel all 或 ID)" },
	{ value: "help", label: "help", description: "查看定时时间表达式与使用指南" },
	{ value: "5m ", label: "5m", description: "预设：5 分钟后发送提示词" },
	{ value: "30s ", label: "30s", description: "预设：30 秒后发送提示词" },
	{ value: "10m ", label: "10m", description: "预设：10 分钟后发送提示词" },
	{ value: "30m ", label: "30m", description: "预设：30 分钟后发送提示词" },
	{ value: "1h ", label: "1h", description: "预设：1 小时后发送提示词" },
	{ value: "30 0 0 ", label: "30 0 0", description: "预设：30秒后 (秒 分 时)" },
];

export function getTimerArgumentCompletions(
	argumentPrefix: string,
	manager?: TimerManager,
): AutocompleteItem[] | null {
	const prefix = (argumentPrefix || "").trimStart();

	if (prefix.startsWith("cancel")) {
		const sub = prefix.slice(6).trimStart().toLowerCase();
		const options: AutocompleteItem[] = [
			{ value: "cancel all", label: "all", description: "取消所有等待执行的定时任务" },
		];

		if (manager) {
			const pending = manager.getPendingTasks();
			for (const t of pending) {
				const rem = Math.max(0, Math.ceil((t.targetTime - Date.now()) / 1000));
				options.push({
					value: `cancel ${t.id}`,
					label: t.id,
					description: `取消任务 #${t.id} (剩余 ${formatClockTime(rem)}): "${t.prompt.slice(0, 20)}"`,
				});
			}
		}

		const filtered = options.filter(
			(o) => o.label.toLowerCase().startsWith(sub) || o.value.toLowerCase().startsWith(prefix.toLowerCase()),
		);
		return filtered.length > 0 ? filtered : options;
	}

	const filtered = TIMER_SUBCOMMANDS.filter((item) =>
		item.value.toLowerCase().startsWith(prefix.toLowerCase()) ||
		item.label.toLowerCase().startsWith(prefix.toLowerCase()),
	);
	return filtered.length > 0 ? filtered : null;
}

export default function timerExtension(pi: ExtensionAPI): void {
	const manager = new TimerManager(pi);

	// 注册正文渲染器
	registerTimerEntryRenderer(pi);

	// 注册主命令 /timer
	pi.registerCommand("timer", {
		description: "设置定时发送消息启动 Agent 任务，如 /timer 30 2 0 提示词 或 /timer 5m 提示词",
		getArgumentCompletions: (prefix) => getTimerArgumentCompletions(prefix, manager),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await handleTimerCommand(args, ctx, manager);
		},
	});

	// 注册别名命令 /schedule
	pi.registerCommand("schedule", {
		description: "设置定时任务别名 (/timer 的同义命令)",
		getArgumentCompletions: (prefix) => getTimerArgumentCompletions(prefix, manager),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await handleTimerCommand(args, ctx, manager);
		},
	});

	// 注册 Custom Tool 给 Agent 调度定时任务使用
	pi.registerTool({
		name: "timer_schedule",
		label: "Timer Schedule",
		description:
			"创建定时发送消息的计划任务。默认 deliverAs: steer（steering），Agent 忙时在下一个可处理边界插入；如需等待当前任务结束、不打断执行，可选择 deliverAs: followUp。空闲时均立即启动新一轮。",
		parameters: TimerScheduleSchema,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			manager.attach(ctx);
			const typedParams = params as TimerScheduleParams;

			let totalSeconds = 0;
			let rawTime = "";

			if (typedParams.timeExpression) {
				// Time and prompt are separate fields: a numeric/English prompt is never part of the duration.
				const parsed = parseTimerArgs(typedParams.timeExpression);
				if (!parsed.success) {
					return {
						content: [{ type: "text" as const, text: `时间表达式解析失败: ${parsed.error}` }],
						isError: true,
						details: { error: parsed.error },
					};
				}
				totalSeconds = parsed.data.seconds;
				rawTime = parsed.data.rawTime;
			} else {
				const s = typedParams.seconds ?? 0;
				const m = typedParams.minutes ?? 0;
				const h = typedParams.hours ?? 0;
				totalSeconds = s + m * 60 + h * 3600;
				rawTime = `${s}秒 ${m}分 ${h}时`;
			}

			if (totalSeconds <= 0) {
				return {
					content: [{ type: "text" as const, text: "定时时间必须大于 0 秒" }],
					isError: true,
					details: { error: "Invalid duration" },
				};
			}

			const task = manager.createTask(totalSeconds, typedParams.prompt, rawTime, ctx, typedParams.deliverAs);
			return {
				content: [
					{
						type: "text" as const,
						text: `定时任务已成功创建 [#${task.id}]。将在 ${formatDateTime(task.targetTime)} (${formatDuration(task.delaySeconds)}后) 以 ${task.deliverAs} 模式发送提示词启动 Agent。`,
					},
				],
				details: {
					taskId: task.id,
					deliverAs: task.deliverAs,
					targetTime: task.targetTime,
					delaySeconds: task.delaySeconds,
					prompt: task.prompt,
				},
			};
		},
	});

	pi.registerTool({
		name: "timer_cancel",
		label: "Timer Cancel",
		description: "取消已创建但尚未触发的定时任务",
		parameters: TimerCancelSchema,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			manager.attach(ctx);
			const typedParams = params as TimerCancelParams;
			const targetId = typedParams.taskId || "all";
			const result = manager.cancelTask(targetId as string);
			return {
				content: [
					{
						type: "text" as const,
						text:
							result.count > 0
								? `已取消 ${result.count} 个定时任务: ${result.cancelled.map((id) => `#${id}`).join(", ")}`
								: "没有找到匹配的可取消定时任务",
					},
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "timer_list",
		label: "Timer List",
		description: "列出当前所有正在等待执行的定时任务",
		parameters: TimerListSchema,
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			manager.attach(ctx);
			const pending = manager.getPendingTasks();
			return {
				content: [
					{
						type: "text" as const,
						text:
							pending.length > 0
								? `当前共有 ${pending.length} 个定时任务等待执行:\n` +
									pending
										.map(
											(t) =>
												`- [#${t.id}] [${t.deliverAs}] 剩余 ${formatClockTime(Math.max(0, Math.ceil((t.targetTime - Date.now()) / 1000)))}: "${t.prompt}"`,
										)
										.join("\n")
								: "当前没有等待执行的定时任务",
					},
				],
				details: {
					count: pending.length,
					tasks: pending.map((t) => ({
						id: t.id,
						deliverAs: t.deliverAs,
						targetTime: t.targetTime,
						prompt: t.prompt,
						delaySeconds: t.delaySeconds,
					})),
				},
			};
		},
	});

	// 会话启动事件
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		manager.attach(ctx);
		// 启动或刷新已有倒计时 Widget
		manager.updateWidget();
	});

	// 会话关闭事件：销毁所有计时器，释放资源
	pi.on("session_shutdown", () => {
		manager.dispose();
	});
}
