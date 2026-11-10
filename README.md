# Nexus

在本地统一管理多个 Agent CLI（Claude Code、Codex、pi）的桌面应用。界面像 IM 聊天，用浏览器式 Tab 切换会话，支持委派子任务和跨 harness 交接。纯本地运行：没有服务端、没有账号、没有云同步。

> macOS 优先，当前处于内测前阶段（M4 已完成，M5 稳定化进行中）。

## 它能做什么

- **一个窗口管理所有 harness**：Claude Code、Codex、pi 各自成一个会话，Tab 切换，并行运行，停止互不影响。
- **看清谁在做什么**：流式输出、思考过程、工具调用（含子代理嵌套）、权限卡片、运行记录与 token 用量；运行中、等待授权、失败、未读四种状态分开显示。
- **工作区隔离**：git 仓库中的会话默认在独立 worktree 中运行（detached HEAD），同一目录只允许一个直接会话，避免两个 Agent 互相覆盖。
- **委派**：把一部分工作交给另一个 harness 的子会话，子任务在独立 worktree 里跑，结果回到父会话卡片待你验收。
- **交接**：停止原 Agent 并**验证进程已退出**，冻结一份可检查的上下文包（你的原话、已确认事实、未验证假设、基准提交、未提交 diff、未跟踪文件），确认后在同一工作目录换人继续。
- **可恢复**：事件日志落盘（SQLite），重启后历史、Tab、草稿都在；被中断的运行标记为「运行被中断」，绝不自动重跑。

## 快速开始

```bash
pnpm install          # 需要 Node >= 22.12、pnpm 11
pnpm dev              # 启动桌面应用
pnpm check            # lint + typecheck + 边界规则 + 测试（CI 跑的就是这个）
```

```bash
NEXUS_FAKE_HARNESS=1 pnpm dev   # 加一个不消耗额度的演示 harness
pnpm e2e:smoke                  # 通过 CDP 驱动真实应用的端到端冒烟测试（macOS）
pnpm pack:mac                   # 生成未签名的 .app
```

使用你本机已安装并登录的 CLI，Nexus 不接管模型账户和计费。

## 架构

```
renderer ──MessagePort (JSON-RPC)──▶ core (utilityProcess) ──spawn──▶ harness CLIs
```

| 包 | 职责 |
|---|---|
| `packages/protocol` | zod schema、事件类型、适配器契约、类型化 JSON-RPC，全层共用 |
| `packages/core` | 全部产品逻辑：harness 检测、会话队列、权限、取消、SQLite 事件日志（Drizzle + better-sqlite3） |
| `packages/proc` | 进程组管理：SIGTERM → 轮询 → SIGKILL → 确认退出 |
| `packages/adapters/*` | 每个 harness 一个适配器（fake / claude / codex / pi） |
| `packages/ui` | React + Arco + Tailwind，纯浏览器环境（未来可做 WebUI） |
| `packages/desktop` | Electron 外壳：窗口、preload 端口交接、utilityProcess 托管 |

决策记录见 [`docs/decisions/`](docs/decisions)，开发约定见 [`AGENTS.md`](AGENTS.md)。

## 已知限制

- 仅支持 macOS；Windows / Linux 在路线图上。
- DeepSeek Harness（dsh）暂缓接入，只做检测。
- 未签名分发；签名与公证在 M5。
- 交接不迁移 harness 的私有会话历史（精简交接）。
- 各适配器目前有真实录制 fixture 的重放测试；真实 CLI 的契约测试需要手动运行（会消耗模型额度）。

## License

[MIT](LICENSE)
