# 贡献指南

## 提交前

1. 阅读根目录 [`AGENTS.md`](AGENTS.md)，确认改动符合 Pi resource 的约定。
2. 为新增的 Extension、Skill、Prompt 或 Theme 补充使用说明和安全影响说明。
3. 运行：

```bash
npm install
npm test
npm pack --dry-run
```

4. 检查 `git diff` 和 `git status`，确认没有秘密、session、`node_modules` 或构建产物。

## 代码约定

- Extension 使用 TypeScript，默认导出 `ExtensionAPI` factory。
- 资源名称使用小写 kebab-case。
- 保持跨平台；不要依赖仅 Windows 或仅 Unix 的 shell 语法。
- Pi core packages 放在 `peerDependencies`；实际运行时依赖放在 `dependencies`。
- 生命周期资源必须可关闭，尤其是 watcher、timer、socket 和 child process。

## Pull Request

PR 描述应包含：

- 改动的资源类型和路径；
- 用户如何加载或验证；
- 是否增加系统权限、文件访问、命令执行或网络访问；
- 已运行的检查命令和结果。
