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
import { deferTools } from "./lib/tool-exposure.ts";

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
			description: "Delivery mode, steer by default: the message is inserted at the next processable boundary while the agent is busy, which may skip tools that have not run yet. followUp waits until the current task finishes and does not interrupt it. Either mode starts a new turn immediately when the agent is idle.",
		}),
	),
	prompt: Type.String({
		description: "Prompt or task sent to the agent when the timer fires.",
	}),
	seconds: Type.Optional(
		Type.Integer({
			minimum: 0,
			description: "Delay in seconds, added to minutes and hours.",
		}),
	),
	minutes: Type.Optional(
		Type.Integer({
			minimum: 0,
			description: "Delay in minutes, added to seconds and hours.",
		}),
	),
	hours: Type.Optional(
		Type.Integer({
			minimum: 0,
			description: "Delay in hours, added to seconds and minutes.",
		}),
	),
	timeExpression: Type.Optional(
		Type.String({
			description:
				"Time expression such as '30 0 0' (seconds minutes hours), '5m', '00:05:00' or '1h 30m'. Takes precedence over the numeric fields.",
		}),
	),
});

export const TimerCancelSchema = Type.Object({
	taskId: Type.Optional(
		Type.String({
			description: "Timer task ID to cancel, for example 't-1'. Pass 'all' or omit it to cancel every waiting task.",
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
		return `${totalSeconds}s`;
	}
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0) parts.push(`${seconds}s`);
	return parts.join("") || "0s";
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
			error: "Missing arguments. Usage: /timer [seconds] [minutes] [hours] <prompt> or /timer <time> <prompt>",
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
			return { success: false, error: "The delay must be greater than 0 seconds" };
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
			return { success: false, error: "The delay must be greater than 0 seconds" };
		}
		return {
			success: true,
			data: {
				seconds: totalSeconds,
				prompt,
				rawTime: `${s}s ${m}m ${h}h`,
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
			return { success: false, error: "The delay must be greater than 0 seconds" };
		}
		return {
			success: true,
			data: {
				seconds: totalSeconds,
				prompt,
				rawTime: `${s}s ${m}m`,
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
			return { success: false, error: "The delay must be greater than 0 seconds" };
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
			return { success: false, error: "The delay must be greater than 0 seconds" };
		}
		return {
			success: true,
			data: {
				seconds: s,
				prompt,
				rawTime: `${s}s`,
			},
		};
	}

	return {
		success: false,
		error: `Unrecognized time format: "${trimmed}". Supported: "30 2 0" (seconds minutes hours), "5m", "00:05:00", "30s" and similar`,
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
			throw new Error("The delay is invalid or out of the supported range");
		}
		if (!prompt.trim()) throw new Error("The prompt must not be empty");
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
			`⏱️ Scheduled task [#${id}] created. The prompt will be sent in ${formatDuration(delaySeconds)} at ${targetTimeStr} to start the agent.`,
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
			this.notify(`🚫 Cancelled scheduled task(s): ${cancelledIds.map((tid) => `#${tid}`).join(", ")}`, "info");
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
		this.notify(`🚀 Scheduled task [#${task.id}] reached its deadline; the message was sent to start the task.`, "info");

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

		const moreInfo = pending.length > 1 ? ` (+${pending.length - 1} more waiting)` : "";
		const urgent = remainingSeconds <= 10;
		const icon = urgent ? "🔥" : "⏳";

		const line = `${icon} [timer] [#${soonest.id}] fires in ${clockStr}${moreInfo} | prompt: "${previewPrompt}" | cancel: /timer cancel ${soonest.id}`;

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
		this.modal = new StatusModalComponent(tui, theme, "⏱️ Scheduled Tasks", () => {
			const pending = manager.getPendingTasks();
			const all = manager.getAllTasks();
			return [
				`active: ${pending.length} | fired: ${all.filter(t => t.status === "completed").length} | cancelled: ${all.filter(t => t.status === "cancelled").length}`,
				...(pending.length ? pending.flatMap(task => [
					`[#${task.id}] fires in ${formatClockTime(Math.max(0, Math.ceil((task.targetTime - Date.now()) / 1000)))} (due ${formatDateTime(task.targetTime)})`,
					`delivery: ${task.deliverAs} | prompt: ${task.prompt}`,
				]) : ["(no scheduled task is waiting)"]),
				"",
				"create: /timer [seconds] [minutes] [hours] <prompt>",
				"cancel: /timer cancel <id> or /timer cancel all",
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
			`Scheduled task status`,
			`Waiting tasks: ${pending.length}`,
			...pending.map(
				(t) =>
					`#${t.id} - ${formatClockTime(Math.max(0, Math.ceil((t.targetTime - Date.now()) / 1000)))} left - prompt: ${t.prompt}`,
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
					new Text(safeFg(theme, "accent", `⏱️ Scheduled task created [#${data.taskId}]`), 0, 0),
				);
				box.addChild(
					new Text(
						`${safeFg(theme, "muted", "Due at: ")}${targetTimeStr} (in ${durationStr})`,
						0,
						0,
					),
				);
				box.addChild(new Text(`${safeFg(theme, "accent", "Prompt: ")}${data.prompt}`, 0, 0));
				box.addChild(
					new Text(
						safeFg(
							theme,
							"dim",
							"The countdown updates above the input box; when it reaches zero the prompt is sent and the task starts",
						),
						0,
						0,
					),
				);
			} else if (data.action === "triggered") {
				const triggerTimeStr = formatDateTime(data.triggeredAt || Date.now());
				box.addChild(
					new Text(safeFg(theme, "success", `🚀 Scheduled task fired [#${data.taskId}]`), 0, 0),
				);
				box.addChild(
					new Text(`${safeFg(theme, "muted", "Fired at: ")}${triggerTimeStr}`, 0, 0),
				);
				box.addChild(
					new Text(
						safeFg(theme, "success", "The prompt was sent to the agent; starting the task..."),
						0,
						0,
					),
				);
				box.addChild(new Text(`${safeFg(theme, "accent", "Prompt: ")}${data.prompt}`, 0, 0));
			} else if (data.action === "cancelled") {
				const cancelTimeStr = formatDateTime(data.cancelledAt || Date.now());
				box.addChild(
					new Text(safeFg(theme, "warning", `🚫 Scheduled task cancelled [#${data.taskId}]`), 0, 0),
				);
				box.addChild(
					new Text(`${safeFg(theme, "muted", "Cancelled at: ")}${cancelTimeStr}`, 0, 0),
				);
				box.addChild(
					new Text(`${safeFg(theme, "dim", "Original prompt: ")}${data.prompt}`, 0, 0),
				);
			}

			if (expanded) {
				const meta = `Task ID: ${data.taskId} | delay: ${data.delaySeconds}s | recorded: ${new Date(data.targetTime - data.delaySeconds * 1000).toLocaleString()}`;
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
				"Enter the delay (for example '30 0 0' for seconds minutes hours, '5m' or '00:05:00'):",
			);
			if (!timeStr || !timeStr.trim()) {
				ctx.ui.notify("Scheduled task creation cancelled", "info");
				return;
			}
			const promptStr = await ctx.ui.input("Enter the prompt to send to the agent when the timer fires:");
			if (!promptStr || !promptStr.trim()) {
				ctx.ui.notify("Scheduled task creation cancelled (no prompt given)", "info");
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
			"Usage: /timer [seconds] [minutes] [hours] <prompt>\nor: /timer <duration: 5m|30s|1h30m> <prompt>\nsubcommands: /timer status | list | cancel [id|all]",
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
			ctx.ui.notify("No scheduled task is waiting", "info");
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
				ctx.ui.notify(`No waiting task matched: ${rest}`, "warning");
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
				return `#${t.id}: ${formatClockTime(rem)} left - "${t.prompt.slice(0, 24)}"`;
			});
			options.push("Cancel all");

			const selected = await ctx.ui.select("Select the scheduled task to cancel:", options);
			if (!selected) {
				ctx.ui.notify("Operation cancelled", "info");
				return;
			}
			if (selected === "Cancel all") {
				manager.cancelTask("all");
				return;
			}
			const match = selected.match(/^#([a-zA-Z0-9-]+):/);
			if (match) {
				manager.cancelTask(match[1]);
			}
			return;
		}

		ctx.ui.notify("Specify the task ID to cancel, for example /timer cancel t-1 or /timer cancel all", "warning");
		return;
	}

	// 5. 子命令: help
	if (firstToken === "help") {
		ctx.ui.notify(
			[
				"⏱️ Timer extension guide:",
				"1. By seconds minutes hours: /timer 30 2 0 check my code (fires 2m30s later)",
				"2. By duration: /timer 5m refactor my code, or /timer 30s remind me",
				"3. By clock notation: /timer 00:05:00 run my tests",
				"4. Open the status modal: /timer status",
				"5. List waiting tasks: /timer list",
				"6. Cancel tasks: /timer cancel [id|all]",
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
			const promptStr = await ctx.ui.input("Enter the prompt to send to the agent when the timer fires:");
			if (!promptStr || !promptStr.trim()) {
				ctx.ui.notify("Scheduled task creation cancelled (no prompt given)", "info");
				return;
			}
			prompt = promptStr.trim();
		} else {
			ctx.ui.notify("The prompt is missing. Add the task text to send to the agent after the delay.", "warning");
			return;
		}
	}

	manager.createTask(parsed.data.seconds, prompt, parsed.data.rawTime, ctx);
}

// ==========================================
// Extension 导出入口
// ==========================================

const TIMER_SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "status", label: "status", description: "Show the scheduled task status and history modal" },
	{ value: "list", label: "list", description: "List every scheduled task that is waiting" },
	{ value: "cancel", label: "cancel", description: "Cancel a scheduled task (cancel all or an ID)" },
	{ value: "help", label: "help", description: "Show the time expression syntax and usage guide" },
	{ value: "5m ", label: "5m", description: "Preset: send the prompt in 5 minutes" },
	{ value: "30s ", label: "30s", description: "Preset: send the prompt in 30 seconds" },
	{ value: "10m ", label: "10m", description: "Preset: send the prompt in 10 minutes" },
	{ value: "30m ", label: "30m", description: "Preset: send the prompt in 30 minutes" },
	{ value: "1h ", label: "1h", description: "Preset: send the prompt in 1 hour" },
	{ value: "30 0 0 ", label: "30 0 0", description: "Preset: 30 seconds (seconds minutes hours)" },
];

export function getTimerArgumentCompletions(
	argumentPrefix: string,
	manager?: TimerManager,
): AutocompleteItem[] | null {
	const prefix = (argumentPrefix || "").trimStart();

	if (prefix.startsWith("cancel")) {
		const sub = prefix.slice(6).trimStart().toLowerCase();
		const options: AutocompleteItem[] = [
			{ value: "cancel all", label: "all", description: "Cancel every waiting scheduled task" },
		];

		if (manager) {
			const pending = manager.getPendingTasks();
			for (const t of pending) {
				const rem = Math.max(0, Math.ceil((t.targetTime - Date.now()) / 1000));
				options.push({
					value: `cancel ${t.id}`,
					label: t.id,
					description: `Cancel task #${t.id} (${formatClockTime(rem)} left): "${t.prompt.slice(0, 20)}"`,
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
	deferTools(pi, ["timer_schedule", "timer_cancel", "timer_list"]);
	const manager = new TimerManager(pi);

	// 注册正文渲染器
	registerTimerEntryRenderer(pi);

	// 注册主命令 /timer
	pi.registerCommand("timer", {
		description: "Schedule a message that starts an agent task later, for example /timer 30 2 0 <prompt> or /timer 5m <prompt>",
		getArgumentCompletions: (prefix) => getTimerArgumentCompletions(prefix, manager),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await handleTimerCommand(args, ctx, manager);
		},
	});

	// 注册别名命令 /schedule
	pi.registerCommand("schedule", {
		description: "Alias for scheduling tasks (same as /timer)",
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
			"Schedule a prompt to be sent later as a new turn. deliverAs defaults to steer, which inserts the message at the next processable boundary while the agent is busy; followUp waits until the current task finishes instead of interrupting it. Either mode starts a new turn when the agent is idle.",
		parameters: TimerScheduleSchema,
		exposure: "deferred",
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
						content: [{ type: "text" as const, text: `Could not parse the time expression: ${parsed.error}` }],
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
				rawTime = `${s}s ${m}m ${h}h`;
			}

			if (totalSeconds <= 0) {
				return {
					content: [{ type: "text" as const, text: "The delay must be greater than 0 seconds." }],
					isError: true,
					details: { error: "Invalid duration" },
				};
			}

			const task = manager.createTask(totalSeconds, typedParams.prompt, rawTime, ctx, typedParams.deliverAs);
			return {
				content: [
					{
						type: "text" as const,
						text: `Timer task created [#${task.id}]. The prompt will be sent in ${formatDuration(task.delaySeconds)} at ${formatDateTime(task.targetTime)}, using ${task.deliverAs} mode.`,
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
		description: "Cancel a scheduled task that has not fired yet.",
		parameters: TimerCancelSchema,
		exposure: "deferred",
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
								? `Cancelled ${result.count} scheduled task(s): ${result.cancelled.map((id) => `#${id}`).join(", ")}`
								: "No matching scheduled task could be cancelled",
					},
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "timer_list",
		label: "Timer List",
		description: "List every scheduled task that is still waiting to fire.",
		parameters: TimerListSchema,
		exposure: "deferred",
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			manager.attach(ctx);
			const pending = manager.getPendingTasks();
			return {
				content: [
					{
						type: "text" as const,
						text:
							pending.length > 0
								? `${pending.length} scheduled task(s) waiting:
` +
									pending
										.map(
											(t) =>
												`- [#${t.id}] [${t.deliverAs}] ${formatClockTime(Math.max(0, Math.ceil((t.targetTime - Date.now()) / 1000)))} left: "${t.prompt}"`,
										)
										.join("\n")
								: "No scheduled task is waiting",
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
