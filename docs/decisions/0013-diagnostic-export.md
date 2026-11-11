# 0013 诊断包导出

日期：2026-11-11。状态：已接受。

## 背景

Nexus 是 local-only 应用，没有遥测、没有崩溃上报。用户遇到问题时（内测、开源后的 issue），我们手里没有任何材料：状态机停在哪个事件、适配器报了什么错、detected harness 是什么版本，全靠猜。打包后的应用又没有终端接着 stderr，这些信息在发生的那一刻就丢了。计划 §10.5 要求"可导出诊断包（默认不含密钥）"。

## 决定

`diagnostics.export` 由一个 RPC 方法生成一个**普通目录**（不引 zip 依赖），写在 `<userData>/diagnostics/nexus-diagnostics-<时间戳>/`：

- `meta.json`：版本、平台/架构、DB schema 版本、导出时间。
- `harnesses.json`：检测结果（安装、版本、认证状态），路径中的 `$HOME` 改写为 `~`。
- `config.json`：并发上限、数据库路径（同样改写）。
- `conversations/<id>.jsonl`：事件日志原文；默认导出全部会话，可按会话筛选。
- `logs.txt`：最近 500 行 `console.error/warn`（新增的环形缓冲，tee 实现，不改现有调用点）。

**脱敏是导出路径的强制步骤，不是选项。** token 形状的模式（`sk-*`、`AIza*`、GitHub/Slack token、AWS key、Bearer、私钥块）与 `KEY|TOKEN|SECRET|PASSWORD` 形式的 `.env` 赋值在写盘前替换为 `<redacted>`；返回值只报告脱敏条数，不报告内容。导出只在用户主动点击时发生，"在 Finder 中显示"由 main 校验路径必须位于 userData 之下。

## 后果

- 用户报障时能提供可复现的材料，且分享前可以自己检查目录内容。
- 脱敏是模式匹配，不是保证：不匹配任何模式的秘密仍可能被导出。因此诊断包定位为"用户在分享前审查过的产物"，不是自动上报。
- 环形缓冲在内存里保留最近 500 行错误，内存占用可忽略；它同时让打包版的错误在日志里可见。
