# 0019 协作工具 open_preview

日期：2026-11-16。状态：已接受，已实现。2026-11-16 修订：外部地址见文末。修订 ADR 0016 的工具清单（5 → 6）。

## 背景

预览面板（ADR 0014）只有两个入口：头部开关手动输地址、点消息里的 localhost 卡片。agent 启动了一个 dev server 后没法请用户"看一眼效果"，只能在文本里贴地址。

## 决定

- 协作工具增加 `open_preview { url ≤500 }`，白名单与预览面板共用 `normalizeLocalUrl`（仅 localhost / *.localhost / 127.0.0.1 / [::1]），远端地址直接报错。
- 调用只追加 `preview.requested { url }` 事件，**永不自动打开**：时间线渲染确认卡片（打开预览 / 在浏览器打开），点击才生效；卡片保持可点，可重复打开。
- 不增加 resolve 事件：打开是幂等的视图动作，不需要确认状态（与 handoff.requested 卡片同款）。

## 后果

- agent 可以说"跑起来了，帮我打开预览"，用户在卡片上点一下即可；不打开没有任何副作用。
- 工具定义 token 成本 +1 个紧凑 schema；速率限制（30 次/分钟）兜底骚扰。

## 修订（2026-11-16）：外部 http(s) 地址

原决定里远端地址直接报 `InvalidUrl`，agent 只能在文本里解释。现在 `open_preview` 接受任何合法 http(s) 地址并照常记录 `preview.requested`；**webview 白名单不变（ADR 0014）**，变化只在确认卡片上：

- 本机地址：「打开预览」+「在浏览器打开」，与之前一致；
- 外部地址：只显示「在浏览器打开」（系统默认浏览器，经主进程 `shell.openExternal`），并注明内置预览仅支持本机地址。

预览面板地址栏同款：输入外部地址不加载 webview，但提供「在默认浏览器打开」按钮。非 http(s) 协议（file:、javascript: 等）仍报 `InvalidUrl`。
