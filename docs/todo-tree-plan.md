# Todo Tree (层次化任务清单) 需求与技术设计方案

本文档记录了面向 Pi Coding Agent 的层次化任务清单扩展（Todo Tree）的完整需求、架构设计与实施计划。

---

## 一、 背景与需求综述

### 1. 背景与现状痛点 (对比 `@juicesharp/rpiv-todo`)
* **扁平结构局限**：`@juicesharp/rpiv-todo` 采用单层扁平任务清单，无法表达工程任务中常见的“阶段 $\rightarrow$ 模块 $\rightarrow$ 具体小项”多层级关系。
* **主界面空间侵占**：在输入框上方同时显示待办、进行中与已完成任务，即使有截断，依然占据过多行数。
* **缺少独立交互弹窗**：仅依赖行内折叠或终端文本打印，缺乏全屏/居中弹出窗口（Modal）及流畅的滚动操作。
* **缺乏任务便签/批注机制**：用户无法针对某个具体子任务附加上下文或注意事项。

### 2. 核心需求与最新定制要求
1. **分层级任务模型 (Hierarchy & Subtasks)**：
   - 任务具备父子关系，支持大任务拆分至具体执行小项；
   - 移除不必要的 `activeForm` 与 `order` 字段，直接以清晰的树状结构和自然顺序/ID 组织。
2. **主窗体极简聚焦 (Active Tasks Only)**：
   - 仅在输入栏上方展示总体进度与**当前正在进行（`in_progress`）的所有子任务**；
   - **多并行任务全展示**：只要处于进行中状态就全部清晰呈现，不设死板的高度上限截断；
   - **右侧固定查看按钮**：在主行右端固定放置 `[📋 ]` 图标按钮，支持**鼠标直接点击**与**键盘快捷键**（如 `Ctrl+Shift+T`）呼出弹窗。
3. **完整任务树弹窗 (Modal Overlay with Scrollbar)**：
   - 居中/全屏悬浮弹窗，呈现完整任务树、层级缩进与状态；
   - 内置**字符滚动条（Scrollbar）**，完整支持鼠标滚轮（wheel）与键盘方向键/翻页键浏览；
   - 支持节点折叠/展开与详情查看。
4. **任务批注（Annotations / 上下文提示）**：
   - 用户可针对任务节点添加便签；
   - **零破坏 Prompt Cache**：UI 便签保存在本地状态中，完全不向 LLM 发送；若用户需主动提醒 Agent，则以 User 消息形式追加在会话末尾，保证已有上下文的前缀缓存 100% 命中。
5. **最小化主 Agent 上下文污染**：
   - 工具调用成功后，`content[0].text` 仅返回单行操作摘要；
   - 全量树状数据只沉淀在 `details` 中，供 UI 与分支回放使用，不占用模型 Token；
   - 数据格式兼容已有的 `todo-loop.ts`，自动形成未完成任务推进闭环。
6. **多扩展位置共存 (与 `rolling-tools` 协同)**：
   - 本扩展主组件必须显示在 `rolling-tools` 滚动块的**正上方**；
   - 采用单例组件结合内部状态驱动渲染（避免重复 `setWidget` 引发 Map 键序跳动），确保界面层次稳定。
7. **任务生命周期的动态演进**：
   - 充分考虑实际研发中“中途新增子任务”、“后续某些子项取消不做了”等情况；
   - 允许动态在任意父任务下添加子任务，支持 `cancelled` 状态，已取消项不阻塞后续进度。
8. **英文 Tool 提示词与自定义配置**：
   - LLM 工具的 Description、Guidance、Parameter Schema 均采用地道规范的**英文**撰写；
   - 支持用户通过配置文件自定义触发规则与指南。
9. **快速开关命令（默认关闭）**：
   - 小任务无需将 Todo 工具暴露给 LLM，扩展**默认处于关闭状态（Disabled）**；
   - 提供快速开关命令 `/todo`（`/todo on`、`/todo off`、`/todo toggle`、`/todo status`）；
   - 关闭状态下动态从 Provider 请求中隐藏工具并移除主窗体 Widget，实现 0 上下文污染与 0 界面占用。

---

## 二、 数据结构与状态模型

### 1. 任务节点 (TodoItem)
```typescript
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoNote {
  id: string;
  author: "user" | "agent";
  text: string;
  createdAt: number;
}

export interface TodoItem {
  id: string;               // 语义层级 ID（如 "1", "1.1", "1.2"）或自增数字字符串
  parentId?: string | null; // 父任务 ID，顶层根任务为 null 或 undefined
  subject: string;          // 简短任务主题
  description?: string;     // 详细说明或上下文要求
  status: TodoStatus;       // 任务状态
  notes?: TodoNote[];       // 批注/便签
  createdAt: number;
  updatedAt: number;
}
```

### 2. 状态跃迁与动态变更
* **支持的状态**：
  * `pending`：排队待办；
  * `in_progress`：正在执行（可同时存在多个并行项）；
  * `completed`：已完成；
  * `cancelled`：已取消/放弃（因需求变更或方案调整无需再做）。
* **动态灵活性**：
  * **中途加项**：LLM 或用户可随时调用 `create` 挂载在既有父节点下；
  * **中途跳过/作废**：支持将子项置为 `cancelled`，父任务状态计算时自动忽略已取消子项；
  * **父子联动**：当某父节点下的所有非取消子项均变为 `completed` 时，父任务自动标记为已完成。
* **进度计算准则**：
  $$\text{有效总项数} = \text{Count}(\text{completed} + \text{in\_progress} + \text{pending})$$
  $$\text{完成进度} = \frac{\text{Count}(\text{completed})}{\text{有效总项数}} \times 100\%$$
  *(注：已取消的 `cancelled` 项不计入分母，不阻碍 100% 达成)*

---

## 三、 UI 与终端交互设计

### 1. 主窗体 Widget（输入栏上方）
* **显示位置**：挂载在 `ctx.ui.setWidget("todos", ...)`，通过保序机制确保位于 `rolling-tools` 上方、Editor 输入框之前。
* **排版内容**：
  * **主行（进度与首项）**：
    `● Todos [3/7 · 42%] [████░░░░░] [数据模块] > 编写Repository测试  [📋 ]`
  * **并行进行中任务行**：
    若当前有多个任务同时处于 `in_progress`，自适应输出后续进行中项（如 `  └─ ◐ [接口层] > 联调 OpenApi 路由`），完整展示所有进行中工作，不设死板截断。
* **右侧交互按钮 `[📋 ]`**：
  * 组件通过 `handleMouse(event: TuiMouseEvent)` 计算点击区域（`x >= width - 6`）；
  * 鼠标点击直接弹出详情弹窗；
  * 同时支持全局快捷键（默认 `ctrl+shift+t` 或配置值）。

### 2. 完整 Overlay 弹窗（Modal）
* **弹窗布局**：
  * 居中悬浮方框，占用约 80%~85% 视口；
  * 点击弹窗外部半透明/空白区直接关闭（`onClose`）；按 `Esc` 或 `q` 亦可关闭。
* **树状渲染**：
  * 采用 `├─`、`│ `、`└─` 字符清晰展示任务从属关系；
  * 图标区分：`◐` 进行中、`○` 待办、`✓` 已完成、`✗` 已取消；若有批注则标记 `💬`。
* **字符滚动条（Scrollbar）**：
  * 视口超过高度时，在右边界绘制 `│` 轨道与 `█` 滑块；
  * 完美支持鼠标滚轮（`wheel`）、键盘方向键（`Up`/`Down`）、翻页键（`PageUp`/`PageDown`）。
* **弹窗按键操作指南**：
  * `[↑/↓]`：移动选中的任务项；
  * `[Space]`：折叠/展开当前父节点；
  * `[n]`：为当前任务添加本地批注（呼出输入框）；
  * `[c]`：快捷切换任务状态（完成/待办）；
  * `[Esc/q/Enter]`：退出弹窗。

---

## 四、 批注（Annotations）与 Prompt Cache 影响评估

### 1. 缓存风险论证
* 现代 LLM（如 Claude、DeepSeek、OpenAI）依赖基于输入文本**严格前缀匹配（Prefix Caching）**的缓存机制；
* **高危行为**：若篡改历史上的 `toolResult` 或动态在 System Prompt 中更新批注，会导致整条长对话历史缓存**100% 击穿失效**，造成响应延迟激增与费用浪费。

### 2. 本方案的双层安全设计
1. **本地便签模式 (Local UI Note) —— 0 缓存影响**：
   - 用户在弹窗中为任务添加的备注，仅存储在持久化状态（`details` / custom entry）中；
   - 完全不进入 LLM 上下文，供用户自己对照检查，**Token 消耗 = 0，Cache 命中率 = 100%**。
2. **主动指导模式 (Steer Message) —— 0 历史失效**：
   - 若用户期望将该批注作为约束立即告诉 Agent，弹窗提供“提醒 Agent”选项；
   - 通过 `pi.sendUserMessage("[Todo Note for #1.2]: 请确保向下兼容旧字段", { deliverAs: "followUp" })`；
   - 该消息作为普通用户消息**追加在对话的最尾部**，前面的完整前缀缓存依然 100% 命中，无额外缓存惩罚。

---

## 五、 上下文低污染与多扩展共存

### 1. LLM 上下文极简策略
* **Tool Result Content**：每次工具执行仅返回单行简报，如：
  `✓ Created #1.2 "编写Repository测试" under #1 (1 active, 4 pending)`
  `✓ Updated #1.2 status: completed`
  严禁将多行完整树状内容 dump 回 LLM 文本区。
* **持久化隔离**：完整任务树存储在 `details` 中。Pi Agent 保证 `details` 仅在会话回放与扩展内部流转，不计入上下文 Token。
* **兼容 `todo-loop.ts`**：在 `details.tasks` 中保持兼容的对象结构，现有 `todo-loop` 能够无感知识别剩余任务并自动跟进。

### 2. 与 `rolling-tools` 的位置共存保证
* **原理**：Pi 的 `InteractiveMode` 将 `aboveEditor` 的所有组件放入 `Map`，渲染时按 Map 迭代顺序由上至下排列。
* **保序方案**：
  1. `todos` 采用单例 Component 挂载，状态更新时仅调用组件自身 `invalidate()` + `tui.requestRender()`，**绝对不重复调用 `ctx.ui.setWidget`**；
  2. `rolling-tools` 在每次工具执行后会重新调用 `setWidget("rolling-tools")`，这会自动将 `rolling-tools` 推到 Map 的末尾（紧挨输入栏）；
  3. 因此，`todos` 将**天然且恒定地保持在 `rolling-tools` 滚动块的正上方**，彻底杜绝两个 Widget 上下颠倒和跳动问题。

---

## 六、 动态开关与英文 Tool 提示词

### 1. 快速开关控制（默认关闭）
* **开关命令**：
  * `/todo on`：启用任务清单工具与主窗体 Widget；
  * `/todo off`：禁用任务清单，隐藏主窗体 Widget；
  * `/todo` 或 `/todo toggle`：状态翻转；
  * `/todo status`：查看当前配置与任务统计。
* **LLM 隐身机制**：
  * 在关闭（`disabled`）状态下，通过 `before_provider_request` 钩子动态从请求 payload 的 `tools` 列表中剔除 `todo` 工具；
  * 日常小任务中，LLM 完全感知不到该工具，保持 0 提示词干扰与极速响应。

### 2. 英文 Tool 提示词定义 (Tool Guidance)
工具描述与参数定义全英文撰写，规范标准：

```typescript
export const TODO_TOOL_DESCRIPTION = `
Track and organize complex, multi-step engineering tasks using a hierarchical todo list.
Use this tool whenever a task involves multiple stages, cross-file refactoring, or when structured subtasks are needed.
Break down work into parent goals and actionable leaf subtasks. Keep only the currently active leaf items as in_progress. Mark subtasks completed as soon as they are verified.
`.trim();
```

---

## 八、 关键缺陷（Bug List）与完整修复记录

在第一阶段实现后，经端到端压力测试与源码对照，修复了以下关键缺陷：

1. **🔴 弹窗键盘交互完全重构（修复 Bug 1）**：
   - 彻底废弃伪接口 `handleKey`，实现 Pi TUI 标准的 `handleInput(data: string): void`；
   - 内部集成 `matchesKey` 配合 `Key.up`、`Key.down`、`Key.space`、`Key.escape`、`Key.enter` 及 Vim 键位 `j`/`k`/`q`，确保键盘移动、展开折叠、完成标记与 Esc 退出 100% 顺畅。
2. **🔴 纯状态双向推导与历史完成保护（修复 Bug 2）**：
   - 重构 `checkParentStatus`：子项重开（`pending`）时父项自适应回退到 `in_progress` 或 `pending`；所有子项 `cancelled` 时父项才 `cancelled`；
   - `cascadeChildrenStatus` 实施保护原则：父项取消绝不覆盖已被确认 `completed` 的子项。
3. **🔴 会话 Custom Entry 持久化（修复 Bug 3）**：
   - 引入专用类型 `SNAPSHOT_ENTRY_TYPE = "todo-tree-state"`；
   - 在任何任务或便签修改时，触发 `pi.appendEntry()` 保存快照；在会话恢复时优先反序列化该快照，确保 Fork、Compact、Reload 后用户批注与修改零丢失。
4. **🟠 原生 `pi.setActiveTools` 动态隔离（修复 Bug 4）**：
   - 放弃仅在 HTTP Payload 层打补丁的做法，改用 Pi 官方原生的 `pi.setActiveTools()` 控制工具声明；
   - `/todo off` 模式下，System Prompt 和 Provider 请求中均完全不包含 `todo` 工具，实现真正的 0 提示词与 0 上下文污染。
5. **🟠 树防环死循环校验与深度截断（修复 Bug 5）**：
   - 面包屑遍历、节点收集和树构建中加入 `visited = new Set<string>()` 机制；
   - 引入 `MAX_TREE_DEPTH = 32` 硬上限，杜绝畸形快照或异常调用引发调用栈溢出或无限死循环。
6. **🟠 精准鼠标命中与防止全局误触（修复 Bug 6）**：
   - 移除 Widget 全局任意点击打开弹窗的逻辑；
   - 动态计算按钮宽度 `visibleWidth("[📋 ]")`，只有在首行右侧命中按钮区域时才触发弹窗。
7. **🟠 弹窗宽度溢出与长文本严格截断（修复 Bug 7）**：
   - 修复仅对原始字符串截断但输出未截断变量的错位逻辑；
   - 精确计算边框行内部可用宽度，自适应折叠狭窄视口下的统计文字，确保所有行长恒等于 `boxWidth`。
8. **🟡 终端控制字符清洗（修复 Bug 8）**：
   - 引入 `sanitizeText(str)`，清洗 OSC / CSI 转义序列及不可见控制字符，换行符统一变为空格，杜绝终端标题劫持或换行破坏。
9. **🟡 资源订阅释放与性能缓存（修复 Bug 9）**：
   - 在 `TodoTreeWidgetComponent` 中提供 `dispose()` 并在会话关闭时注销 `store` 监听器；
   - 引入 `isDirty` 标记对统计数据与展平树进行懒计算缓存。

