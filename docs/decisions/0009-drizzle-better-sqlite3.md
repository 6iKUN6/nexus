# 0009 数据层：better-sqlite3 + Drizzle ORM

日期：2026-11-10。状态：已接受。修订 ADR 0005 第 3 条（持久化驱动）。

## 背景

M1 用 Node 内置的 `node:sqlite`（`DatabaseSync`）持久化（ADR 0005 第 3 条），理由是"不需要针对 Electron 重编译原生模块，打包更简单"。M3 之后 `store.ts` 里手写 SQL 与手写行映射开始堆积：`SELECT *` 加 `as Row` 断言，列名与领域字段靠人眼对齐，加一列而忘了改映射不会报错。希望换成类型安全的查询层。

约束：`node:sqlite` 没有 Drizzle 驱动（Drizzle 只支持 better-sqlite3 / bun / libsql / expo 等），Kysely 需要第三方 `node:sqlite` dialect（现有几个包月下载量 137–1782，维护风险高）。所以"保留 node:sqlite"与"用成熟 ORM"不能兼得。

## 决定

换用 **better-sqlite3 13 + Drizzle ORM 0.45**（`drizzle-orm/better-sqlite3`）。

- **ADR 0005 的前提已不成立**：better-sqlite3 13 发布时自带 Node-API（napi）预编译二进制，`prebuilds/{darwin,linux,linuxmusl,win32}-{arm64,x64}.node`，`gypfile: false`，安装时没有任何编译脚本。实测在 Electron 45.2.3（Node 24.22.2、napi 10）的 utilityProcess 中直接 `require` 即可打开数据库，无需 `@electron/rebuild`。
- **仍不引入编译步骤**：`pnpm-workspace.yaml` 的 `allowBuilds` 显式写 `better-sqlite3: false`（pnpm 11 的默认拦截照旧生效，只是不再告警）。
- **打包**：better-sqlite3 是唯一原生模块，放进 `desktop` 的 `dependencies` 以便 electron-vite 外部化；electron-builder 会把它解包到 `app.asar.unpacked`。已用 `pnpm pack:mac` 打包并启动验证：打包后的 .app 能建库并迁移到 `user_version = 3`。Drizzle 是纯 JS，随 core 打进 `core.js`，不额外打包。
- **表定义在 `store/schema.ts`（Drizzle sqliteTable）**，列用 `$type<HarnessId>()` 等绑定 protocol 的联合类型。行类型 `$inferSelect` 与 `Conversation` / `Task` 同构，`toConversation(row): Conversation` 的签名让"加列忘改映射"变成编译错误。
- **迁移仍是手写 SQL**（`store/migrations.ts`，`PRAGMA user_version` 推进）。两张表的本地单写库不需要 drizzle-kit 的快照体系，手写迁移在一个文件里可审阅。Drizzle 只负责查询构建。
- 事务用 `db.transaction(fn, { behavior: 'immediate' })`，保持 M1 的 `BEGIN IMMEDIATE` 语义（先拿写锁）。

## 后果

- 删除 `node:sqlite` 依赖；`store.ts` 不再出现 SQL 字符串（迁移文件除外）。
- 新增 store 测试：迁移路径（用冻结的 v1 schema 建库再打开）、非法事件行跳过、inbox 去重与优先级、任务状态更新。
- 平台支持面从"Node 自带"变成"better-sqlite3 提供了 prebuild 的平台"（8 个组合，覆盖 macOS/Linux/glibc/musl/Windows × arm64/x64）。
- 未来若引入 WebUI（core 仍在 Node/Electron 中跑）不受影响；若真要在浏览器里跑 core（ADR 0003 并未承诺），则需换成 libsql / sql.js 驱动，但 Drizzle 的查询层与 schema 可直接复用。
