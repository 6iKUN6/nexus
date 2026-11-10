# Contributing

Nexus 目前是个人项目，欢迎通过 **fork + Pull Request** 参与。

## 流程

1. Fork 本仓库，从 `main` 开分支。
2. 本地 `pnpm install`，改完后 **`pnpm check` 必须通过**（lint、typecheck、包边界规则、单元测试，与 CI 完全一致）。
3. 涉及协议层（`packages/protocol`）的改动请先开 issue 说明——它是所有层之间的契约。
4. 提交 PR。**只接受来自 fork 的 PR**，本仓库内的分支 PR 会被 `fork-only` 检查拦下。

## 约定

- Conventional Commits：`feat(core): …`、`fix(ui): …`、`docs: …`、`test: …`、`refactor: …`
- 一个 PR 只做一件事，diff 保持可审阅
- 状态机、队列、存储、适配器的改动必须带测试；纯样式不需要
- 改动某模块前先读 `docs/decisions/` 里对应的 ADR
- 架构、边界规则、UI 规范见 [`AGENTS.md`](AGENTS.md)
- 真实 CLI 的契约测试（`pnpm test:contract`）会消耗模型额度，不在 CI 运行，也不会要求你跑

## 安全

不要提交 `.env`、API key、token 或任何凭据。测试用的 harness 录制样本要清除主机路径与账号信息后再提交（见 AGENTS.md「Testing」）。
