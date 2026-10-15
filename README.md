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

`extensions/stream-read-retry.ts` fixes a gap in Pi's built-in retry classification. Pi already has agent-level retry with exponential backoff, but its transient-error matcher (`isRetryableAssistantError` in `pi-ai/dist/utils/retry.js`) does not cover every premature stream ending. In particular, a stream that closes before its terminal completion event — for example `stream error: stream disconnected before completion: stream closed before response.completed` — is not recognized, so the run ends immediately instead of retrying.

This extension matches a set of transport-level premature-stream-end signatures (stream/connection resets, unexpected end of stream, `closed before response.completed`, ...) and rewrites only those assistant errors to include `Network error`, which lets Pi's existing retry flow handle them. Messages that Pi already classifies as retryable, and deterministic errors such as quota/billing or invalid-request failures, are left untouched. The original error text is preserved after the prefix.

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

- **All tools silenced by default**: Every tool (built-ins, `edit`, `write`, `codemode`, MCP proxies, SoL-Pi `recall`, Trellis `subagent`, and arbitrary third-party tools) is hidden from the transcript by default and rolled into the widget. Tune with `silencedTools` / `widgetTools` (supports `*` wildcards).
- **Non-intrusive transcript**: Managed tools occupy 0 lines when collapsed, preventing terminal scroll floods. Press `Ctrl+O` to expand if full outputs are needed.
- **History overlay dialog (`➕`)**: A persistent header row sits above the tool list and carries a `➕` button on its right edge. Clicking it opens a large bordered two-pane overlay dialog showing the full history on the left and the selected tool's complete content on the right — including `edit` diffs, `write` file bodies, full commands, and outputs. The overlay updates live while the agent is still running.
- **View mode toggle button (`🔽` / `⏏️`)**: Positioned directly to the left of `➕`, this button toggles the widget between two display modes:
  1. **Running tasks only (`running` - `⏏️`)**: Active running tasks are merged directly into the header status line alongside a live elapsed timer (`(19ms)`, `(2.4s)`). The widget remains strictly 1-line high to eliminate any vertical height flicker.
  2. **Fixed recent rows (`fixed` - `🔽`)**: Displays the most recent `maxRecentTools` executions (default 3 rows, customizable via config). Running tasks in this list also display live ticking durations.
- **Persistent header status line**: The status row (waiting for server → thinking → thinking done) is always visible as the fixed header of the rolling block, and keeps showing `思考完成` after a turn completes.
- **Sticky history across `/reload`**: The widget, view mode, and its `➕` dialog keep working after `/reload`; history and view state are re-read from the current session's persisted entries because a reload constructs a fresh extension instance.
- **Lazy loading with wheel scroll**: The overlay supports native mouse-wheel scrolling. Scrolling up past the top of the list lazily loads the next `lazyLoadStep` (default 10) older entries, so long histories stay responsive without loading everything at once.
- **Persistent across turns and sessions**: The rolling block no longer resets on each new task. History is kept in memory across turns and persisted to the session via `pi.appendEntry()` (custom type `rolling-tools-history`), so it is restored on `reload`, `resume`, and `fork` when `persistAcrossSessions` is enabled.
- **Universal tool & MCP support**: Uses dynamic in-place decoration on `ToolExecutionComponent`, supporting built-ins, MCP proxies (`mcp`, `mcp__*`), Rider MCP tools (`rider_execute_tool`), SoL-Pi tools, and arbitrary third-party tools with generic parameter heuristics.
- **Unified tips handling**: Plugin tips (`ui.notify`) are suppressed from the transcript. `ui.setStatus` tips stay in the footer and are colorized, but are only auto-cleared when their rule sets `durationMs`; persistent keys (`persistentKeys`, default `["blackhole", "mcp"]`) pass through untouched so long-lived gauges such as pi-blackhole's footer bar and the MCP server status keep working. `error` / `warning` messages and any message containing a `notificationKeywords` word always pass through. Plugin headers such as SoL-Pi's `⚡ SoL-Pi · …` / `Money saved · …` are stripped from tool rows.
- **Configuration file support**: Supports global configuration (`~/.pi/agent/extensions/rolling-tools/config.json`) and local project overrides (`./.pi/rolling-tools.json`).
- **Fixed-dock rolling widget**: Shows the latest running/completed tools in a fixed dock above the editor with status (`⏳`/`✓`/`✗`), duration, and arguments summary.
- **Click-to-expand details**: Click any tool item to toggle details (`▸` / `▾`) such as full paths, multiline commands, and execution outputs without mouse hover flickering. Click details to copy to clipboard, or `Ctrl+Click` on paths to open files directly.
- **Commands**:
  - `/rolling-tools`: Toggle widget and transcript silencing on/off.
  - `/rolling-tools on` / `/rolling-tools off`: Explicitly enable or disable.
  - `/rolling-tools mode [running|fixed]`: Switch display mode between running tasks only and fixed recent rows.
  - `/rolling-tools reload`: Hot-reload configuration from disk without restarting Pi.
  - `/rolling-tools status`: Display current active configuration, view mode, tool rules, lazy-load step, and persistence state.
  - `/rolling-tools history` (alias `/rolling-tools open`): Open the history overlay dialog directly.
  - `/rolling-tools migrate`: Upgrade a legacy config (schema v1) to the new all-tools semantics (`["*"]`), writing `configVersion: 2`.
  - Hotkeys: Press `Ctrl+O` in interactive mode to expand the entire transcript and inspect raw tool executions. Inside the overlay: `↑`/`↓` or `j`/`k` select, `PgUp`/`PgDn` scroll details, `Esc`/`q` close.

### Config migration (v1 → v2)

Earlier versions configured tools via a `managedTools` whitelist only. v2 introduces `silencedTools` / `widgetTools` and defaults all three to `["*"]` (all tools hidden and rolled into the widget).

Upgrading is **non-destructive**: a legacy config (no `configVersion`, or `< 2`) keeps its original whitelist semantics, and the extension shows a one-time warning notice explaining how to opt in. To adopt the new behavior, either set `managedTools` / `silencedTools` / `widgetTools` to `["*"]` manually, or run:

```
/rolling-tools migrate
```

which rewrites the config (`configVersion: 2`) while preserving your other settings.

Example configuration (`~/.pi/agent/extensions/rolling-tools/config.json`):

> Every field is optional. Omit the file entirely to use the defaults below.

```json
{
  "enabled": true,
  "maxRecentTools": 3,
  "defaultViewMode": "fixed",
  "lazyLoadStep": 10,
  "persistAcrossSessions": true,
  "configVersion": 3,
  "managedTools": ["*"],
  "silencedTools": ["*"],
  "widgetTools": ["*"],
  "genericPropertyFallbacks": [
    "command",
    "path",
    "pattern",
    "query",
    "url",
    "tool",
    "prompt"
  ],
  "interceptNotifications": [{ "match": "*", "suppressToast": true }],
  "statusEnhancements": [
    {
      "keyPattern": "*",
      "showRelativeTime": false,
      "colorize": true,
      "persistentKeys": ["blackhole", "mcp"]
    }
  ],
  "notificationKeywords": [
    "error",
    "failed",
    "failure",
    "warning",
    "错误",
    "失败",
    "警告",
    "⚠",
    "❌",
    "🔴"
  ],
  "stripToolNotificationHeaders": true
}
```

### Notification and tips handling

Plugins commonly emit tips through two channels. Rolling Tools unifies both so they no longer clutter the transcript:

| Channel | Behavior |
| --- | --- |
| `ui.notify(message, "info")` | Suppressed by default (`interceptNotifications: [{ "match": "*" }]`). It never reaches the transcript. |
| `ui.setStatus(key, text)` | Kept and colorized. It is **not** auto-cleared unless the matching rule sets `durationMs`. |

**Persistent status keys** (`persistentKeys`, default `["blackhole", "mcp"]`) are passed through completely untouched: no countdown, no forced colorization, and their own clear calls (`setStatus(key, undefined)`) are never swallowed. This protects long-lived gauges such as pi-blackhole's footer bar and the MCP adapter's server status.

To make a transient tip disappear on its own, add `durationMs` to its rule:

```json
"statusEnhancements": [
  { "keyPattern": "*", "colorize": true, "persistentKeys": ["blackhole", "mcp"] },
  { "keyPattern": "sol-pi*", "durationMs": 8000, "colorize": true }
]
```

Rules are matched in order, so put the more specific `durationMs` rule before or after the wildcard as needed (the first match wins). `persistentKeys` from the defaults are always unioned into your rules, so you cannot accidentally drop that protection.

Two escape hatches keep important messages visible:

1. **Type-based** — `error` and `warning` notifications always pass through (Pi routes them to `showError` / `showWarning`).
2. **Keyword-based** — any `info` message containing a word from `notificationKeywords` (default: `error`, `failed`, `failure`, `warning`, `错误`, `失败`, `警告`, `⚠`, `❌`, `🔴`) also passes through.

Additionally, `stripToolNotificationHeaders` (default `true`) removes plugin-inserted headers such as SoL-Pi's `⚡ SoL-Pi · Action Fusion` / `Money saved · …` lines from tool rows, so the same information is not repeated next to the tool. This uses `pi.registerToolRenderer` and degrades silently on Pi versions that lack it.

> **Note on widget vs. overlay scrolling**: Pi's dock does not forward mouse-wheel events to widgets, so the small rolling widget itself is not scrollable. Mouse-wheel scrolling and top-edge lazy loading are provided inside the `[⤢]` overlay dialog, where the TUI dispatches wheel events directly to the overlay component.

> **Overlay interactions**: The dialog is drawn as a centered box on a full-screen canvas. Click a row in the left list to copy that tool's detail (diff, codemode script, command, path, or output) to the clipboard — the bottom hint line shows a short confirmation. Click anywhere outside the box, or press `Esc`/`q`, to close it. This is the reliable way to grab long content, because terminal text selection is owned by the host and would otherwise span the transcript behind the dialog.

Load directly:

```bash
pi --extension ./extensions/rolling-tools.ts
```

## Image Pager (Virtual Memory Paging for Multimodal Images)

`extensions/image-pager.ts` 借鉴操作系统**虚拟内存换页（Virtual Memory Paging / Page-Out & Page-In）**思想，解决与多模态大模型（如 Google Gemini / OpenAI）多轮交互时历史图像累积引发的 **Payload 爆炸**与 **TPU 显存/注意力算力墙（128 秒+ 严重超时）**。

### 痛点与根因

1. **图像 Payload 累积**: 多轮交互中读取多张高清插图（例如 34 张 JPEG）会导致请求包膨胀至 40MB+，Base64 数据几乎占满 99% 的请求体积。
2. **zstd 等压缩无效**: JPEG 本身已经过 Huffman 与离散余弦变换极限压缩，信息熵极高，通用压缩算法无法对其进行有效压缩。
3. **TPU KV-Cache 算力墙**: 几十张高清图切片后突破数十万视觉 Token，大模型后端（如 Google TPU 集群）在跨芯片分布式调度 40GB+ KV-Cache 时耗时超过 120 秒。
4. **历史模型回答完整**: 在前序轮次中，模型通常已经生成了详尽的文字分析与分镜描述，后续绝大多数问题完全依靠文本记忆即可解答。

### 架构设计：智能指针与自愈唤醒

- **热页与冷页分离 (Hot Pages vs Cold Pages)**:
  - 队列中最新的一张或数张图片（默认 `keepRecentImages: 1`）作为活跃工作集（Hot Page），完整保留 Base64 像素供当轮深度推理。
  - 更早的历史图片作为冷数据（Cold Page），在发给模型前进行非破坏性换出（Page-Out）。
- **智能指针 (Smart Pointer)**:
  - 自动通过 `toolCallId` 回溯定位 `read` 工具读取的原始物理文件路径（如 `d:/novel/分镜插图/shot_01.jpg`）。
  - 将庞大的 Base64 替换为百字节的轻量自愈占位符，清晰记录文件路径与文件名。
- **缺页自愈 (Page Fault & Page-In)**:
  - 占位符内包含明确的自愈指令：*“If you need to inspect raw pixels of this image again, please invoke the 'read' tool on this path.”*
  - 当第 N 轮用户需要模型重新核验像素微小细节时，模型可自主触发 `read` 工具重新将图片读回当前轮活跃上下文（Page-In）。
- **前缀缓存友好（Prefix-Cache-Friendly / 轮次边界不可变性）**:
  - 采用 **`strategy: "turn-boundary"`**（默认推荐）：当前活跃轮次（最后一条用户提问后读取的图片）保留原始 Base64 像素供模型当轮睁眼分析；
  - 历史已完成轮次的图片在跨入新轮次时**立即固化为静态智能指针并永久冻结**；
  - 彻底规避传统滑动窗口在第 50 轮突然加入新图时破坏第 1 轮前缀、导致全量 KV-Cache 毁灭性击穿的隐患。历史长前缀在数十轮文字交互中 100% 保持幂等命中。
- **零破坏性 (Non-destructive)**:
  - 仅在 `pi.on("context")` 阶段针对发往大模型的上下文进行替换；本地 session JSONL 文件中的原始执行记录毫发无损，随时可全量回溯。

### 占位符示例

```markdown
[System Note: Image "shot_01_14.jpg" has been paged out from context to save memory and inference time.
• Original File Path: "d:/novel/分镜插图/第0001章_重制版/shot_01_14.jpg"
• MIME Type: image/jpeg
• Paged-out Size: 1.25 MB (Base64)
• Self-Healing Guideline: The raw pixel data of this image is currently paged out from working memory. If you need to re-inspect or verify visual pixel details of this image that are not already documented in the conversation text above, invoke the 'read' tool on this path to page it back into context.]
```

### 命令与配置

提供交互式斜杠命令 `/image-pager`（别名 `/image-paging`）：

| 命令 | 说明 |
| --- | --- |
| `/image-pager [status]` | 查看当前换页状态、策略、已节省带宽与预估 Token 统计 |
| `/image-pager on` / `off` | 启用或禁用智能图片换页 |
| `/image-pager strategy <turn-boundary\|fifo>` | 切换换页策略（默认 `turn-boundary` 前缀缓存友好模式） |
| `/image-pager keep <n>` | 设置保留活跃图片数（默认 `1`） |
| `/image-pager lang en` / `zh` | 切换智能指针自愈提示词语言（支持英文与中文） |
| `/image-pager reload` | 重新从磁盘载入配置 |
| `/image-pager reset` | 重置统计计数器 |

全局配置文件路径：`~/.pi/agent/extensions/image-pager/config.json`（工作区亦支持 `.pi/image-pager.json` 覆盖）：

```json
{
  "enabled": true,
  "strategy": "turn-boundary",
  "keepRecentImages": 1,
  "models": ["*"],
  "excludeModels": [],
  "minBytesThreshold": 0,
  "noticeLanguage": "en",
  "notifyOnPageOut": false,
  "debug": false
}
```

Load directly:

```bash
pi --extension ./extensions/image-pager.ts
```

## Request Compress

`extensions/request-compress.ts` 为 Pi 调用大模型 API 的 POST 请求透明注入上行请求体压缩（Request Body Compression），大幅降低 Prompt / Context 上传带宽和传输延迟。

- **算法支持**: 默认使用 **`zstd`**（高性能且为官方 Codex 网关原生接受标准），同时支持 `gzip`、`deflate` 和 `br`。
- **开箱即用**: 基于 Node.js 内置 `node:zlib`，零第三方运行时依赖，零 C++ 原生编译。
- **智能策略**:
  - 自动识别当前生效的 `defaultProvider` 及其下的所有模型；
  - 支持通配符匹配（`yqdcc-*`, `gemini-*`）与黑白名单过滤；
  - 内置大小阈值（`minBytesThreshold`，默认 1KB），小请求自动忽略，避免小包负收益。
- **TUI 状态命令**: 提供 `/request-compress [status|on|off|reload]`，可随时查看实时压缩率、已节省带宽统计及动态热重载配置。

### 配置文件

全局配置文件路径：`~/.pi/agent/extensions/request-compress/config.json`（扩展首次启动自动生成默认配置）；亦支持当前工作区覆盖配置 `.pi/request-compress.json`。

```json
{
  "enabled": true,
  "algorithm": "zstd",
  "providers": ["default"],
  "models": ["*"],
  "excludeProviders": [],
  "excludeModels": [],
  "minBytesThreshold": 1024,
  "zstdLevel": 3,
  "gzipLevel": 6,
  "brotliQuality": 4,
  "targetHosts": [],
  "debug": false
}
```

## Ask User Question

`extensions/ask-user.ts` 实现了轻量、友好且功能完善的交互式问答工具 `ask_user_question`，完全替代死板的三方实现，解决遮挡上下文和固定选项限制：

- **原生交互区挂载（绝不遮挡底部信息）**：直接占用终端底部的交互区域（非浮层覆盖），将终端聊天历史自然推至上方紧贴问答框，彻底杜绝浮层盖住底部关键信息的问题。
- **灵活的选项数量 (1 ~ 12 项)**：彻底放开 4 个选项的死板限制，支持 1 项确认至 12 项复杂选择，内置平滑虚拟滚动视口（默认展示 4 项，高度控制在约 40% 紧凑区域，随光标上下滚动）。
- **多选支持 (`multiSelect`)**：当 Agent 提出非互斥问题时，支持空格键自由勾选/反选 `[x]` 或 `[ ]`，数字键快速勾选，回车提交已选项。
- **自定义回答**：每题自动追加 `Type something...` 行，支持按数字键、回车或空格直接拉起内嵌编辑器输入任意自定义回答或补充要求。
- **全方位通知提醒**：Agent 发起提问时，同时触发 OSC 9 终端系统弹窗通知（Windows Terminal / WezTerm / iTerm2 原生支持）、终端提示蜂鸣（`\x07`）以及 Pi 应用内状态栏通知，后台等待不漏看。
- **最小化与折叠**：支持 `Ctrl+]` 或 `Alt+H` 极速最小化为单行提示条，按任意键展开；`Esc` 可取消提问。
- **全环境降级兼容**：在 RPC 模式（VSCode 插件端 / Zed）下自动降级为顺序 Dialog 提问，保证无交互环境不中断。

### Todo Tree (层次化任务清单与弹窗交互)

`extensions/todo-tree.ts` 为复杂开发任务提供层次化任务拆解（Hierarchy / Parent-Child Subtasks）、主窗体极简状态条与全功能居中弹出窗口（Modal Overlay with Scrollbar）：

- **分层级任务模型与动态演进**：支持多层级树状结构（如 `#1` $\rightarrow$ `#1.1` $\rightarrow$ `#1.1.1`），支持任务随进度中途追加小项或放弃取消（`cancelled`），取消项自动从进度有效项剔除，绝不阻塞整体推进。
- **主窗体聚焦（仅展示进行中小项）**：输入栏上方仅展示总体进度、字符进度条（`[████░░░░░]`）以及当前所有正在执行的叶子小项（带父级面包屑，如 `[数据层] > 编写测试`）；多并行任务全行展开，不限死组件高度。
- **右侧固定交互按钮 `[📋 ]`**：主行右端常驻 `[📋 ]` 按钮，支持鼠标直接点击以及键盘快捷键（默认 `Ctrl+Shift+T`）呼出任务树弹窗。
- **全功能居中弹窗（内置字符滚动条）**：采用 `ctx.ui.custom({ overlay: true })` 居中悬浮绘制，清晰呈现树形分支图；支持键盘上下移动/翻页、`Space` 折叠展开父节点、鼠标滚轮平滑滚动、边框外部点击自动关闭。
- **零破坏 Prompt Cache 的批注体系**：
  - **本地便签 (Local Note)**：弹窗按 `n` 键就地添加备注，数据仅在扩展内部与分支快照保存，**0 Token 消耗，0 缓存破坏**；
  - **主动提醒 (Steer Hint)**：按需将提示作为标准 User 消息追加在**对话最末尾**，100% 保持此前所有对话的前缀缓存命中！
- **最小化主 Agent 上下文污染**：LLM 工具调用成功后仅返回单行操作摘要（绝不在 `content` dump 全量树）；全量数据写入 `details`，天然与仓库现有 `todo-loop.ts` 形成自动推进闭环。
- **与 `rolling-tools` 优雅共存**：采用单例状态驱动渲染（避免重复 `setWidget` 引发 Map 键序跳动），确保界面层次稳定位于 `rolling-tools` 滚动块的正上方。
- **快速开关（默认关闭）**：一般小任务无需开启，默认处于关闭状态（Disabled）。通过 `/todo on`、`/todo off`、`/todo toggle` 随时切换。关闭状态下自动从 Provider Payload 中剥离 `todo` 工具，主窗体完全隐蔽，0 提示词干扰。

```bash
# 常用命令与快捷键
/todo on          # 开启任务清单工具与主窗体 Widget
/todo off         # 关闭任务清单（向 LLM 隐身）
/todo toggle      # 快速翻转状态
/todo open        # 展开完整任务树大弹窗
/todo status      # 查看当前统计与开关状态
Ctrl+Shift+T      # 快速呼出/关闭任务树弹窗
```

## IDM Download (Skill)

`skills/idm-download` 提供将大文件、模型权重（`.safetensors`, `.pth` 等）和数据集自动化推送到 Windows 本地 **Internet Download Manager (IDM / `IDMan.exe`)** 进行多线程后台下载的能力：

- **零外部依赖**: 内置纯标准库 Python 脚本 `scripts/idm_push.py`，支持单任务直推、仅入队（`/a`）、批量文件/JSON 解析与启动队列（`/s`）。
- **可执行文件自动发现**: 自动扫描默认安装路径、`PATH`、Windows Registry 及环境变量 `IDM_PATH`，同时支持通过 `--idm-path` 显式指定。
- **ComfyUI 目录映射**: 内置 Diffusion Models, Checkpoints, Text Encoders, VAE, LoRA, ControlNet 等分类的推荐存放子目录。
- **镜像源解析指引**: 针对 ModelScope CDN、Hugging Face (含国内镜像) 及 Civitai 提供直接下载链接格式规范。

## Media Gen (Image & Video Generation)

`extensions/media-gen.ts` 为 LLM 提供轻量、高可用、开箱即用的多模态多媒体生成套件，包含两个核心工具：`generate_image` 与 `generate_video`：

### 核心亮点
- **极简参数，拒绝复杂配置**：面向 LLM 提供符合直觉的标准参数（`prompt`, `image`, `width`, `height`），去除了死板的 `aspectRatio` 枚举与多余的 `duration` 参数，由扩展内部自动推导最匹配的标准比例（`1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `21:9`）以及上游所需的分辨率。
- **前置网关无缝接入**：自动探测当前运行时 Provider 配置及环境变量（`CPA_BASE_URL` / `AI_API_KEY` 等），无需任何额外的配置繁琐项。
- **自动模型降级（Fallback）**：图片生成默认使用 `gpt-image-2.5-flare`，遇故障自动尝试 `gemini-3.1-flash-image` 兜底；熔断与限流由上游网关调度，本地保持极简与纯粹。
- **图视联动（Image-to-Video）**：`generate_image` 生成的图片路径可直接作为 `generate_video` 的首帧或参考输入（`image`），极大提升视频主体的一致性与稳定性。
- **标准驱动架构（Video Driver）**：视频工具内置统一驱动契约，原生支持扩展对接 ComfyUI（`COMFYUI_URL`）或标准视频代理网关（`VIDEO_API_BASE_URL`）。
- **本地落盘管理**：生成的图片与视频自动持久化落地至工作区 `.pi/images/` 与 `.pi/videos/`，并向 LLM 返回跨平台安全的 Markdown 预览与绝对路径。

### 工具清单
1. `generate_image`:
   - `prompt` (string, required): Detailed prompt describing the image to generate or edits to perform.
   - `image` (string, optional): Local file path or URL of an existing image to modify/edit (Image-to-Image / Edit).
   - `width` (number, optional, default: 1024): Desired width in pixels.
   - `height` (number, optional, default: 1024): Desired height in pixels.
2. `generate_video`:
   - `prompt` (string, required): Motion and scene prompt describing camera movements and dynamics.
   - `image` (string, optional): Reference image or first frame path/URL (Image-to-Video).
   - `width` (number, optional, default: 1280): Desired video width in pixels.
   - `height` (number, optional, default: 720): Desired video height in pixels.

## Pi package

```bash
# 从本地目录临时加载
pi --extension .

# 发布前检查 package 内容
npm pack --dry-run
```

本项目暂不声明具体 License；确定开源授权后，请补充 `LICENSE` 和 package metadata。
