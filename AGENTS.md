# AGENTS.md

## 仓库定位

`pi-extensions` 是一个面向 [Pi coding agent](https://pi.dev) 的资源仓库，统一维护可复用的 Extensions、Skills、Prompt Templates 和 Themes。

当前无法从本次运行环境直接读取 GitHub 远端的提交或文件树。公开页面、Raw、codeload 和 Git smart protocol 均未返回可用内容，但这也可能是仓库尚未创建、没有提交，或仓库为 private 且当前环境没有认证权限，不能据此判断远端为空。本仓库先按 Pi 官方 package 约定建立可扩展骨架；具体业务功能应在后续需求明确后加入，不要把推测性的功能当成既定设计。

## 目录约定

```text
.
├── extensions/       # TypeScript/JavaScript Pi extensions
├── skills/           # 按 Agent Skills 规范组织的 SKILL.md
├── prompts/          # Prompt Templates，使用 Markdown
├── themes/           # Pi theme JSON 文件
├── docs/             # 架构、开发和使用说明
├── scripts/          # 仓库校验脚本
├── package.json      # npm 与 Pi package manifest
├── tsconfig.json     # Extensions 的 TypeScript 检查配置
└── AGENTS.md         # 本文件，作为仓库级开发约定
```

## Pi 资源规则

### Extensions

- 每个独立功能使用一个清晰命名的 `.ts` 文件或子目录；目录形式的入口使用 `index.ts`。
- Extension 必须默认导出接收 `ExtensionAPI` 的 factory function。
- 只在 `session_start` 或实际需要时启动 watcher、timer、socket、child process 等长生命周期资源，并在 `session_shutdown` 中释放。
- 注册 custom tool 时为参数提供完整 schema；tool 的可持久状态放在结果的 `details` 中，确保 session fork 后可以恢复。
- Extension 运行时拥有完整系统权限，涉及写文件、执行命令、网络请求或凭据时，必须在文档中说明风险。

### Skills

- 每个 skill 使用 `skills/<skill-name>/SKILL.md`。
- `SKILL.md` 必须包含 YAML frontmatter：`name` 与 `description`。
- `name` 仅使用小写字母、数字和单个连字符，长度不超过 64 个字符。
- 详细参考资料、脚本和资源放在该 skill 的 `references/`、`scripts/`、`assets/` 子目录，主文件保持可渐进读取。

### Prompts 和 Themes

- Prompt Template 使用 Markdown，文件名使用小写 kebab-case。
- Theme 使用可解析的 JSON；不要把注释或 JSON5 写入 theme 文件。
- 资源名称应能从文件名直接看出用途，避免 `new.ts`、`test2.md` 之类的临时命名。

## 依赖与兼容性

- Pi core packages 只放在 `peerDependencies`，开发时可在 `devDependencies` 中提供同版本类型和检查依赖，不要将它们打包进发布物。
- Extension 的实际运行时依赖放在 `dependencies`，不能只放在 `devDependencies`。Pi 安装 package 时默认使用 production install。
- 优先使用 Node.js built-ins 和仓库已有 helper，避免为简单逻辑增加依赖。
- 代码默认兼容 Windows、Linux 和 macOS；路径使用 `node:path`，不要硬编码分隔符或 shell 命令。
- 不提交 API key、OAuth token、`.env`、session 文件、`node_modules`、构建输出和本机 Pi 配置。

## 开发流程

1. 先阅读受影响目录和相关文档，确认改动属于哪一类 Pi resource。
2. 新增资源时同时补充必要的 README 或 `docs/` 说明，写清加载方式、参数和安全影响。
3. 运行 `npm run check` 做 TypeScript 检查。
4. 运行 `npm run validate` 检查 `package.json` 的 Pi manifest 和资源目录。
5. 行为有变化时增加 focused test 或可重复的手工验证步骤。
6. 提交前检查 `git diff`，不要把个人设置、依赖缓存或构建产物带入提交。

## 常用命令

```bash
npm install
npm run check
npm run validate
npm test

# 临时加载单个 extension
pi --extension ./extensions/<name>.ts

# 在当前项目临时试用这个 package
pi --extension .
```

## 编辑边界

- 保持改动局部，避免无关格式化和大范围重构。
- 不修改用户未请求的现有行为；不使用 destructive git 命令覆盖未提交改动。
- 新增嵌套目录级 `AGENTS.md` 时，该文件只补充或收窄本文件规则，不应悄悄放宽安全要求。
- 变更 package manifest、资源发现路径或生命周期行为时，必须更新 README/文档并运行对应验证。
