# 0016 协作通道（D14）

日期：2026-11-13。状态：已接受，已实现。协议变更（`CreateSessionOptions.collaboration`、`agent.message`/`handoff.requested` 事件）按本 ADR 执行。

## 背景

M3 委派（ADR 0008）只支持**用户发起**：UI 点委派 → core 写简报 → 子会话运行。计划 §7 要求 agent 自己也能协作（发消息、委派、汇报、请求交接），且要覆盖不加载 MCP 的 harness。D14 是这条通道的本体；可靠投递（outbox/inbox、去重、投递状态机）是 D15。

## 决定

### 通道

- Core 监听 `<userData>/nexus.sock`（unix socket，0600，启动时清理陈旧文件）。协议为 NDJSON JSON-RPC 2.0，与主 RPC 同构但不共用代码。
- 首个请求必须是 `collab.auth {token}`。Token 在创建 adapter 会话时签发，**仅存内存**、绑定 conversationId，会话 dispose 即吊销；不落库、不进日志、不进诊断包。
- 之后调用 `collab.send_message / delegate / report_result / request_handoff / read_task_context`。

### 注入（纯增量，按 harness 能力）

`CreateSessionOptions` 增加 `collaboration?: { socketPath, token }`。

| Harness | 方式 |
|---|---|
| Claude | SDK `mcpServers` 注入 stdio server：`process.execPath` + `ELECTRON_RUN_AS_NODE=1` 运行 `nexus-helper mcp` |
| Codex | app-server 的 MCP 配置注入，**机制待免费探针确认**；确认前标注"不支持主动协作" |
| pi | 环境变量 `NEXUS_SOCKET/NEXUS_TOKEN` + 一次性命令 `nexus-helper <tool>`；agent 通过 Nexus 写入的 core- 前缀 brief（委派/交接开场）得知命令存在，不注入全局系统提示 |

`nexus-helper` 一份实现两种形态：stdio MCP server 与一次性 CLI（输出紧凑 JSON）。

### 工具（5 个，紧凑 schema 控制 token 开销）

| 工具 | 参数 | 返回 |
|---|---|---|
| `send_message` | `{ text ≤2000, to?: 'parent' }` | `{ messageId, state: 'recorded' }` |
| `delegate` | `{ goal ≤500, acceptance? ≤1000, harness? }` | `{ taskId, conversationId }` |
| `report_result` | `{ summary ≤2000, blocked? }` | `{ taskId, status }` |
| `request_handoff` | `{ toHarnessId, reason ≤500 }` | `{ recorded: true }` |
| `read_task_context` | `{}` | `{ role, taskId?, goal, acceptance?, status }` |

工具返回值是数据，永不被提升为用户指令。

### 校验

- Token → 会话身份；操作仅限任务关系内（父↔子），越界拒绝。
- 上限：委派深度（默认 3）、单会话调用频率（防消息循环）、文本长度。
- `request_handoff` 只记录并发事件；交接仍由用户确认（ADR 0011 的人工确认点不动）。

### 协议与事件

- 新事件体 `agent.message`：`{ messageId, peerConversationId, direction: 'in'|'out', text }`，发送方记 `out`、接收方记 `in`，UI 渲染为消息卡片。
- 新事件体 `handoff.requested`：`{ toHarnessId, reason }`，UI 卡片点击打开预填交接对话框（复用 D22 的 `handoff.suggest`）。
- 表结构不动；messages 表属于 D15。

## 实现备注（2026-11-13）

- 启动方式改为由 core 生成 `<userData>/bin/nexus-helper`（0755 的 `/bin/sh` 脚本），内容只有路径：桌面壳通过 `NEXUS_ELECTRON_PATH` 告诉 core 用哪个 Electron 二进制 + `ELECTRON_RUN_AS_NODE=1` 运行 `out/main/helper.js`。这样 pi 的 brief 只需写 `"$NEXUS_HELPER_PATH" <tool> '<json>'`，Claude 的 MCP `command` 也可以直接用这个脚本，无需各自拼命令行。
- Codex 暂未注入（app-server 的 MCP 配置机制仍然未验证），不假装支持。
- 代码：`packages/core/src/collaboration/`（server / tokens / service / shim）、`packages/desktop/src/helper/index.ts`（MCP + 一次性 CLI）、`packages/adapters/claude` 的 `mcpServers` 注入。

## 后果

- Claude 会话自动获得 5 个工具；pi 需要 core- brief 提示 helper 用法；Codex 视探针结论而定，不支持时如实标注。
- D14 的 `send_message` 只落事件（记录可见），可靠投递与去重由 D15 补齐。
- 通道的额外 token 成本 = 5 个短 schema 的工具定义；不注入系统提示。
- 安全面：本地 socket 0600 + 每会话短令牌 + 关系内校验；agent 拿不到任何文件/进程权限，只能通过这 5 个工具与 core 对话。