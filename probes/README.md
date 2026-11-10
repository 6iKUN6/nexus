# M0 能力探针

一组一次性脚本，用来在写适配器之前记录各 harness 的**真实行为**。它们不随应用发布。

## 运行

```bash
pnpm probe                                    # 免费：所有 harness 的 --version / --help
pnpm probe claude-code --scenario basic --yes  # 会调用模型，消耗额度
pnpm probe codex pi -s tool -s cancel --yes
pnpm probe all --scenario all --yes            # 全部场景（四个 harness 共 7 个场景）
pnpm probe selftest -s all --yes               # 验证探针本身：伪 harness，不消耗额度
pnpm probe:report                              # 汇总最近一次结果，输出 markdown 表格
pnpm --filter @nexus/probes probe:m2 codex --yes   # M2 侦察：codex app-server 全双工录制（耗额度）
pnpm --filter @nexus/probes probe:m2 pi --yes      # M2 侦察：pi --mode rpc 全双工录制（耗额度）
```

M0 结果写入 `probes/output/<harness>/<scenario>/<时间戳>/`（已加入 gitignore）：

- `turn-N.stdout.jsonl` / `turn-N.stderr.log`：原始输出

M2 侦察（`src/appserver.ts`，独立运行器）录制长连接协议的双向流量（`wire.jsonl`，方向+时间戳）：
codex 为 initialize → thread/start → turn/start →（审批/中断/续传），pi 为 get_state → prompt →（写文件/abort）。
脱敏后复制为适配器 fixtures（`packages/adapters/<name>/fixtures/`）。
- `help.*.txt`：CLI 帮助和版本信息
- `summary.json`：自动观察项，包括退出码、耗时、首次输出延迟、JSON 行占比、事件类型统计、session id、取消过程、残留进程

每次运行都在一个新建的临时目录中进行（`hello.txt` + `git init`），不会碰到你的真实仓库。

## 场景

| 场景 | 验证内容 | 消耗额度 |
|---|---|---|
| help | CLI 参数和版本 | 否 |
| basic | 单轮结构化流式输出 | 是 |
| chinese | 中文与长输出 | 是 |
| tool | 读文件这类工具调用产生的事件 | 是 |
| permission | 需要授权的写操作：会不会发出请求，被拒绝后产生什么事件 | 是 |
| cancel | 中途取消：向进程组发 SIGINT，必要时升级信号，并检查残留子进程 | 是 |
| resume | 同一会话的两轮对话 | 是 |

第一轮只测**无界面（headless）的 CLI 模式**。第二轮在设计适配器时测长连接协议：Claude Agent SDK、`codex app-server`（可用 `codex app-server generate-ts --out <dir>` 生成协议类型）、`pi --mode rpc` / `pi-acp`。

## 产出

看完原始输出后，把每个场景的结论（支持 / 降级 / 不支持）和固定的测试版本号填进 [`MATRIX.md`](MATRIX.md)。有代表性的输出复制到对应适配器的测试 fixtures 中。

## DeepSeek Harness

本机未安装时 `help` 会显示“未安装”。安装后先运行 `pnpm probe dsh`，读一下 `help.--help.txt`，再在 `src/harnesses.ts` 里补上 `buildTurnArgs`。
