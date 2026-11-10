# 0001 自研 TypeScript 全栈，不基于 AionUi 二次开发

日期：2026-11-07 · 状态：已采纳

## 背景

AionUi 由两部分组成：Electron/React 外壳，以及 Rust 写的后端 AionCore（Axum + SQLite，24 个 crate）。会话、Agent 和协作逻辑都在 AionCore 里。我们的差异点是任务归属、worktree 隔离和交接，这些都要改它的核心领域代码；而且它有大量我们用不到的模块（内置引擎、Office、IM 渠道、鉴权等）。

## 决策

从 0 开始，全部用 TypeScript 自研：Electron 外壳 + 不依赖 Electron 的 Node 核心 + React/Arco 界面。AionUi 和 AionCore（Apache-2.0）只作为阅读参考，不 fork，也不复制代码。如果将来确实要复制某段实现，必须保留版权声明并附 NOTICE。

## 影响

- 领域模型从第一天就按自己的设计来，没有合并上游代码的负担。
- 各 CLI 的坑（进程清理、PATH、stderr 错误识别）要自己踩一遍。可以阅读 AionCore 中的 `aionui-process`、`permission_router.rs`、`stderr_error_extractor.rs`、`agent_reconcile.rs` 来缩短过程。
- Claude Agent SDK、ACP SDK、MCP SDK 都是 TypeScript，可以直接使用。
