# 0007: M2 Codex/pi 适配器（app-server 与 rpc 模式）

日期：2026-11-10。状态：已接受。

## 背景

M2 要为 Codex 和 pi 提供适配器（开发落地计划 D10/D11）。两者的 M0 结论分别是：`codex app-server` 提供 stdio JSON-RPC（线程 = thread，运行 = turn，审批是 server 主动发起的请求），`pi --mode rpc` 提供 JSONL stdio（命令 + 事件流）。M2 实施前对两者各跑了一组真实录制（`probes/output/{codex,pi}/`，脱敏后为适配器 fixtures）。

## 决定

**Codex（`@nexus/adapter-codex`）**

- 每个会话一个 `codex app-server` 进程（独立进程组，dispose 时整组 SIGTERM→SIGKILL）。thread id 即 externalId，重启后 `thread/resume`（带 `excludeTurns: true`，全量回放在协议里已废弃）。
- 审批策略**固定**为 `approvalPolicy: 'on-request'` + `sandbox: 'workspace-write'`，不继承用户 codex 配置——配置可能比 Nexus 能呈现的更宽松（never ask / danger-full-access），那样权限卡就失效了。与 Claude 适配器固定 `permissionMode: 'default'` 同一先例。
- 审批映射：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`（及 legacy `execCommandApproval`/`applyPatchApproval`）→ `permission.requested`；允许一次/本会话始终允许/拒绝 → `accept`/`acceptForSession`/`decline`（legacy 用 `approved`/`approved_for_session`/`denied`）。Nexus 无法呈现的 server 请求（elicitation、tool input 等）一律以 JSON-RPC error 拒绝，避免 turn 挂起。
- 取消 = `turn/interrupt`；`turn/completed` 的 status 决定终止事件（`interrupted`→cancelled，`failed`→run.failed）。
- 只有 `item/completed` 才带正文的 agentMessage（commentary 经常无 delta）要补发为一次 `text.delta`，否则丢消息。

**pi（`@nexus/adapter-pi`）**

- 每个会话一个 `pi --mode rpc --session-id <id>` 进程；session id 即 externalId，续传用同一 id 重新 spawn。
- pi **没有权限门控**：工具调用直接执行。因此 `capabilities.permissions=false`，UI 展示限制说明，安全完全依赖 ADR 0006 的 worktree 隔离。
- 一个 Nexus run 对应 pi 的 `agent_start`→`agent_end`（内部多个 turn 是工具循环，不暴露）。`turn_end` 的 `message.usage`/`stopReason` 提供用量与终止原因（`aborted`→cancelled，`error`→run.failed）。
- **`agent_settled` 不能当终止事件**：它属于上一个 agent 循环，可能在下一个 prompt 已发出后才到达（contract 测试实测踩中），只能用 `agent_end` 收尾。
- 用户扩展的 `extension_ui_request` 噪音一律忽略（不响应）；扩展是用户环境的一部分，不用 `--no-extensions` 禁用。

## 后果

- 两个适配器都以真实录制做 fixture 重放测试（`packages/adapters/<name>/fixtures/`），contract 测试钉住 codex-cli 0.154.0。
- 已知限制写进 `probe().limitations` 并在 Agents 视图展示：codex 的 plan/collab 事件不展示；pi 无权限门控。
- 每个会话一个长驻进程，内存开销与 claude 适配器（每 run 一个进程）不同，M5 稳定性阶段再评估是否合并。
