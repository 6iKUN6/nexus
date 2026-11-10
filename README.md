# Nexus（暂名）

在本地统一管理 Agent CLI（Claude Code、Codex、pi、DeepSeek Harness）的桌面应用。界面像 IM 聊天，用 Tab 切换多个会话，支持委派与交接。纯本地运行，不需要部署服务器。

- 开发方案：[`开发落地计划.md`](开发落地计划.md)
- 开发约定（人与 AI 共用）：[`AGENTS.md`](AGENTS.md)
- 架构决策：[`docs/decisions/`](docs/decisions)
- M0 能力探针：[`probes/README.md`](probes/README.md)

## 快速开始

```bash
pnpm install
pnpm dev      # 启动桌面应用
pnpm check    # 提交前必跑
```

当前进度：**M2 进行中**。M1 单 Agent 闭环已完成：IM 界面里和 Claude Code 对话，流式输出、思考过程、工具调用（含子代理嵌套）、权限卡片、排队、停止，会话持久化，重启后核对状态。M2 已完成 worktree 隔离（ADR 0006）：git 仓库中的会话默认在独立 worktree 运行，同一目录只允许一个 direct 会话。Codex 和 pi 适配器开发中。

```bash
NEXUS_FAKE_HARNESS=1 pnpm dev   # 加一个不消耗额度的演示 harness
pnpm e2e:smoke                  # 端到端冒烟测试
```
