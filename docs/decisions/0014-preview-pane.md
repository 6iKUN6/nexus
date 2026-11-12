# 0014 内嵌 dev server 预览面板

日期：2026-11-12。状态：已接受。

## 背景

agent 做前端任务时的回路是：改代码 → dev server 热更新 → 用户切到浏览器检查 → 回到会话反馈。worktree 隔离下多个会话各起一个 dev server，"哪个端口属于哪个会话"成为真实负担（`localhost:5173/5174/5175`）。需要一个低成本的预览集成。

明确不做的事：computer use 不在任何 CLI 的工具集里（它是 Anthropic API 的 beta 工具），Nexus 不提供也不伪造；通用内嵌浏览器不做——用户自己的浏览器有扩展、登录态和 DevTools，内嵌 webview 永远更差。

## 决定

右侧可收起的**预览面板**，按会话绑定一个 dev server URL：

- 消息正文里的本机地址（`localhost:5173` 等）渲染成可点击的 chip，点击即把该地址装进预览面板并打开；地址也持久化在 UI 状态里，重启后还在。
- 面板工具栏只有：地址输入、刷新、在浏览器中打开、关闭。不做标签页、不做历史、不做书签——它是预览工具，不是浏览器。
- **只加载本机地址**：`normalizeLocalUrl`（protocol 共享）只放行 localhost / `*.localhost` / 127.0.0.1 / ::1 的 http(s)。UI 校验一次，main 进程在 `web-contents-created` 里对 guest 再拦一次（will-navigate 阻止非本机；弹窗中的本机地址在 guest 内加载，https 走外部浏览器）。
- 渲染进程开 `webviewTag: true`；guest 用 `persist:preview` 分区（dev server 的 cookie/localStorage 跨重启保留），默认无 nodeIntegration，与 Nexus 渲染器完全隔离。
- 主窗口的 `setWindowOpenHandler` 放行本机 http 地址（"在浏览器中打开"入口），其余仍只放行 https。
- WebUI 外壳没有 `<webview>`：UI 通过 `Platform.webPreview` 能力标志降级为仅"在浏览器中打开"。
- 端口自动探测（枚举会话进程组的监听端口）留作后续增强，届时需要 core 侧新 RPC。

## 后果

- 渲染器的攻击面扩大了一个受控的 guest 进程；本机白名单把"agent 诱导用户在面板里打开钓鱼页"这类提示注入路径挡在外面。dev server 是半可信内容——它跑在隔离分区里，拿不到 Nexus 的任何桥。
- `*.localhost` 子域放行（RFC 6761），某些框架用它做多租户预览。
- 面板宽度固定 440px，与详情面板可同时打开；窄窗口下用户自己取舍。
