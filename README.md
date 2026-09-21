# Pi Extensions

面向 [Pi coding agent](https://pi.dev) 的 Extensions、Skills、Prompt Templates 和 Themes 集合。

## 当前状态

仓库目前是一个可扩展的 Pi package 骨架。当前运行环境无法读取 GitHub 远端的提交或文件树：公开页面、Raw、codeload 和 Git smart protocol 均未返回可用内容，但这也可能是仓库尚未创建、没有提交，或仓库为 private 且当前环境没有认证权限，不能据此判断远端为空。因此这里提供的是基于 Pi 官方约定的初始目录，不声称是对远端已有实现的复制。

## 目录

| 路径 | 用途 |
| --- | --- |
| `extensions/` | TypeScript/JavaScript extensions，默认导出 Extension factory |
| `skills/` | `SKILL.md` 及其 references、scripts、assets |
| `prompts/` | 可复用的 Prompt Templates |
| `themes/` | Pi theme JSON 文件 |
| `docs/` | 架构和开发文档 |
| `scripts/` | package 结构校验脚本 |
| `AGENTS.md` | AI coding agent 和贡献者的仓库规则 |

## 开发

环境要求：Node.js 22 或更高版本。

```bash
npm install
npm run check
npm run validate
npm test
```

`package.json` 中的 `pi` 字段会把四类资源暴露给 Pi。开发单个 extension 时，可以直接运行：

```bash
pi --extension ./extensions/example.ts
```

安装为 Pi package 前，请先审查 Extension 的系统权限、文件写入、命令执行和网络访问行为。

## 添加资源

- Extension：新增 `extensions/<name>.ts`，默认导出 `ExtensionAPI` factory。
- Skill：新增 `skills/<name>/SKILL.md`，包含合法 frontmatter。
- Prompt：新增 `prompts/<name>.md`。
- Theme：新增 `themes/<name>.json`。

命名使用小写 kebab-case；运行时依赖放在 `dependencies`，Pi core 依赖放在 `peerDependencies`。完整规则见 [`AGENTS.md`](AGENTS.md) 和 [`docs/development.md`](docs/development.md)。

## Stream Read Retry

`extensions/stream-read-retry.ts` fixes a gap in Pi's built-in retry classification. Pi already has agent-level retry with exponential backoff, but `stream_read_error` is not included in the transient-error matcher, so the run ends immediately. This extension rewrites only that assistant error to include `Network error`, which lets Pi's existing retry flow handle it while preserving the original text.

Load the package or the extension directly:

```bash
pi --extension .
pi --extension ./extensions/stream-read-retry.ts
```

Keep agent-level retry enabled in `settings.json` (the default), and configure its budget if needed:

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000
  }
}
```

`retry.provider.maxRetries` controls provider SDK retries and does not enable Pi's agent-level retry. The extension has no network, file, or command side effects; it only changes the final assistant error text, which Pi may persist in session history.

## Todo Loop

`extensions/todo-loop.ts` continues the agent when the latest structured todo state still contains unfinished items. It reads `details.tasks` from `@juicesharp/rpiv-todo` and also accepts the `details.todos` format used by Pi's example todo extension. It also understands the `plan-mode` execution state used by Pi's example extension.

When an agent run ends, the extension queues a follow-up user message if Pi is not already retrying or compacting. It stops when all todos are complete, the final assistant text explicitly says it cannot continue, the operation was aborted by the user, or the follow-up limit is reached. The default limit is 20 automatic follow-ups; configure it with a CLI flag:

```bash
pi --todo-loop-max-followups 50
```

The count is derived from follow-up messages in the current session branch, so it survives `/reload` and session resume. Set it to `0` to disable automatic follow-ups.

The extension has no network, file, command, or external state side effects. The todo extension that owns the `todo` tool must be loaded separately; this extension only observes its persisted task state (`details.tasks` or `details.todos`).

## Rolling Tools

`extensions/rolling-tools.ts` displays a compact rolling widget for tool executions above the input editor while silencing verbose tool calls in the chat transcript.

- **Non-intrusive transcript**: Managed tools (`read`, `bash`, `grep`, `find`, `ls`, `mcp`, `mcp__*`, `rider_execute_tool`, `obs_recall`, `update_plan`, etc.) occupy 0 lines when collapsed, preventing terminal scroll floods. Press `Ctrl+O` to expand if full outputs are needed.
- **Diffs preserved**: File modifications (`edit`, `write`) keep their rich diff and content view in the transcript for immediate code review.
- **Universal tool & MCP support**: Uses dynamic in-place decoration on `ToolExecutionComponent`, supporting built-ins, MCP proxies (`mcp`, `mcp__*`), Rider MCP tools (`rider_execute_tool`), SoL-Pi tools, and arbitrary third-party tools with generic parameter heuristics.
- **SoL-Pi savings interception**: Intercepts and suppresses intrusive SoL-Pi popup toast notifications, rolling token savings info cleanly into the widget status line with one-click clipboard copying.
- **Configuration file support**: Supports global configuration (`~/.pi/agent/extensions/rolling-tools/config.json`) and local project overrides (`./.pi/rolling-tools.json`).
- **Fixed-dock rolling widget**: Shows the latest running/completed tools in a fixed dock above the editor with status (`⏳`/`✓`/`✗`), duration, and arguments summary.
- **Click-to-expand details**: Click any tool item to toggle details (`▸` / `▾`) such as full paths, multiline commands, and execution outputs without mouse hover flickering. Click details to copy to clipboard, or `Ctrl+Click` on paths to open files directly.
- **Commands**:
  - `/rolling-tools`: Toggle widget and transcript silencing on/off.
  - `/rolling-tools on` / `/rolling-tools off`: Explicitly enable or disable.
  - `/rolling-tools reload`: Hot-reload configuration from disk without restarting Pi.
  - `/rolling-tools status`: Display current active configuration, managed tools, and notification intercept rules.

Example configuration (`~/.pi/agent/extensions/rolling-tools/config.json`):

```json
{
  "enabled": true,
  "maxRecentTools": 3,
  "managedTools": [
    "read",
    "bash",
    "grep",
    "find",
    "ls",
    "mcp",
    "mcp__*",
    "rider_execute_tool",
    "obs_recall",
    "update_plan"
  ],
  "genericPropertyFallbacks": [
    "command",
    "path",
    "pattern",
    "query",
    "url",
    "tool",
    "prompt"
  ],
  "interceptNotifications": [
    {
      "match": "SoL-Pi",
      "suppressToast": true,
      "rollIntoWidget": true
    }
  ]
}
```

Load directly:

```bash
pi --extension ./extensions/rolling-tools.ts
```

## Pi package

```bash
# 从本地目录临时加载
pi --extension .

# 发布前检查 package 内容
npm pack --dry-run
```

本项目暂不声明具体 License；确定开源授权后，请补充 `LICENSE` 和 package metadata。
