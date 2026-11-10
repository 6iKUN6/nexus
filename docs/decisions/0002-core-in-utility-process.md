# 0002 进程模型：核心运行在 utilityProcess，通过 MessagePort 走 JSON-RPC

日期：2026-11-07 · 状态：已采纳

## 背景

核心要管理多个 CLI 子进程、事件流和持久化，不能卡住界面，也不能让渲染进程拿到 Node 能力。以后还可能做 WebUI 或常驻服务。

## 决策

- `packages/core` 是纯 Node 包，**不 import electron**。桌面端由 `desktop/src/core-host` 在 Electron `utilityProcess` 中启动它。
- 主进程为每个窗口创建一对 `MessageChannelMain`：一端交给核心，另一端经 preload 用 `window.postMessage` 转交页面。之后主进程不再参与通信。
- 通信协议是 `protocol/src/rpc.ts` 中的类型化 JSON-RPC 2.0。请求和响应两端都用 zod 校验。传输层抽象为 `RpcPort`，测试时用内存端口，以后可以换成 WebSocket。
- 核心意外退出时，主进程会重启它并重新连接所有窗口。

## 影响

- 核心可以脱离 Electron 单独测试，`createCore` 通过依赖注入拿到外部能力。
- 新增功能的做法是先在 protocol 中定义 RPC 方法，再在 core 中实现，最后在 ui 中调用。
- 目前只有请求/响应。M1 会增加核心向界面推送的事件流（带会话内单调序号，断线后可以补齐），形式是 protocol 中的通知消息。
