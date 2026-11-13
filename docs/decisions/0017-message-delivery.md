# 0017 消息投递语义（D15）

日期：2026-11-13。状态：已接受，已实现（三个设计点经确认：重启不重投、支持 reply_to、不做独立超时）。协议变更：`send_message` 增加 `reply_to`，新增 `message.list` / `message.resend` RPC 与 `messages` 表（migration v6）。

## 背景

D14（ADR 0016）让 agent 能通过 `send_message` 给任务关系里的对方写事件，但**只记录、不投递**：对方 agent 的进程不会收到这段文字。计划 §7"投递约定"要求：先写库再派发、按 `message_id` 去重、至少一次投递 + 消费去重、重启与超时有确定状态、结果不确定进入"需核对"。D15 把这条约定落到 `send_message` 上（委派/交接已有自己的事件流，不在本 ADR 内）。

## 决定

### messages 表（migration v6，兼具 outbox 与 inbox）

```
messages(
  id TEXT PRIMARY KEY,                 -- message_id，插入幂等：重复 id 返回原行
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  task_id TEXT,                        -- 关联的子任务（可空，预留用户侧消息）
  kind TEXT NOT NULL DEFAULT 'message',
  text TEXT NOT NULL,
  reply_to TEXT,                       -- 回复哪条消息
  state TEXT NOT NULL,                 -- 见状态机
  run_id TEXT,                         -- 承载投递的 run
  created_at / delivered_at / consumed_at INTEGER
)
```

发送方会话按 `sender_id` 查出"我发出的"，接收方按 `recipient_id` 查出"我收到的"——一张表同时是 outbox 和 inbox，去重就是主键冲突时返回原行（`INSERT` 撞主键 → 读回既有行，不产生第二条）。

### 状态机

```
queued ──交付给会话队列──▶ delivered ──承载 run 启动──▶ consumed ──收到 reply_to 它的回复──▶ replied
   │                         │                              │
   │                         └── 承载 run 失败/被取消 ──────▶ needs_check
   └── 投递时目标不可用 ──▶ failed
重启核对：queued/delivered 未完成的一律 → needs_check，不自动重投。
```

对应 UI 文案：已入队 / 已投递 / 已确认收到 / 已回复 / 需核对 / 发送失败。

- **delivered**：消息已经作为 `core-` 前缀提示词排进接收会话的串行队列（可能还在等待全局并发名额）。
- **consumed**（已确认收到）：承载它的 `run.started` 已发生——这是"模型拿到了这段文字"所能有的最强信号；不宣称"已读"。
- **failed**：`conversation.send` 当场失败（会话不存在等）。`needs_check`：重启时还在 queued/delivered，或承载 run 失败——不确定模型是否已看到，不盲目重发，由用户在时间线卡片上点"重发"（重发走同一 message_id，天然幂等）。
- 不广播、不设独立定时器超时：投递是同步动作；"卡住"的消息在界面上如实停留在已入队/已投递并显示时间。

### 投递内容

接收会话收到的提示词形如：

```
core-[协作消息 m-…，来自子任务「标题」]
<原文>
（回复时调用 send_message，带 reply_to=m-…）
```

`core-` 前缀保证它永远不会被当作会话标题或 goal 来源（D22 已有此约定）。

### 协议变更

- `send_message` 参数增加可选 `reply_to: string`（回复时带上，原消息进入 `replied`）。
- 新 RPC `message.list { conversationId }` → 该会话发出与收到的消息及状态；时间线按 `messageId` 合并到协作卡片的状态角标。
- 事件体 `agent.message` 不变（仍只带 `messageId`），状态演进不入事件日志——状态是投递层的事，日志保持追加语义。

### 实现

- `packages/core/src/messaging/messageService.ts`：插入（幂等）→ 记录双向 `agent.message` 事件（沿用 D14）→ 投递 → 观察 `run.started/run.failed` 推进状态；启动时 `reconcile()` 把未完成消息置 `needs_check`。
- `CollaborationService.send_message` 改为委托 MessageService；返回值仍是 `{ messageId, state }`，`state` 从 `'recorded'` 扩展为投递后的真实状态。

## 后果

- 子任务的消息第一次真正到达父 agent；重启或失败后界面上能看到"需核对"并可手动重发，不会静默丢失或静默重跑。
- `replied` 依赖 agent 自觉带 `reply_to`，只是提示层面的约定，不强制。
- messages 表不含密钥（提示词文本会进库，与事件日志同等级，诊断导出沿用既有脱敏规则）。
