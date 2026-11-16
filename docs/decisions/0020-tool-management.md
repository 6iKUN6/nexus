# 0020 工具与拓展管理（D23）

日期：2026-11-16。状态：已接受。范围经两位开发者确认：MCP 管理 + Claude 注入、pi 拓展列表 + 装卸、pi bridge 原生协作工具、Codex 注入 probe（单独确认配额）。

## 背景

计划 §7 只给了"只读展示 harness 配置"。落地后真实需求更具体：用户想在 Nexus 里给会话挂自己的 MCP server（如 filesystem、github），不想手改每个 harness 的配置文件；pi 没有 MCP，但它有自己的 extension 生态。三个 harness 的工具协议完全不同（Claude=SDK `mcpServers`，Codex=config.toml/app-server 未验证，pi=无 MCP 但有 extension），D23 把它们收敛成统一管理界面。

## 决定

### 1. 用户侧 MCP server（Nexus 自有配置）

- 存储在 core 的 SQLite（migration v7，`mcp_servers` 表）：`id / name / command / args[] / env{} / enabled / 时间戳`。**v1 只支持 stdio**（本地命令覆盖绝大多数场景；http/sse 后移）。
- **密钥不落库**：env 值允许 `${VAR}` 占位符，会话创建时才从进程环境解析；GUI 应用没有 shell 环境，core 启动时用 login shell 抓取一次环境（沿用 `resolveLoginShellPath` 的模式）缓存内存中。占位符无法解析时该变量置空并在 UI 标注。诊断导出只含占位符名，天然安全。
- 粒度：**全局列表 + 按会话勾选**。`Conversation.enabledMcpIds: string[]`（默认空），`conversation.configure` 扩展。已运行会话不热加载，下次 run 生效。
- 注入走 D14 管道：`CreateSessionOptions.mcpServers`（env 已解析），Claude adapter 合并进 SDK `mcpServers`，key 用 `nx_<id前8位>` 防注入/防与 `nexus` 冲突，不用用户输入的 name。Codex 待 probe（见 §4）；pi 无 MCP，UI 如实标注。

### 2. pi 拓展列表 + 装卸

- 列表 = 读 settings JSON：用户级 `~/.pi/agent/settings.json` 的 `packages[]` + 项目级 `<cwd>/.pi/settings.json`（worktree 会话读到的 worktree 副本；`.pi` 未提交则项目级为空，UI 注明）。
- 装卸 = spawn pi CLI（`pi install|remove <source>`，argv 数组、检测到的 executablePath、120s 超时、输出尾部用于报错）。**v1 装卸只管用户级**；项目级在 worktree 里写 `.pi/settings.json` 容易误导（worktree 是一次性的），UI 标注"项目级请在终端管理"。
- 资源级开关（`pi config` TUI 的能力）不做，格式未 probe。
- RPC 模式限制沿用现有 limitation：拓展的交互 UI 请求被忽略；改动 settings 后已运行会话不生效。

### 3. pi bridge：原生协作工具

core 为每个 pi 会话生成 `<userData>/bin/nexus-bridge.ts`（pi extension：默认导出函数，`pi.registerTool` 注册六个协作工具，参数 schema 用普通 JSON Schema 字面量，execute 直接走 NDJSON socket 认证调用），spawn 时加 `-e <path>`。取代委派 brief 里的 `$NEXUS_HELPER_PATH` 文本提示（brief 不再写协作命令段）。`-e` 是显式加载，与 `--no-extensions` 的用户设置正交。

### 4. Codex MCP 注入

`InitializeCapabilities` 里只有 MCP elicitation 扩展，没有注入点；config.toml 是全局的。跑一个配额 probe：app-server initialize/newConversation 是否接受 per-session `mcpServers`。**未验证前 Codex 侧 UI 如实显示"待验证"**，不伪造。probe 场景执行前再与开发者确认。

## 后果

- 用户在 Agents 视图管理 MCP server 和 pi 拓展；会话详情面板勾选本会话启用的 MCP server。
- protocol 新增 `mcpServerConfigSchema` 与 `mcp.list/upsert/remove`、`pi.extension.list/install/remove`；`Conversation` 增 `enabledMcpIds`——已获两位开发者同意（本 ADR）。
- 用户的 MCP server 是任意本地命令：UI 明示"server 进程以会话权限运行"，沿用 harness 纯血原则（只做增量注入，不代理不拦截）。
