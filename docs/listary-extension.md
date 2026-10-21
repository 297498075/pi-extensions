# Listary 本机文件搜索

`extensions/listary.ts` 为 Pi agent 注册一个 `listary_search` 工具，通过 Listary Local HTTP API 查找本机文件和目录。它只查找位置，不搜索文件内容，也不会读取、修改、移动或执行搜索结果。

## 前提与加载

1. 在运行 Pi 的 Windows 主机上启动支持 Local HTTP API 的 Listary，并在 Listary 中启用该 API（默认关闭）。
2. 确认 Listary 在 `http://127.0.0.1:38431` 提供接口。
3. 临时加载扩展：

   ```bash
   pi --extension ./extensions/listary.ts
   ```

也可以加载整个仓库 package：

```bash
pi --extension .
```

已经从此目录加载 package 的 Pi 会话可用 `/reload` 发现新扩展。扩展没有 `/listary` 命令，不需要额外 Skill、MCP server、API key 或运行时依赖。

扩展不会启动 Listary、开启 API、执行启动探测或常驻轮询。非 Windows 环境没有可访问的 Listary 服务时，工具会报告连接失败，不会自动降级成全盘扫描。WSL、容器、远程 Pi 等环境的 loopback 不一定与 Windows Listary 共用，本实现不开放 LAN 或自定义 URL。

## Agent 调用

```json
{
  "query": "invoice",
  "limit": 10,
  "offset": 0,
  "search_in": ["D:\\Work"],
  "types": ["file"],
  "extensions": ["pdf", ".docx"]
}
```

| 参数 | 说明 |
| --- | --- |
| `query` | 必填，非空白字符串；由 Listary 解释其搜索语义 |
| `limit` | 每页条数，整数 `1–100`，默认 `10` |
| `offset` | 从零开始的结果偏移，非负安全整数，默认 `0` |
| `search_in` | 可选的绝对目录列表；Windows 示例为 `D:\Work` 或 UNC 路径 `\\server\share\docs`；不接受 `C:relative`、`\root-relative` 或普通相对路径 |
| `types` | 可选，元素为 `file` 或 `folder` |
| `extensions` | 可选，扩展名可带点或不带点，如 `.pdf`、`pdf` |

工具描述指导 agent 区分用途：

- 查找本机文件/目录位置，尤其位置未知或在仓库之外：`listary_search`。
- 搜索仓库源代码内容：`rg`。
- 查看已选中文件的内容：现有 `read` 工具。

例如，直接对 agent 说：“在 D 盘工作目录里找一下 invoice 的 PDF 文件”，或“找一下本机的某个模型文件放在哪里”。模型可以使用该工具，但是否调用仍由 agent 判断。

## 结果与分页

工具文本包含总数、当前偏移、结果路径、类型、可用的字节大小，以及下一页偏移。路径使用 JSON 引号和转义，避免文件名中的换行或终端控制字符直接生效。JSON 展示中的双反斜杠是转义；原始路径保存在结构化结果中。

`details` 保留 API 的 `query`、`total`、`offset`、`limit`、`count`、`results`（含可用的 `size_bytes`、`modified_at`、`score`），并增加：

- `displayed_count`：实际展示给模型的结果条数。
- `next_offset`：继续查询的偏移；无需继续或当前页为空时为 `null`。

模型可见文本限制为 **32 KiB UTF-8**。长查询只在标题中缩略，结构化结果保留完整查询。若文本容量不足以展示整页，下一次偏移按**已展示**条数计算，保持 query 和 filters 不变即可，不会跳过未展示项。单条路径无法在预算内展示时报告 `RESULT_TOO_LARGE`，应缩小搜索范围。

没有匹配项属于成功结果；偏移超出结果范围也不会被误报为服务故障。

## 传输、失败与资源管理

- 固定使用 `POST http://127.0.0.1:38431/api/v1/search`，模型不能设置 URL、Host 或请求头。
- 使用 Node 内置 `http.request`，自动生成一个正确的 `Host`，显式设置 `Content-Type: application/json`、UTF-8 字节数的 `Content-Length` 和 `Connection: close`，不发送 chunked 请求、不复用连接、不跟随重定向。
- 总请求期限为 **10 秒**，包含连接、等待和接收响应；持续零星返回数据不会延长期限。
- 支持 agent 取消。成功、错误、超时和取消都会清理期限定时器和取消监听器；失败或取消时销毁连接。
- 请求体上限 **256 KiB**；响应体上限 **2 MiB**，超出时终止请求。响应不是合法 JSON 或核心结果结构不匹配时报告 `INVALID_RESPONSE`。
- API 返回的失败与 HTTP 非 2xx 均作为失败抛出，由 Pi 标记为工具错误，而不是空搜索结果。错误文本有长度上限。
- `CONNECTION_ERROR`：检查 Listary 是否运行、API 是否启用及端口是否正确。
- `SEARCH_UNAVAILABLE`：等待 Listary 索引/搜索就绪。
- `TOO_MANY_REQUESTS`：稍后重试或减少并行搜索；Listary 最多执行 8 个并发请求。
- 不自动重试，不自动改用其他搜索后端，不修改个人配置。

## 安全影响

Extension 本身以 Pi 进程的系统权限运行；请只加载可信代码。本扩展的实现只向固定 loopback 接口发送搜索请求，无写文件、shell 执行、进程启动或文件打开行为。

**搜索查询、文件名、目录路径和元数据会进入 agent 上下文，并可能发送给当前模型提供方、保存在 Pi 会话记录中。** 搜索私密目录前应考虑这些数据的敏感性。`search_in` 是搜索过滤条件，不是权限沙箱。

文件名和路径属于不可信数据，不能将其当成指令或自动执行。后续读取、移动或执行需要另外调用相应工具。

Listary API 不提供身份认证；loopback 和 Host 校验不等同于用户授权，也不能阻止其他有访问能力的本机进程。扩展不添加代理服务、不开放 LAN 监听。

## 验证

```bash
npm run check
npm run validate
node scripts/test-listary.mjs
npm test
```

专项测试使用随机端口的本地 HTTP fixture，并在测试专用 transport 中验证固定生产目标后转接到 fixture。不访问真实 Listary、不查询本机文件、不读取个人配置。覆盖 schema/执行校验、UTF-8 Content-Length、单一 Host、连接关闭、过滤器、分页、API/HTTP 错误、无重试/重定向、异常响应、大小限制、取消与超时清理。专项测试已纳入 `npm test`。

手工验证：启用真实 Listary API 后加载扩展，让 agent 搜索一个已知文件名，再用 `limit: 1` 和不同 `offset` 检查分页；使用 `search_in`、`types`、`extensions` 检查过滤；关闭 API 后再次查询，确认返回明确错误而不是“没有结果”。真实索引的匹配和排序行为以 Listary 为准，fixture 测试不替代此项验证。
