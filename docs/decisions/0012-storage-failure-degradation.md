# 0012 本地存储故障时的降级行为

日期：2026-11-11。状态：已接受。

## 背景

事件日志（SQLite，ADR 0009）是 UI 唯一的事实来源：用户在界面上看到的一切都来自 `buildTimeline(events)`。磁盘写满、数据库损坏时 `store.appendEvent` 会抛错。D20 故障注入发现两个漏洞：

1. `ConversationService.run()` 的 catch 分支里再次写库（补终止事件），这一写失败会逃出 `run()`，跳过全局并发槽位与队列的清理——**并发槽永久泄漏**，之后的 prompt 全部卡死，并产生 unhandled rejection。
2. 存储故障期间写入失败的运行会在日志里保持"打开"状态；而 `recoverInterruptedRuns()` 只扫描 state 为 running/waiting_user 的会话。如果之后有一次成功的运行把状态翻回 idle，这个打开的运行就永远不会被关闭，UI 上永久转圈。

## 决定

**存储写失败与 harness 失败是两类故障，分开处理。** 存储写全部包成带标签的 `StoreWriteError`（用户可见信息：`本地数据库写入失败：…`）。

- 运行中途日志写不进去：用户已经**看不见** harness 在做什么。立即 `cancel()` 停掉这次运行，不让它在看不见的情况下继续改文件；然后尽力写一条 `run.failed(storage_error)`。这条也写不进去就放弃（只 `console.error`），运行保持打开，**不撒谎**。
- `run()` 的资源清理（释放全局槽位、推进队列）放进 `finally`，任何故障路径都不会再泄漏槽位。
- `recoverInterruptedRuns()` 扫描**所有**会话的打开运行：打开的一律补 `run.failed(interrupted)`；只有状态停在 running/waiting_user 的会话才把会话态改为 failed，后来已经恢复健康的会话保持原状（中断仍以时间线事件可见）。
- `send()` / `create()` 的写库失败直接向调用方抛错（UI 弹出错误提示），不做任何半持久化的中间状态。

## 后果

- 存储故障的表现从"界面卡死且槽位泄漏"变成"明确的错误提示 + 停掉运行 + 重启后标记 interrupted"。
- 用户看到 `本地数据库写入失败` 时应该知道：检查磁盘空间；日志恢复前不要再继续操作该会话。
- 诊断仍依赖 stderr 日志；诊断包导出（计划 D20 配套）落地后这类错误应能被导出。
