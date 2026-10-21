# Compact：让 Agent 主动压缩上下文

## 接口与加载

Pi 内置 `/compact [instructions]` 供用户操作，并通过扩展 API 提供回调式的 `ctx.compact({ customInstructions, onComplete, onError })`，但未内置同名模型工具。此扩展注册 `compact`，让 LLM 主动请求压缩并在成功后继续工作。

要求 Pi 1.2+ 的 `turn_end` boundary、`model-only` 工具及 compaction callbacks；自动化测试使用仓库依赖 Pi 1.2，运行时实现也已对照本机 Pi 1.3 的声明和官方 `trigger-compact.ts` 示例。

加载整个 package 会自动发现 `extensions/compact.ts`，也可单独加载：

```bash
pi --extension ./extensions/compact.ts
```

无需配置文件、额外依赖、服务、watcher 或定时器。不修改 Pi 内置 `/compact` 或自动压缩阈值，也不覆盖已有 `session_before_compact` hook。

## 工具参数

```json
{
  "customInstructions": "保留用户目标和约束、已修改文件、已通过/失败的检查、当前阻塞，以及接下来要执行的具体步骤。"
}
```

| 参数 | 类型 | 含义 |
| --- | --- | --- |
| `customInstructions` | 可选 string，1–16000 字符 | 传给 Pi 摘要器的附加保留指令；缺省时使用 Pi 默认摘要。字符串两端空白会移除。 |

`compact` 是默认向模型声明的 **model-only** 工具，应直接调用，最好单独放在一批工具调用中。它不会向 codemode scripts 暴露，也不能通过 `ctx.executeTool()` 嵌套执行，避免脚本尚未完成时切换上下文。

适合长对话或一个重要任务阶段结束后使用，不应每轮调用或刚压缩就再次调用。仅“返回 queued”不表示压缩已经完成。重复的待执行请求会报错，不会覆盖第一份指令。

## 执行顺序与自动继续

1. `execute()` 检查取消信号，保存本次请求，返回 `details.status: "queued"`、保留指令和压缩前的 context usage 快照。
2. 结果包含 `terminate: true`，让独立的 compact 调用不产生普通的工具后续回复。如果模型同时调用其他工具，仍先等待整个批次结束。
3. `turn_end` 确认当前请求对应的成功工具结果已经持久化，且本轮没有失败或取消，再调用 `ctx.compact()`。
4. **不等待 compaction Promise**：该 API 返回 `void`。Pi 的手动压缩会中止并等待当前 run 退出，若在工具或 lifecycle handler 中包装 Promise 再 `await` 完成回调，会形成自等待死锁。此扩展触发后立即退出 handler，让 Pi 完成中止和压缩。
5. 成功回调提交一个隐藏的 `compact-result` custom message，保存 `status: "completed"`、`tokensBefore` 和 `estimatedTokensAfter`，并以 `triggerTurn: true, deliverAs: "followUp"` 恢复任务。续跑提示不冒充用户消息，并要求先推进任务，不立即再次压缩。
6. 失败或取消时提交可见的 `compact-result`，保存 `failed` / `cancelled` 与错误文本，但不重试、不自动继续。非取消失败还会显示短错误通知。原工具结果仍为排队确认，真实完成状态以该 custom message 为准。

Pi 的手动压缩在进行过程中显示的 run abort 是内部协调步骤，不会被误认为本次压缩取消。用户在压缩中取消会走失败回调，不自动恢复。

### 会话与中断边界

- 在 `session_start`、`session_shutdown`、切换/分叉/树导航前以及新一轮 `before_agent_start` 时撤销旧请求的续跑资格。
- 导航请求即使后来被其他扩展取消，也保守地放弃旧续跑。
- 完成回调同时检查请求对象和 session ID，晚到/重复回调不能恢复错误的会话或新任务。
- 中止的 queued 请求会清除；压缩已启动时由 Pi 管理其取消和资源释放。
- `details` 保存历史状态用于审计，但恢复、fork 或 reload **不重放 queued 操作**，避免历史工具结果再次触发上下文修改。
- 若核心或其他扩展在压缩完成时已经启动一个新任务，旧请求不会再追加一次自动续跑。

## 与 Pi 的关系及限制

- 使用 Pi 当前的模型选择、compaction settings、摘要格式、文件追踪、会话存储和 hooks，不自行生成或伪造 compaction entry。
- 仍尊重其他扩展对 `session_before_compact` 的取消或自定义摘要。
- 会话太短、刚完成压缩、无可用模型、摘要请求失败等情况可能压缩失败；不会为了强行压缩而调整 `keepRecentTokens` 或删除消息。
- 不要求开启自动压缩；与用户手动 `/compact` 一样，禁用自动阈值检查不等于禁用主动压缩。
- 自身不设置周期性阈值检测，不无限重试，不保证摘要一定减少多少 token。

## 权限与安全影响

- 扩展自身不执行 shell、不访问额外网络目标、不写独立配置文件。
- 调用 Pi 的正常摘要流程会向已配置的模型服务发送会话内容，产生额外的模型请求、token 消耗和费用；服务、凭据和传输策略沿用 Pi 配置。
- Pi 会向会话文件追加 compaction 与 custom message。压缩只改变后续模型看到的上下文，**不会删除原始会话历史**，不应当作隐私擦除功能。
- 摘要是有损的；关键约束、凭据保护要求、任务进度和下一步应写入保留指令，必要时持久化到工作文件。
- 自动继续是明确的功能：后续 Agent 仍可按原任务权限调用已有工具、修改文件或执行命令；此扩展不扩大那些工具的权限。

## 验证

```bash
node scripts/test-compact.mjs
npm run check
npm run validate
npm test
```

自动化覆盖 schema、直接调用限制、queued 与 completed 的区别、重复请求、错误/中止的 turn、被其他 hook 改成失败的工具结果、同步/异步错误、用户取消、生命周期失效和 session ID 防护。原生 Agent-core 测试使用有限的本地假响应与并行慢工具，确认全部工具结果先落盘，手动压缩式的 abort/wait 不死锁，成功回调只产生一次新任务轮次；不访问真实模型或个人配置。

手工冒烟验证（会使用当前模型并产生费用）：

1. 在一个已有足够历史的会话中加载扩展，要求 Agent 直接调用 `compact` 并保留一个明确的未完成步骤。
2. 确认工具先报告排队，然后出现 Pi 的 compaction 过程；完成后无需输入新消息，Agent 自动继续该步骤。
3. 在另一个已有足够历史的会话中于摘要阶段取消，确认不会自动继续；再主动发送消息可正常恢复。
4. 短会话调用可能出现 `Nothing to compact`，确认显示失败而不进入重试循环。
5. 用 `/tree`、会话切换或新用户任务中断旧请求，确认其晚到的回调不会额外恢复旧任务。
