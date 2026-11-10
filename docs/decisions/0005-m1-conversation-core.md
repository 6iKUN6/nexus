# 0005 M1 会话核心：事件日志 + node:sqlite + Claude Agent SDK

日期：2026-11-07 · 状态：已采纳

## 背景

M1 要跑通真实的单 Agent 聊天，并满足三点：多个 Tab 之间不串流；关闭 Tab 不中断运行；重启后能看到历史，并能核对崩溃时的状态。M0 探针显示，`claude -p` 无界面模式没法让宿主应答权限请求。

## 决策

1. **会话历史是一份只追加的事件日志**。每个会话的事件有单调递增的 `seq`，事件写入和会话状态更新在同一个事务里完成。界面所有内容（时间线、状态、未读）都由纯函数 `buildTimeline(events)` 从日志推导出来，所以重放、断线补齐、重启后的渲染结果完全一致。
2. **推送 + 补齐**：core 通过 JSON-RPC 通知推送 `conversation.event` 和 `conversation.updated`。客户端按 `seq` 去重；发现序号缺口时，用 `conversation.events(afterSeq)` 从缺口处补齐，所以漏掉一条通知也不会弄乱时间线。
3. **持久化用 Node 内置的 `node:sqlite`**（实测 Electron 45 的 Node 24.22 中可用，SQLite 3.53），不用 better-sqlite3。原因是它不需要针对 Electron 重新编译原生模块，打包更简单。数据库开 WAL，结构迁移通过 `PRAGMA user_version` 管理。
   > 2026-11-10 修订：驱动改为 better-sqlite3 + Drizzle（ADR 0009）——better-sqlite3 13 自带 Node-API 预编译二进制，已无编译成本，而手写 SQL 与行映射的维护成本开始显现。事件日志、推送/补齐、迁移方式不变。
4. **Claude Code 通过 Agent SDK 接入**，驱动的是**用户自己安装的 `claude`**（`pathToClaudeCodeExecutable` 传入 core 检测到的路径），所以用户的登录状态、设置和 CLAUDE.md 都会生效，我们也不用打包 SDK 自带的二进制。
   - 每条消息调用一次 `query()`：第一次用预设的 `sessionId`，之后用 `resume` 续上，所以会话在应用重启后也能继续。
   - `permissionMode: 'default'` + `canUseTool`，权限请求统一由界面里的权限卡片应答，不受用户 `defaultMode` 设置的影响。
   - SDK 会被打包进 `core.js`。已用 CJS 打包并驱动一个假 `claude` 脚本验证过可以正常工作。
5. **重启后的核对**：凡是开始了（或已排队）但没有收到结束事件的运行，一律追加一条 `run.failed(interrupted)`，并且**绝不自动重跑**，因为它可能已经改过文件。界面会提供"重试"，由用户手动重新发送。
6. **开发用的 Fake harness**：设置 `NEXUS_FAKE_HARNESS=1` 后会出现一个脚本化的 harness，可以在不消耗额度的情况下演示流式输出、工具调用和权限请求，自动化界面测试也靠它。

## 影响

- 文本增量（每个 token 片段）都会单独存成一条事件，长回复会产生很多行记录。M1 的数据量下这样没问题；后续可以按时间窗口合并写入，或者定期压缩。
- 界面状态（Tab、草稿、已读位置）暂时存在 localStorage。正常退出时主进程会先 `session.flushStorageData()` 再退出（否则 Chromium 的延迟提交会丢最后几秒的修改）；但**进程被强制杀掉时仍会丢**，后续会挪到 core 的 `ui_state` 表。
- 子代理（Task 工具）内部的工具调用嵌套展示在父卡片下；其正文与思考不并入主时间线（Task 结果里带摘要）。
- 契约测试（`pnpm test:contract`）会驱动真实的 CLI 并消耗额度，默认不运行。
