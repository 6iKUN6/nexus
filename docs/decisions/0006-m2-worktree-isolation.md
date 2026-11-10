# 0006 M2 Worktree 隔离：应用数据目录 + detached HEAD

日期：2026-11-10 · 状态：已采纳

## 背景

M1 的会话直接在用户选择的目录里运行，agent 的写操作直接生效。计划要求 M2 起可写任务默认在独立 worktree 中运行（§10.5：同一工作目录单写者；pi 没有权限门控，必须隔离）。需要确定 worktree 的存放位置与生命周期（计划留到 M2 决定）。

## 决策

1. **会话增加 `isolation: 'direct' | 'worktree'`**。工作目录是 git 仓库时新建会话默认选 worktree；非 git 目录只能 direct，界面说明原因。
2. **worktree 放在应用数据目录**：`<userData>/worktrees/<conversationId>/`，不放仓库的 `.nexus/` 里。理由：不污染用户仓库、不需要改用户的 .gitignore；worktree 本来就是 git 的一等公民，放在仓库外完全可行。
3. **`git worktree add --detach <path> HEAD`**，detached HEAD，不创建分支（不污染用户的分支列表），不碰主 checkout（主目录有脏文件也互不影响）。用户在仓库子目录上建会话时，worktree 建在整个仓库根，再拼接相对子目录作为实际 cwd。
4. **同一 cwd 只允许一个 direct 会话**：再建同名 direct 会话直接报错（`CwdInUse`），提示改用 worktree。worktree 会话之间天然隔离，不受限。
5. **M2 不做 worktree 清理**：任务结束后 worktree 保留供查看产物；删除入口（以及合并/对比）在后续版本提供。详情面板明确标注运行位置。

## 影响

- `Conversation` 增加 `isolation` 与 `baseCwd`（用户原本选择的目录）；`cwd` 始终是实际运行目录，适配器无需感知隔离方式。
- 新增 RPC `path.inspect`，新建会话对话框用它判断是否为 git 仓库、是否已有 direct 会话占用。
- 数据库迁移 v2：conversations 表加 `isolation`（默认 direct）与 `base_cwd` 两列，存量会话全部为 direct，行为不变。
- 删除会话/清理 worktree 时需要级联删除目录——列入 M5 稳定性清单。
