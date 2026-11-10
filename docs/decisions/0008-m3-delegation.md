# 0008: M3 委派（用户发起的父子任务）

日期：2026-11-10。状态：已接受。

## 背景

M3 要做委派（开发落地计划路径 B）：用户把一部分工作交给另一个 harness 的子会话执行，结果可追溯、可验收。计划的完整版还包含内置 MCP Server + nexus-helper（D14，让 Agent 主动请求协作）和 inbox/outbox 通道。按计划的推迟清单（"若适配器风险消耗缓冲，依次推迟：dsh 接入、Agent 主动协作……"），M2 的适配器风险确实消耗了缓冲，因此 **M3 只做用户发起的委派**，D14 的 Agent 主动协作通道后移。出口标准"一个父任务委派子任务、结果可追溯"不受影响。

## 决定

**范围**

- 委派只能由用户发起（作曲家"委派"按钮打开真实对话框）。子任务不能再次委派——TaskService 拒绝 child-of-child（错误码 4011），只支持一层。
- 移交（handoff）仍是 M4 的设计预览，不接入 core。

**数据模型（migration v3）**

- `tasks` 表：id、parent/child conversation id、goal、acceptance（可空）、harnessId、status、resultSummary（可空）、时间戳。
- 状态机：`running → review | failed`；`review → accepted`（验收通过）；`review | failed → running`（退回修改/重做，反馈作为新 prompt 发给子会话）。其它迁移一律拒绝（4012）。

**子会话与结果回流**

- 子会话就是一个普通的 worktree 隔离会话（ADR 0006），分支自父会话的 base 目录；核心代写一份简报（目标 + 验收标准 + 工作区说明 + 结果要求）作为首条 prompt。适配器完全不需要知道委派的存在。
- 结果**自动回流**：TaskService 观察会话状态广播——子会话 failed → `failed`；idle 且已完成至少一个 run → `review`，摘要取最后一个 run 的流式文本（截断 1500 字符）。idle 判定要求有完成的 run，否则创建后、首跑前的空闲会被误当完成。启动时 `reconcile()` 补一遍，覆盖 core 崩溃期间丢失的迁移（绝不重跑任何东西）。
- 子任务等待权限时状态保持 `running`，侧栏按会话状态显示"等待授权"——权限属于子会话，不冒泡到父会话。

**事件与 UI**

- 遵循 ADR 0005：`task.delegated` / `task.updated` 追加到**父会话**日志，UI 把同一 task 的事件折叠成一张实时委派卡片（目标、验收标准、状态、结果摘要、打开子会话、验收通过、退回修改+内联反馈）。
- `task.inbox` 提供"待我处理"数据源：有待验收或失败子任务的父会话及其状态。
- 子会话顶部显示指向委派方的横幅（`task.list` 反查 parent）。
- 委派对话框砍掉了预览版里的"共享只读工作区"选项——文件系统层面无法强制只读，工作区固定为独立 worktree。

## 后果

- protocol 新增 `task.ts`、两个 core 事件、四个 RPC 方法（task.delegate/list/inbox/respond）——协议变更按约定需要两位开发者确认。
- 无 MCP Server、无 nexus-helper：D14 后移，届时子任务的"提交结果"可以替换为显式工具调用，但用户发起的骨架（任务表、状态机、卡片、验收流）保持不变。
- 测试：TaskService 5 个集成测试（经 createCore + 假适配器，含重启核对）；e2e 覆盖委派→子会话权限→待验收→验收通过全流程。
