# Known issues / 已知问题

## VOICE-001：发音的跨客户端隔离与物理完成确认

**状态：已确认，按用户决定本次暂不修复。**

受影响代码：`extensions/voice.ts` 的 `TtsGatewayAdapter.speak()`、`VoiceRuntime.speak()`。

当前行为仍为：

- `POST /api/tts/synthesize` 使用 `concurrency: "preempt"`、`output_mode: "speaker_playback"`、`wait: true`。
- 取消时向 `/api/tts/playback/control` 发送 `{ "action": "stop" }`，没有任务或客户端隔离。
- 网关的 `wait: true` 只表示 PCM 已写入缓冲，不表示扬声器物理播放完成；运行时额外等待 150ms 后恢复背景收音。

### 影响

- 新发音可能抢占其他终端/客户端；取消旧发音的停播请求迟到时，可能停止其他任务或新发音。
- speak 返回后仍可能有剩余音频，因此不能保证 speak→listen/Live 交接不录入自身声音。
- 扩展内的 task identity/epoch 能阻止迟到结果污染本地状态，但不能隔离远端设备控制。

### 临时使用限制

多客户端共享网关时避免调用 `voice_speak`。需要语音输入时可以仅使用 `voice_listen`/Live；不使用语音功能时执行 `/voice off`。这些限制不能替代网关端的任务隔离。

### 后续修复条件与验收

需先提供后端的按任务取消、物理播放完成事件及设备冲突仲裁，再修改适配器：

1. 同时运行两个客户端，停止 A 不得中断 B。
2. 取消 A 后立刻启动 B，即使 A 的清理请求迟到也不得停止 B。
3. 只有物理播放完成才能释放 speak→listen 互斥；固定延时不能当作完成确认。
4. 重载、退出和网络断开只取消当前客户端拥有的任务。

本轮仅修复了播音响应校验（空对象/错误对象不得算成功）及本地 UI 定时器清理，**没有改变上述网关控制行为**。
