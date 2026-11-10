# 0010 已确认停止 + 全局运行上限

日期：2026-11-10。状态：已接受。M4 交接（D18/D19）的前置。

## 背景

计划要求交接的关键规则是「原 Agent 无法确认停止时，交接被阻止」，验收场景 12 是「取消运行与退出应用后无残留子进程」。但 M2 的代码只做了「发信号」：codex / pi 适配器的 `kill()` 是 SIGTERM 进程组 → 2 秒后 SIGKILL，**从不验证组成员是否真的退出**，而且 `dispose()` 返回 `Promise<void>`，调用方无从判断"确定停了"还是"发过信号了"。没有这个信号，交接状态机只能相信进程已停。

另外计划 §7 规定「全局并发上限默认 3」，但当时只有每会话串行队列：开 10 个会话就是 10 个 CLI 进程，而 M4 交接期间要按任务排队并改派。

## 决定

**1. `@nexus/proc`：可验证的进程组终止**

- 新增内部包 `@nexus/proc`（只依赖 Node，适配器与 core 共用；不是适配器互相依赖）。
- `terminateProcessGroup(pid)`：SIGTERM 进程组 → 轮询 `kill(-pgid, 0)` → 超过宽限期 SIGKILL → 再轮询；只有内核报告组为空才返回 `confirmed: true`。`ESRCH` 视为已退出，`EPERM` 视为仍存在，pid 缺失一律**不确认**。
- adapter 契约（protocol）里 `dispose(): Promise<StopResult>`，`StopResult = { confirmed, problem }`，`problem` 是给用户看的原话。fake 与 claude 返回 `confirmed: true`（fake 无进程；claude 的 CLI 子进程由 SDK 管理，我们没有句柄可轮询），codex/pi 用真实的组退出验证。
- core 新增 `ConversationService.stopSession(id)`：清掉该会话的排队与槽位、丢弃 session、返回停止结果。`disposeSessions()` 汇总所有会话的停止结果。

**2. 停机时不写终止事件**

停机会 abort 适配器，适配器按契约发出 `run.completed(cancelled)`。若把它写进日志，被中断的运行会被记成"用户主动取消"，重启后的核对就失去意义（ADR 0005 §5）。所以 `ConversationService.disposeSessions()` 期间丢弃事件写入，让下次启动的 `recoverInterruptedRuns()` 把打开的运行收成 `run.failed(interrupted)`。

**3. 全局运行上限（默认 3）**

- `ConversationService` 维护 `running` 集合与跨会话 FIFO 的 `waiting` 队列；`send()` 在「会话忙」或「槽位已满」时记 `run.queued`。
- 槽位释放时先 `pump()` 全局等待队列，再启动本会话自己的排队消息（会话内仍严格 FIFO）。
- 等待槽位的运行可以被取消：没有进程可发信号，直接移除并补一条 `run.completed(cancelled)`。
- `stopSession()` 也会丢弃该会话在全局队列中的等待项，避免"已停止的会话稍后自己跑起来"。

## 后果

- M4 交接可以依赖 `stopSession().confirmed` 决定是否允许交接；无法确认时阻止并展示 `problem`。
- 测试：`@nexus/proc` 4 个真实进程测试（含忽略 SIGTERM 的孙进程）；三个并发测试（上限、FIFO、取消等待中的运行）；停机不写事件的回归测试。
- 已确认行为变化：并发上限让第三个以上同时发送的会话显示"排队中"。UI 已有该状态，无需新交互。
- 已知限制：claude 的 `confirmed` 是"SDK 会关闭它自己的子进程"，不是内核级验证——SDK 不暴露 pid。若将来需要内核级确认，可通过 `spawnClaudeCodeProcess` 自行 spawn 并保留 pid（SDK 文档支持），本次不做。
