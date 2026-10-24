import assert from "node:assert/strict";
import { mock } from "node:test";
import timerExtension, {
	parseTimerArgs,
	formatDuration,
	formatClockTime,
	TimerManager,
	TimerStatusModalComponent,
	TIMER_CUSTOM_ENTRY_TYPE,
	TIMER_WIDGET_KEY,
} from "../extensions/timer.ts";

console.log("=== Test 1: parseTimerArgs Parsing Capabilities ===");

// 1. 测试秒 分 时 空格分隔三纯数字
{
	const res = parseTimerArgs("30 2 0 执行代码检查");
	assert.equal(res.success, true);
	if (res.success) {
		assert.equal(res.data.seconds, 150, "30s + 2m = 150s");
		assert.equal(res.data.prompt, "执行代码检查");
		assert.equal(res.data.rawTime, "30秒 2分 0时");
	}
}

{
	const res = parseTimerArgs("00 05 00 备份数据库");
	assert.equal(res.success, true);
	if (res.success) {
		assert.equal(res.data.seconds, 300, "5m = 300s");
		assert.equal(res.data.prompt, "备份数据库");
	}
}

// 2. 测试时:分:秒 冒号标准格式
{
	const res = parseTimerArgs("01:30:00 整理文档");
	assert.equal(res.success, true);
	if (res.success) {
		assert.equal(res.data.seconds, 5400, "1h30m = 5400s");
		assert.equal(res.data.prompt, "整理文档");
		assert.equal(res.data.rawTime, "01:30:00");
	}
}

{
	const res = parseTimerArgs("02:30 总结今天的内容");
	assert.equal(res.success, true);
	if (res.success) {
		assert.equal(res.data.seconds, 150, "2m30s = 150s");
		assert.equal(res.data.prompt, "总结今天的内容");
		assert.equal(res.data.rawTime, "02:30");
	}
}

// 3. 测试自然时间语法
{
	const res = parseTimerArgs("5m 启动部署");
	assert.equal(res.success, true);
	if (res.success) {
		assert.equal(res.data.seconds, 300);
		assert.equal(res.data.prompt, "启动部署");
	}
}

{
	const res = parseTimerArgs("30s 提醒我喝水");
	assert.equal(res.success, true);
	if (res.success) {
		assert.equal(res.data.seconds, 30);
		assert.equal(res.data.prompt, "提醒我喝水");
	}
}

{
	const res = parseTimerArgs("1h 30m \"发布新版本\"");
	assert.equal(res.success, true);
	if (res.success) {
		assert.equal(res.data.seconds, 5400);
		assert.equal(res.data.prompt, "发布新版本");
	}
}

{
	const res = parseTimerArgs("1小时30分钟 执行健康检查");
	assert.equal(res.success, true);
	if (res.success) {
		assert.equal(res.data.seconds, 5400);
		assert.equal(res.data.prompt, "执行健康检查");
	}
}

// 4. 测试两数字 (秒 分)
{
	const res = parseTimerArgs("15 3 运行单元测试");
	assert.equal(res.success, true);
	if (res.success) {
		assert.equal(res.data.seconds, 195, "15s + 3m = 195s");
		assert.equal(res.data.prompt, "运行单元测试");
	}
}

// 5. 测试单数字 (秒)
{
	const res = parseTimerArgs("45 发送心跳");
	assert.equal(res.success, true);
	if (res.success) {
		assert.equal(res.data.seconds, 45);
		assert.equal(res.data.prompt, "发送心跳");
	}
}

// 6. 异常参数
{
	const resEmpty = parseTimerArgs("");
	assert.equal(resEmpty.success, false);

	const resZero = parseTimerArgs("0 0 0 提示词");
	assert.equal(resZero.success, false);
}

console.log("✓ parseTimerArgs all tests passed!");

console.log("\n=== Test 2: Formatting Helpers ===");
assert.equal(formatDuration(45), "45秒");
assert.equal(formatDuration(150), "2分30秒");
assert.equal(formatDuration(3665), "1小时1分5秒");
assert.equal(formatClockTime(45), "00:45");
assert.equal(formatClockTime(150), "02:30");
assert.equal(formatClockTime(3665), "01:01:05");
console.log("✓ Formatting helpers passed!");

console.log("\n=== Test 3: TimerManager Lifecycle & Dispatch ===");
{
	const appendedEntries = [];
	const sentMessages = [];
	const notifications = [];
	let widgetSet = null;

	const fakePi = {
		appendEntry(type, data) {
			appendedEntries.push({ type, data });
		},
		sendUserMessage(content, options) {
			sentMessages.push({ content, options });
		},
	};

	const fakeCtx = {
		hasUI: true,
		isIdle: () => true,
		ui: {
			setWidget(key, lines) {
				widgetSet = { key, lines };
			},
			notify(msg, level) {
				notifications.push({ msg, level });
			},
		},
	};

	const manager = new TimerManager(fakePi);
	manager.attach(fakeCtx);

	// 1. 创建任务 (1秒延迟)
	const task = manager.createTask(1, "测试任务1", "1秒", fakeCtx);
	assert.equal(task.status, "pending");
	assert.equal(task.deliverAs, "steer");
	assert.equal(appendedEntries[0].data.deliverAs, "steer");
	assert.equal(manager.getPendingTasks().length, 1);
	assert.equal(appendedEntries.length, 1);
	assert.equal(appendedEntries[0].data.action, "created");
	assert.equal(appendedEntries[0].data.taskId, task.id);
	assert.ok(widgetSet !== null, "Widget should be set");
	assert.equal(widgetSet.key, TIMER_WIDGET_KEY);
	assert.ok(widgetSet.lines[0].includes("定时任务倒计时"));

	// 2. 状态模态渲染验证
	const fakeTui = { terminal: { rows: 30 } };
	const fakeTheme = {
		fg: (c, t) => `[${c}]${t}`,
		bg: (c, t) => `[bg:${c}]${t}`,
		style: (t) => t,
	};
	let modalClosed = false;
	const modal = new TimerStatusModalComponent(fakeTui, fakeTheme, manager, () => {
		modalClosed = true;
	});
	const rendered = modal.render(80);
	assert.ok(rendered.length > 5, "Modal should render multiple lines");
	assert.ok(rendered.some((l) => l.includes("定时任务管理器")), "Modal should contain title");
	assert.ok(rendered.some((l) => l.includes("测试任务1")), "Modal should contain active task");

	// 触发按键关闭
	modal.handleInput("q");
	assert.equal(modalClosed, true, "Modal onClose should be triggered");

	// 3. 等待触发 (稍后触发后验证自动发送与 entry 追加)
	await new Promise((resolve) => setTimeout(resolve, 1150));

	assert.equal(task.status, "completed");
	assert.equal(manager.getPendingTasks().length, 0);
	assert.equal(sentMessages.length, 1, "sendUserMessage should be invoked");
	assert.equal(sentMessages[0].content, "测试任务1");
	assert.deepEqual(sentMessages[0].options, { deliverAs: "steer" });

	assert.equal(appendedEntries.length, 2);
	assert.equal(appendedEntries[1].data.action, "triggered");
	assert.equal(appendedEntries[1].data.taskId, task.id);

	// 验证取消流程
	const task2 = manager.createTask(60, "待取消任务2", "60秒", fakeCtx);
	assert.equal(manager.getPendingTasks().length, 1);
	const cancelRes = manager.cancelTask(task2.id);
	assert.equal(cancelRes.count, 1);
	assert.equal(task2.status, "cancelled");
	assert.equal(manager.getPendingTasks().length, 0);
	assert.equal(appendedEntries.length, 4);
	assert.equal(appendedEntries[3].data.action, "cancelled");

	manager.dispose();
	console.log("✓ TimerManager lifecycle, trigger, cancel & modal passed!");
}

console.log("\n=== Test 4: Tool/Command Delivery Modes (Idle & Busy) ===");
{
	mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
	const tools = new Map(), commands = new Map(), events = new Map();
	const entries = [], sent = [];
	let idle = true;
	const ctx = {
		hasUI: false,
		isIdle: () => idle,
		ui: { notify() {}, setWidget() {} },
	};
	const pi = {
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, command) { commands.set(name, command); },
		registerEntryRenderer() {},
		on(name, handler) { events.set(name, handler); },
		appendEntry(type, data) { entries.push({ type, data }); },
		sendUserMessage(content, options) { sent.push({ content, options }); },
	};
	timerExtension(pi);
	const schedule = tools.get("timer_schedule");
	const list = tools.get("timer_list");
	assert.equal(schedule.parameters.properties.deliverAs.default, "steer");
	assert.deepEqual(schedule.parameters.properties.deliverAs.anyOf.map(s => s.const), ["steer", "followUp"]);
	try {
		for (const isIdle of [true, false]) {
			idle = isIdle;
			for (const mode of [undefined, "steer", "followUp"]) {
				const expected = mode ?? "steer";
				const result = await schedule.execute("schedule", {
					seconds: 1, prompt: `task-${isIdle}-${mode}`, ...(mode ? { deliverAs: mode } : {}),
				}, undefined, undefined, ctx);
				assert.equal(result.details.deliverAs, expected);
				assert.ok(result.content[0].text.includes(expected));
				const pending = await list.execute("list", {}, undefined, undefined, ctx);
				assert.equal(pending.details.count, 1);
				assert.equal(pending.details.tasks[0].deliverAs, expected);
				assert.ok(pending.content[0].text.includes(`[${expected}]`));
				assert.equal(entries.at(-1).data.deliverAs, expected);
				const count = sent.length;
				mock.timers.tick(999);
				assert.equal(sent.length, count, "must not deliver before the deadline");
				mock.timers.tick(1);
				assert.equal(sent.length, count + 1);
				assert.deepEqual(sent.at(-1), { content: result.details.prompt, options: { deliverAs: expected } });
				assert.equal(entries.at(-1).data.action, "triggered");
				assert.equal(entries.at(-1).data.deliverAs, expected);
			}
			for (const name of ["timer", "schedule"]) {
				await commands.get(name).handler("1 command task", ctx);
				mock.timers.tick(1000);
				assert.deepEqual(sent.at(-1), { content: "command task", options: { deliverAs: "steer" } });
			}
		}
		// Cancellation records retain the chosen delivery mode and never deliver.
		const cancelled = await schedule.execute("cancel-me", {
			seconds: 1, prompt: "cancelled", deliverAs: "followUp",
		}, undefined, undefined, ctx);
		await tools.get("timer_cancel").execute("cancel", { taskId: cancelled.details.taskId }, undefined, undefined, ctx);
		assert.equal(entries.at(-1).data.action, "cancelled");
		assert.equal(entries.at(-1).data.deliverAs, "followUp");
		const count = sent.length;
		mock.timers.tick(1000);
		assert.equal(sent.length, count);

		// A synchronous send failure must not silently switch delivery modes on retry.
		const send = pi.sendUserMessage;
		const warn = mock.method(console, "warn", () => {});
		try {
			for (const mode of ["steer", "followUp"]) {
				const attempts = [];
				pi.sendUserMessage = (content, options) => {
					attempts.push(options.deliverAs);
					if (attempts.length === 1) throw new Error("transient send failure");
					send(content, options);
				};
				await schedule.execute("retry", { seconds: 1, prompt: "retry", deliverAs: mode }, undefined, undefined, ctx);
				mock.timers.tick(1000);
				assert.deepEqual(attempts, [mode, mode]);
			}
		} finally {
			pi.sendUserMessage = send;
			warn.mock.restore();
		}
	} finally {
		events.get("session_shutdown")();
		mock.timers.reset();
	}
	console.log("✓ Default steering, explicit followUp, idle/busy dispatch, records, cancellation & retry passed!");
}
