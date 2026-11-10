# Harness 能力矩阵

状态：**第一轮（headless CLI）已完成**，2026-11-07。第二轮在设计适配器时测长连接协议。DeepSeek Harness 暂缓接入。

图例：✓ 支持 · ◐ 降级（写明方式）· ✗ 不支持 · ？ 未测

## 测试版本

| Harness | 版本 | 第一轮接入方式 | 适配器目标接入方式 |
|---|---|---|---|
| Claude Code | 2.1.319 | `claude -p --output-format stream-json --include-partial-messages` | Claude Agent SDK（可由宿主应答权限） |
| Codex | 0.154.0 | `codex exec --json` | `codex app-server`（JSON-RPC，有流式增量和审批请求） |
| pi | 0.84.2 | `pi -p --mode json --session-id` | `pi --mode rpc` 或 `pi-acp`，第二轮对比 |
| DeepSeek Harness | — | 暂缓 | 暂缓 |

## 能力（第一轮实测）

| 能力 | Claude Code | Codex | pi |
|---|---|---|---|
| 结构化流式输出 | ✓ `stream_event/content_block_delta` | ◐ `exec` 只给整段 `item.completed`，没有增量；app-server 有 `item/agentMessage/delta` | ✓ `message_update` |
| 中文 / 长输出 | ✓ | ✓ | ✓ |
| 工具调用事件 | ✓ assistant `tool_use` + user `tool_result` | ✓ `item.started/completed` · `command_execution` | ✓ `tool_execution_start/end` |
| 权限请求可被宿主应答 | ◐ headless 模式下自动拒绝，并记录在 `result.permission_denials`；要应答需用 SDK 或 `--permission-prompt-tool` | ◐ `exec` 默认只读沙箱，直接拒绝，没有审批事件；app-server 有 `item/*/requestApproval` | ✗ **没有权限拦截，直接写入了文件** |
| 取消后无残留进程 | ✓ 对进程组发 SIGINT 即可，最后还会输出 `result`（exit 0） | ✓ SIGINT 后 exit 1 | ✓ 被 SIGINT 终止 |
| 会话恢复 | ✓ `--resume <session_id>` | ✓ `exec resume <thread_id>` | ✓ `--session-id`，id 可以由宿主预先指定 |
| 加载 MCP | ？ | ？ | ？（AionCore 记录 pi 不加载 stdio MCP） |
| 用量 / token 信息 | ？ | ？ | ？ |
| 未登录时的错误可识别 | ？ | ？ | ？ |

## 结论与适配器决策

1. **Claude Code 用 Agent SDK**，不走 CLI 的 headless 模式。原因是 headless 模式无法让宿主应答权限请求，而 IM 界面里的权限卡片依赖这一点。
2. **Codex 用 `app-server`**。`exec --json` 既没有流式增量，也没有审批事件，只能作为兜底。`codex app-server generate-ts` 可以生成协议类型。
3. **pi 没有内置权限拦截**，这是安全上的硬约束：
   - pi 的会话**必须**在独立 worktree 中运行，界面上标明"无逐次授权"；
   - 第二轮要确认能否用 `--tools` 白名单或扩展来拦截写操作；
   - 在确认之前，委派给 pi 的任务默认只读（`--tools read`，可用性待验证）。
4. 三个 harness 对进程组发 SIGINT 都能干净退出。为防止工具子进程残留（自测中观察到过），仍然保留 SIGTERM → SIGKILL 的升级步骤。
5. 第二轮待测：MCP 加载、用量信息、未登录时的错误、权限应答（SDK 和 app-server），以及 pi 的 rpc / acp 模式。
