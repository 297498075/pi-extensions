# Voice Extension：语音输入与工具适配

`extensions/voice.ts` 提供 LLM 单次收音工具、实时查询与短期缓存的可搜索音色目录，以及用户显式开启的持续语音输入。扩展仅对接网关，不实现录音、VAD、ASR 或语音合成。

## 当前网关兼容性（重要）

已核对运行于 `http://127.0.0.1:5234` 的 TtsGateway OpenAPI 和对应实现：

| 能力 | 当前支持情况 |
| --- | --- |
| `voice_listen` | 支持 `POST /api/v1/input/record-and-transcribe`，包含收音和转写的总超时 |
| Live 输入 | 支持连续调用上述单次接口；每段完成后才开始下一段，不是无缝音频流 |
| 音色目录 | `GET /api/voices`，保留 engine/ready/capabilities；短期快照、搜索与分页 |
| `voice_speak` | `POST /api/tts/synthesize`，按目录显式选择 cosyvoice / voice-library；请求扬声器播放，取消仍为全局 stop |

**已知安全风险，按用户决定本次暂不修复**：当前网关的 `wait: true` 只确认 PCM 已写入播放缓冲，不能确认扬声器实际播放完毕；`playback/control` 只支持全局控制，`task_id` 不起隔离作用。当前 HTTP 适配器仍使用 `preempt` 并在取消时调用全局 stop，可能打断其他终端。详见 [VOICE-001](known-issues.md)。

安全恢复/改造发音需要后端提供**明确的物理播放完成确认、按任务取消及设备冲突仲裁**。仅添加 `engine: "cosyvoice"` 或传入一个后端忽略的 `task_id` 并不能提供隔离。

内部 `VoiceGateway.speak` 的理想契约是只有物理播完才 resolve、取消只停止自己的任务，但当前 HTTP 实现不满足它。运行时返回后额外等待 150ms 不能补齐该契约，也不能保证随后 listen/Live 不录到残留播音。多客户端共享网关时应避免调用 `voice_speak`。

## 加载与开启

```bash
# 临时加载
pi --extension ./extensions/voice.ts
```

安装整个 Pi package 时由 manifest 的 `./extensions` 自动发现。出厂默认新会话关闭，启动本身不连接网关、不占用音频设备；手工 `/voice voice`、`/voice voices` 及音色补全允许在关闭时只读查询目录，不会开启发音或麦克风；可用 `/voice default on|off` 修改新会话偏好。关闭时从模型可用工具列表移除语音工具，执行边界也会拒绝调用。

### 找不到 `/voice` 或无法启用

`/voice` 命令在扩展加载时就注册，**不依赖语音开关或网关在线**。命令不存在时，先用 `pi config` 检查 package 的 voice 资源是否被禁用，并查看扩展加载错误；配置修改后执行 `/reload` 或重启 Pi。

特别注意 `~/.pi/agent/settings.json` 中 package 的 `extensions` 过滤列表：`-extensions/voice.ts` 是精确禁用，优先级高于 `+extensions/voice.ts`，也高于 Windows 写法 `+extensions\\voice.ts`；末尾追加启用项并不能抵消禁用项。先备份设置，移除冲突禁用项，只保留一致的启用项，例如 `+extensions/voice.ts`。不要覆盖其他扩展的过滤配置。

加载成功后，`/voice`（不带参数）打开状态窗；`/voice on` 仅启用当前会话，不修改新会话默认开关。若命令可用而音频请求失败，再检查网关服务和地址，二者与扩展加载是不同层次的问题。

```text
/voice on
/voice live on
```

启用即允许 LLM 调用语音工具，并允许已加载的 ask-user 在问卷展示时自动语音提醒，没有额外授权层。Live 始终单独开启，默认关闭，LLM 不能通过工具打开它。重复 `/voice on` 不重置任务或 Live；仅从关闭进入开启时尝试初始化尚未获取的目录。

## 命令与停止语义

| 命令 | 行为 |
| --- | --- |
| `/voice on` | 启用当前会话的工具；不自动打开 Live |
| `/voice off` | 同步禁用、关闭 Live、作废并取消现有工作，拒绝后续工具调用 |
| `/voice stop` / `Alt+X` | 同步作废并取消现有工作、关闭 Live，**保留原 enabled 状态**；若原来开启，后续新调用仍允许 |
| `/voice live [on\|off]` / `F2` | 开关背景输入；关闭不取消正在执行的 `voice_listen` |
| `/voice mode editor\|submit` | 持久化输入投递偏好，只影响后续录音请求 |
| `/voice voice [ID或关键词]` | 独立音色入口：无参数打开实时目录搜索选择；明确 ID/唯一名称直接在线校验保存，不开启语音或试听 |
| `/voice set-voice [ID或关键词]` | 兼容上述音色选择入口；不再把未知 ID 或模糊匹配第一项直接保存 |
| `/voice voices [关键词]` | 实时查询目录，最多显示20项并标注匹配/总数；离线缓存明确标为未确认 |
| `/voice` / `/voice status` | 模态窗显示当前开关、新会话默认、全部配置及发音限制；不主动探测连接或设备 |
| `/voice help` | 模态窗显示完整命令说明 |
| `/voice speed <0.5–2>` | 持久化默认语速，仅对后续发音生效，不修改进行中的请求 |
| `/voice gateway <HTTP(S) URL>` | 校验并保存网关地址，取消旧语音任务、关闭 Live，总开关不变；开启时按新网关初始化音色目录 |
| `/voice default on\|off` | 持久化新会话默认开关，不改变当前会话开关和 Live；默认开启也不会自动录音 |

`/voice speed`、`/voice gateway`、`/voice default` 不带值时也打开状态窗；`/voice help` 和 `/voice voices` 使用模态窗而非长通知，避免被通知静音规则吞掉。非交互模式回退为普通输出，RPC 回退为通知。状态中“协议支持”仅说明适配器能力，不代表网关在线。

`/voice status` 使用共享的自适应模态窗：长 URL、音色 ID 和模式说明完整换行，窄屏/短屏可用 ↑/↓、PgUp/PgDn 或鼠标滚轮翻阅，Enter/Esc 或点击关闭；状态查询不主动访问网关。

音色选择窗使用原生输入框及最多10条可见列表，支持 ↑/↓、PgUp/PgDn、Enter 确认及 Esc 取消；名称、稳定 ID、引擎和描述可按空格分词搜索。打开时取实时目录，逐键过滤只读内存索引，不逐键发 HTTP 或读取大配置文件；交互确认时再次在线校验 ID、引擎与就绪状态。重名/模糊匹配不能静默选择第一项；无交互界面时须提供唯一 ID。取消、网关变更、音色撤下或未就绪均不更改默认音色。保存新默认不会取消当前在途句子，也不改变 voice 开关、Live 或新会话默认开关。

参数修改保存到 `voice.json`，会跨会话持久化；网关地址按 HTTP(S) URL 校验（不允许查询参数或 fragment），音色缓存按规范化后的网关地址分别保留。配置保存失败时不停止当前任务，不将失败的设置应用到内存。网关切换会将后续音频及转写请求发往新地址，应只设置可信网关，不要在 URL 中放入凭据；它也会触发下述取消/全局停播风险。

stop/off 不等待网络清理，使用 AbortSignal 中止 HTTP 请求和本地等待、清除 UI 定时器并作废迟到结果。**若当前为 speak，适配器仍发送全局停播请求**；旧请求迟到可能影响新任务/其他客户端。扩展的本地互斥不能代替网关端设备隔离。

会话切换、fork、重载及退出均取消旧任务并关闭入口。新会话重新读取 `defaultEnabled`，Live 不继承。

## 工具契约

真正失败的结果（`status: "error"` 或目录 `success: false`）同时设置 `isError: true`，让 Pi 与程序调用方识别失败。用户取消、无有效收音的 timeout 与失败分别保留结构化状态；刷新失败但旧缓存仍可用时返回成功并附 warning，不误标为失败。这些结果标记不改变 VOICE-001 的网关控制行为。

### `voice_listen`

- 仅在用户明确要求语音输入或听取回答时调用，默认情况下不要主动触发。
- 参数：`prompt?`（仅终端文字提示，不朗读）、`timeout_sec?`（3–60 秒，默认 15）。
- 同一会话最多一个主动音频工具；并发 speak/listen 等冲突立即返回 `reason: "busy"`，不排队猜测调用顺序。
- 超时覆盖完整收音和转写，取消返回结构化 `status: "cancelled", text: ""`，不泄露内部 Promise 拒绝。
- 当前接口没有说话起始／转写阶段事件，超时使用 `reason: "deadline_exceeded"`；**不能断言用户没有说话**。
- 同一请求只有一个归属。Live → listen 时立即取消并废弃整段背景请求，发起新的单次收音；迟到结果不会转给新 listen 或 Live。结束时只有当前任务身份、代次、enabled 和 live 都有效才恢复背景输入。
- `/voice live off` 只取消背景请求，不影响这一次主动答复；该答复结束后不恢复 Live。全部停止用 `/voice stop`。

**输入限制**：这是请求边界交接，不是开口时绑定；交接可能丢弃用户正在说的半句话。Live 请求包含 ASR 处理期间，不会同时开始下一次背景录音，因此存在收音间隙。真正的无缝持续输入和开口归属需要后端会话级语句流协议，当前不作此承诺。

### `voice_speak`

- 对接网关合成与播音接口，支持参数：`text`、`voice_id?`、`instruct?`、`speed?`。`voice_id` 只覆盖本次调用，不修改保存的默认声线；先用 `voice_list_voices` 搜索取得稳定 ID。
- 发音前按网关目录解析 ID 对应引擎，支持 `cosyvoice` 和原配方 `voice-library`，未知/未就绪/不支持引擎明确失败，不退回另一声线。原配方每次最多80字，要求 `speed=1` 且不支持 `instruct`；非默认控制会拒绝，而不是忽略或改走 IndexTTS。
- 此入口继续使用默认整句合成并请求扬声器播放，不自动启用 TTS Studio 的实验原生 PCM 流式或编译；返回成功仅代表网关已接收音频，不表示确认物理播放完成。
- 取消时通过 `/api/tts/playback/control` 请求后端立即停播。
- 当语音启用时，扩展会向系统提示词（`<rules>`）注入 guidelines，引导 LLM 在提问、确认决策或任务结束时主动进行精炼口语播报。
- 朗读文本必须口语化，严禁直接朗读代码、路径或表格。若用户明确要求语音输入答复，必须等发音完毕后方可调用 `voice_listen`。

### Ask User 自动语音提醒

同时加载 `extensions/ask-user.ts` 时，`/voice on` 也启用问卷提醒：`ask_user_question` 的可选 `voice_prompt` 由 LLM 自行决定是呼叫用户、直接提问还是概括选择；未提供则固定说“有个问题需要你确认，请看一下终端。”无需单独调用 `voice_speak`，避免重复播音。每份问卷仅在展示时提醒一次，查询/等待不重复触发。

通过进程内 `ask-user:voice-prompt` 事件复用 `VoiceRuntime.speak`，使用当前默认音色、语速、超时与取消逻辑。提醒在后台运行，不阻塞窗口和答案；答题完成/取消、会话重载或分支切换会取消仍在执行的提醒，stop/off 也照常生效。显式音频任务忙时跳过、网关失败不重试，不影响正常提问。提醒之间串行清理，避免前一份问卷取消时的本地收尾阻挡后一份提醒。

仅已有 Live 会按现有 speak 语义暂停和恢复；不会因提问自动打开麦克风，也不会直接提交语音答案。单独加载 ask-user、voice 关闭或无 UI 时无语音副作用。文案会发送至配置网关且能被周围人听到；该自动路径同样继承 VOICE-001 的全局抢占/停播与播放完成限制。参数示例与手工验证见 [Ask User 使用说明](ask-user.md#与-voice-联动语音呼叫或直接提问)。

### `voice_list_voices`

- 参数 `query?` 搜索名称/ID/引擎/描述，`offset?` 为零起始偏移，`limit?` 默认20、上限50；不会一次向模型灌入180项，也不把目录展开为工具 schema 枚举。
- `refresh=false`（默认）：首次实时 GET，此后最多复用5秒内存快照；旧磁盘缓存不当成无限期有效。`refresh=true` 强制更新；同网关并发请求（包括强制刷新）合并为一次，查询总时限3秒。
- 返回 `voices`、`total`、`matched`、`offset`、`limit`、`has_more`、`source`（live/memory/cache）、`stale` 及在线快照的 `checked_at`。匹配总数不等于已就绪/已听审总数。
- 更新失败：仅能展示历史缓存时返回 `source=cache, stale=true` 并附 warning，不能凭离线缓存保存选择；从未成功时明确报告无可用缓存。
- HTTP 错误、无效 JSON、非数组、重复 ID 或无效条目均视为失败，不把失败响应缓存成合法空目录。音色目录中的终端控制字符不会直接作为 UI 标签执行。
- 成功但保存失败时返回获取到的目录并附持久化失败警告；内容未变不重复写配置。单个查询取消不取消其他共享查询，stop/切会话会作废本地等待和迟到写入。

```json
{"query":"C11-V32","limit":10,"refresh":true}
```

拿到稳定 ID 后，可单次调用 `voice_speak`：`{"text":"这一步已经完成。","voice_id":"C11-V32"}`。工具需要 `/voice on`；只选择默认音色无需开启。大目录下一页使用上页 `offset + limit`，直到 `has_more=false`。

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
node ./scripts/test-ask-user-voice.mjs
npm run check
npm run validate
npm test
```

回归测试采用隔离配置、可控网关 mock 及临时目录，覆盖命令注册和补全、参数校验/持久化、新会话默认语义、网关切换取消和缓存隔离、模态窗查询、取消、旧回调、交接、超时、投递、缓存、严格播音响应校验和跨进程写锁；另覆盖原配方引擎路由、未知/未就绪/不支持控制拒绝、选择取消/撤下重校验、在途句子保持、中文输入焦点及窄屏显示、万项目录分页与200次补全仅一次获取；不访问真实网络或音频设备。尚未进行真实麦克风/扬声器人工验收；测试通过不代表 VOICE-001 已解决。
