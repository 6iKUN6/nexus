# 0011 M4 简化交接

日期：2026-11-10。状态：已接受。取代 M3 的「交接只是设计预览」。

## 背景

计划要求 v0.2 至少跑通一条跨 harness 的交接路径（验收场景 6、7、8）：交接包保留用户纠正、未提交改动与未跟踪文件清单；commit 前/后/接收方启动前崩溃，恢复后负责人唯一；原 Agent 无法确认停止时交接被阻止。M3 只做到委派，交接仍是 UI 里的设计预览。

完整版状态机（quiescing、accepted 预检、ownership epoch、旧 epoch 拒绝）按计划推迟；v0.2 做**简化版**，物理隔离依赖两件已经具备的东西：可验证的进程停止（ADR 0010）与 worktree 隔离（ADR 0006）。状态机本身只保证"负责人切换是原子的、崩溃后不歧义"。

## 决定

**状态机：`stopping_source → prepared → committed → running`，失败态 `aborted / needs_reconciliation`**

- `stopping_source`：插入 handoff 行，**先**把会话挂起（`ConversationService.hold`），再调用 `stopSession()`。返回 `confirmed: false` 时写 `aborted` 并抛错（错误码 4014），负责人不变。挂起后用户消息进入队列而不是重启旧 Agent——否则交接评审期间旧进程会复活。
- `prepared`：冻结上下文包（见下），记录当时的 `ownerVersion`（迁移 v4 新增列，默认 1）。此时负责人仍是原 harness。
- `committed`：**单事务**更新会话的 `harnessId`、清空 `externalSessionId`（会话 id 只在原适配器内有意义）、`ownerVersion + 1`，并推进 handoff 版本。CAS 有两重：handoff 版本与包里的 `ownerVersion`；任一不符则什么都不写（`VersionConflict`，错误码 4015）。
- commit 后把交接简报作为 prompt 插到队列**最前**（交接期间用户写的消息排在其后，按计划 §7 路由给新负责人），然后解除挂起。接收方启动失败 → `needs_reconciliation`，**不回滚**（计划：commit 后失败保留新负责人）。
- 启动核对以**会话的当前 owner 列**判断崩溃落在 commit 前后：owner 已是接收方 → `needs_reconciliation`（负责人已变，需要用户处理）；仍是原 owner → `aborted`（任务仍归原 Agent）。核对期间 `observeConversation` 被忽略，避免恢复出来的 `run.failed(interrupted)` 被误读为"接收方启动失败"。

**上下文包（D18）**

- 用户消息全部按原文纳入（最多最近 12 条，省略项写明原因），每条带 `sourceMessageId`；core 自己发的消息（委派简报、交接简报）以 `core-` 前缀排除，避免被当成用户要求。
- 原 Agent 最后一段汇报单独放在"已确认的事实"里并**标注是它的汇报**（是声明，不是已验证事实）。用户填写的"事实"和"假设"分两个字段，UI 用不同图标与标题区分。
- 工作区：`rev-parse HEAD`、`git diff HEAD`（超过 12000 字符截断并记为省略项）、`git status --porcelain -z` 的未跟踪清单；`.env*`、`*.pem/key/p12/pfx` 一律不写入，只记"疑似密钥文件"这一省略项。
- 无精确 tokenizer，`estimatedTokens` 按简报字符数 / 2.5 估算，UI 标注"估算"。
- 交接简报明确告诉接收方"上一任已停止、这是你的任务"，并要求先确认工作目录状态。

**UI**

- 交接抽屉替换原设计预览：第一步填写目标、下一步、事实、假设（含"会先停掉原 Agent"的警告），第二步展示**冻结后的包**（必带要求 / 已确认的事实 / 未验证的假设 / 文件与工作区 / 省略的内容），确认才改负责人。"返回修改"会显式丢弃已冻结的包并解除挂起（否则会话会被永久挂起）。
- 时间线新增 `handoff` 卡片，只记录最终态；`aborted` / `needs_reconciliation` 显示原因与当前负责人。

**其它行为变化**

- `stopSession()` 现在把被主动停掉的运行记为 `run.completed(cancelled)`，而不是 `run.failed(no_terminal_event)`——进程是按请求结束的，说"结果未知"会误报。停机（disposeSessions）仍丢弃事件，保持 interrupted 语义。
- `send()` 在有排队消息时也判定为 `busy`；`send(..., { front: true })` 供交接简报插队。

## 后果

- protocol 变更（按约定需两位开发者确认）：`handoff.ts`、`Conversation.ownerVersion`、core 事件 `handoff`、三个 RPC（handoff.prepare/commit/cancel）。
- 迁移 v4：`conversations.owner_version`、`handoffs` 表（包以 JSON 冻结存储，后续 schema 变化不得改写历史包）。
- 测试：HandoffService 7 个集成测试（准备/提交、无法确认停止时阻止、版本冲突、评审期间排队、取消、重启前/后崩溃两种恢复）、Store 2 个、ConversationService 2 个、buildTimeline 1 个；e2e 增加准备→评审→取消→继续发送。
- 已知限制：交接不迁移 harness 私有会话历史（精简交接本来就是如此）；直接模式（非 worktree）同样允许交接，但此时隔离只靠"原进程已停止"。
