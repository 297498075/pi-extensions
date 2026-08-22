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

## Pi package

```bash
# 从本地目录临时加载
pi --extension .

# 发布前检查 package 内容
npm pack --dry-run
```

本项目暂不声明具体 License；确定开源授权后，请补充 `LICENSE` 和 package metadata。
