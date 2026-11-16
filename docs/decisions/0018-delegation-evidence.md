# 0018 委派证据与父任务回流（D16）

日期：2026-11-16。状态：已接受，已实现（父 agent 回流经确认为拉取式）。协议增量：`task.evidence` RPC、`read_task_context` 增加 `children`。

## 背景

M3（ADR 0008）已有：用户发起委派、子任务状态机、结果进用户收件箱与父会话卡片。D14/D15 补齐了 agent 主动协作与投递。D16 收口两件事：**子结果回到父任务**（父 agent 也能拿到，不只是用户）与**证据可打开**（验收时能看见子任务到底改了什么）。

## 决定

### 证据：按需计算，不落库

新 RPC `task.evidence { taskId }`，从子会话 worktree 现算（复用 `captureWorkspace` 的思路，走同一个注入的 `gitRun`）：

```
{
  available: boolean,          // worktree 还在且是仓库
  problem: string | null,      // 不可用时说明原因
  baseCommit: string | null,
  files: [{ path, status: added|modified|deleted, added, deleted }],  // numstat
  untracked: [path],           // 密钥文件（.env 等）只报“已省略 N 个疑似密钥文件”
  diff: string | null,         // 统一 diff，超长截断（与交接包同一上限）
  diffTruncated: boolean,
}
```

不落库的原因：证据是“现在的样子”，存下来只会过期；worktree 被清理（Tier 3 才会有清理 UI）后返回 `available: false` 并说明。查看证据是本地行为，diff 内容不脱敏（与交接包一致：只隐藏疑似密钥文件名）。

### 子结果回到父 agent：拉取，不推送

`read_task_context` 结果增加 `children: [{ taskId, goal, status, summary }]`（仅 role=parent 时有内容）。父 agent 想知道子任务进展时自己查——**不自动向父会话投递提示词**，因为那会启动一次 run、消耗额度，违背“不盲目制造模型调用”的一贯原则。用户侧回流（收件箱、task.updated 事件、委派卡片）已有，不动。

### UI

委派卡片新增“查看改动”：展开文件清单（路径 + 增删行数徽标 + 新增文件）与截断的统一 diff（等宽、可选中）；不可用时显示原因。验收通过/退回入口不变。

### 不做的事

- 委派深度仍为一层（ADR 0016 曾写“默认 3”，v0.1 收紧为 1，本 ADR 覆盖该表述）。
- 不合并子 worktree 回主目录（合并/清理是 Tier 3 的 worktree 管理 UX）。

## 后果

- 验收子任务时不必切到子会话翻日志，直接在卡片里看到文件级改动与 diff。
- 父 agent 通过既有工具拿结果，零额外模型调用；协议只加只读增量。
