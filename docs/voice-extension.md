# Voice Extension：语音输入与工具适配

`extensions/voice.ts` 提供 LLM 单次收音工具、按需缓存的音色目录，以及用户显式开启的持续语音输入。扩展仅对接网关，不实现录音、VAD、ASR 或语音合成。

## 当前网关兼容性（重要）

已核对运行于 `http://127.0.0.1:5234` 的 TtsGateway OpenAPI 和对应实现：

| 能力 | 当前支持情况 |
| --- | --- |
| `voice_listen` | 支持 `POST /api/v1/input/record-and-transcribe`，包含收音和转写的总超时 |
| Live 输入 | 支持连续调用上述单次接口；每段完成后才开始下一段，不是无缝音频流 |
| 音色目录 | 支持 `GET /api/voices`，本地持久化缓存 |
| `voice_speak` | **当前明确返回 `incompatible_gateway`，不发送合成或播放请求** |

当前网关的 `wait: true` 只确认 PCM 已写入播放缓冲，不能确认扬声器实际播放完毕；`playback/control` 只支持全局控制，`task_id` 不起隔离作用。扩展不会以固定延时冒充物理完成，也不会调用全局 stop 或 preempt 干扰其他终端。仅修改扩展无法安全补齐这些后端契约。

恢复发音需要后端提供**明确的物理播放完成确认、按任务取消及设备冲突仲裁**，之后才能接入适配器。不能仅添加 `engine: "cosyvoice"` 或传入一个后端忽略的 `task_id` 就认定兼容。当前不存在绕过此检查的配置。

内部 `VoiceGateway.speak` 接口约定：只有扬声器物理播完才 resolve，取消信号只停止自己所属的工作；运行时会在其返回后持有互斥再等待 150ms 残响保护。这个接口用于隔离测试和后续协议适配，**不代表当前 HTTP 网关已具备这些能力**。

## 加载与开启

```bash
# 临时加载
pi --extension ./extensions/voice.ts
```

安装整个 Pi package 时由 manifest 的 `./extensions` 自动发现。新会话默认关闭，不连接网关、不占用音频设备；关闭时从模型可用工具列表移除语音工具，执行边界也会拒绝调用。

```text
/voice on
/voice live on
```

启用即允许 LLM 调用语音工具，没有额外授权层。Live 始终单独开启，默认关闭，LLM 不能通过工具打开它。重复 `/voice on` 不重置任务或 Live；仅从关闭进入开启时尝试初始化尚未获取的目录。

## 命令与停止语义

| 命令 | 行为 |
| --- | --- |
| `/voice on` | 启用当前会话的工具；不自动打开 Live |
| `/voice off` | 同步禁用、关闭 Live、作废并取消现有工作，拒绝后续工具调用 |
| `/voice stop` / `Alt+X` | 同步作废并取消现有工作、关闭 Live，**保留原 enabled 状态**；若原来开启，后续新调用仍允许 |
| `/voice live [on\|off]` / `F2` | 开关背景输入；关闭不取消正在执行的 `voice_listen` |
| `/voice mode editor\|submit` | 持久化输入投递偏好，只影响后续录音请求 |
| `/voice set-voice <id>` | 持久化默认音色，不自动发音 |
| `/voice voices` | 显示缓存目录，无缓存时尝试获取 |
| `/voice status` | 显示开关、配置及发音兼容性限制；不主动探测设备 |

stop/off 不等待网络清理，使用 AbortSignal 中止自身 HTTP 请求和本地等待，清除计时器并作废迟到结果。不发送全局停播。取消请求何时在物理设备生效仍取决于后端响应断连的速度，扩展不能代替后端保证跨客户端的设备独占。

会话切换、fork、重载及退出均取消旧任务并关闭入口。新会话重新读取 `defaultEnabled`，Live 不继承。

## 工具契约

### `voice_listen`

- 参数：`prompt?`（仅终端文字提示，不朗读）、`timeout_sec?`（3–60 秒，默认 15）。
- 同一会话最多一个主动音频工具；并发 speak/listen 等冲突立即返回 `reason: "busy"`，不排队猜测调用顺序。
- 超时覆盖完整收音和转写，取消返回结构化 `status: "cancelled", text: ""`，不泄露内部 Promise 拒绝。
- 当前接口没有说话起始／转写阶段事件，超时使用 `reason: "deadline_exceeded"`；**不能断言用户没有说话**。
- 同一请求只有一个归属。Live → listen 时立即取消并废弃整段背景请求，发起新的单次收音；迟到结果不会转给新 listen 或 Live。结束时只有当前任务身份、代次、enabled 和 live 都有效才恢复背景输入。
- `/voice live off` 只取消背景请求，不影响这一次主动答复；该答复结束后不恢复 Live。全部停止用 `/voice stop`。

**输入限制**：这是请求边界交接，不是开口时绑定；交接可能丢弃用户正在说的半句话。Live 请求包含 ASR 处理期间，不会同时开始下一次背景录音，因此存在收音间隙。真正的无缝持续输入和开口归属需要后端会话级语句流协议，当前不作此承诺。

### `voice_speak`

当前 HTTP 适配器拒绝执行并返回：

```json
{
  "status": "error",
  "reason": "incompatible_gateway",
  "message": "当前 TtsGateway 不提供任务级取消和扬声器物理播放完成确认；已拒绝发音，不发送全局停播。需要后端协议升级。"
}
```

不得自动重试。未来支持时，口头提问应在同一 Agent 执行过程中先等待 speak **成功**，再顺序调用 listen，不得并行。参数保留 `text`、`voice_id?`、`instruct?`、`speed?`，不会静默替换无效音色或绕到不同合成引擎。

### `voice_list_voices`

- `refresh=false`：有缓存（包括 `[]`）则不联网，无缓存则获取；启动初始化与同时到来的普通查询复用同一获取。
- `refresh=true`：显式更新，不要每次发音前查询。
- 更新失败：有旧缓存则保留并附 warning；从未成功时明确报告无可用缓存。
- HTTP 错误、无效 JSON、非数组或无效条目均视为失败，不把失败响应缓存成合法空目录。
- 成功但保存失败时返回获取到的目录并附持久化失败警告。

## 输入投递

| 模式 | Agent 空闲 | Agent 忙碌 |
| --- | --- | --- |
| `editor`（默认） | 追加至当前草稿末尾，等待 Enter | 同样追加，等待 Enter |
| `submit` | `sendUserMessage` | `deliverAs: "followUp"` 排队 |

只处理最终转写；不覆盖草稿、不投递中间结果。非交互终端不能使用 editor，不会静默降级成自动提交。网关失败或背景请求超时会关闭 Live 并提示，避免快速重试循环；用户可手工重新开启。

## 配置与并发写入

`~/.pi/agent/voice.json`：

```json
{
  "gatewayUrl": "http://127.0.0.1:5234",
  "defaultEnabled": false,
  "defaultVoiceId": "default",
  "speed": 1,
  "deliveryMode": "editor",
  "voicesCacheByGateway": {}
}
```

- 偏好共享，运行时开关只属于当前终端。每个任务固定启动时的网关、音色、语速，每个 Live 请求固定投递模式。
- 缓存按规范化网关 URL 分隔：缺失／`null` 为未获取，`[]` 为合法空目录。
- 跨进程独占创建 `voice.json.lock`，**持锁后重新读最新配置、合并本次修改、唯一临时文件写入并原子替换**。
- 锁等待为异步，不阻塞主线程；默认 2 秒超时，明确报错且不写入，绝不降级成无锁写入。
- 不按时间猜测并抢占遗留锁，避免误删活动进程的锁。异常退出留下锁时，请先确认没有写入进程，再手工移除 `~/.pi/agent/voice.json.lock`。
- 非法配置不静默重置，更不会在保存缓存时覆盖原文件。没有 watcher 或后台轮询配置。

## 安全影响与验证

扩展运行于 Pi 进程权限下，会读写上述全局偏好和音色缓存，并将开启后的录音请求发送至配置的网关；录音设备在**网关所在机器**。网关使用哪个 ASR 服务、是否向云端发送音频由后端配置决定。远程 HTTP 地址可能明文传输转写内容，请仅使用可信网关，跨网络应使用 HTTPS。不要提交个人配置或音频。

```bash
node ./scripts/test-voice-runner.mjs
npm run check
npm run validate
npm test
```

回归测试采用隔离配置、可控网关 mock 及临时目录，覆盖取消、旧回调、交接、超时、投递、缓存和跨进程写锁；不访问个人配置、真实网络或音频设备。尚未进行真实麦克风人工验收；发音在当前协议下明确不可用。
