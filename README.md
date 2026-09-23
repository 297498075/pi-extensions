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
  - Hotkeys: Press `Ctrl+O` in interactive mode to expand the entire transcript and inspect raw tool executions.

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
  ],
  "statusEnhancements": [
    {
      "keyPattern": "sol-pi*",
      "durationMs": 30000,
      "showRelativeTime": true,
      "colorize": true
    }
  ]
}
```

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

## IDM Download (Skill)

`skills/idm-download` 提供将大文件、模型权重（`.safetensors`, `.pth` 等）和数据集自动化推送到 Windows 本地 **Internet Download Manager (IDM / `IDMan.exe`)** 进行多线程后台下载的能力：

- **零外部依赖**: 内置纯标准库 Python 脚本 `scripts/idm_push.py`，支持单任务直推、仅入队（`/a`）、批量文件/JSON 解析与启动队列（`/s`）。
- **可执行文件自动发现**: 自动扫描默认安装路径、`PATH`、Windows Registry 及环境变量 `IDM_PATH`，同时支持通过 `--idm-path` 显式指定。
- **ComfyUI 目录映射**: 内置 Diffusion Models, Checkpoints, Text Encoders, VAE, LoRA, ControlNet 等分类的推荐存放子目录。
- **镜像源解析指引**: 针对 ModelScope CDN、Hugging Face (含国内镜像) 及 Civitai 提供直接下载链接格式规范。

## Pi package

```bash
# 从本地目录临时加载
pi --extension .

# 发布前检查 package 内容
npm pack --dry-run
```

本项目暂不声明具体 License；确定开源授权后，请补充 `LICENSE` 和 package metadata。
