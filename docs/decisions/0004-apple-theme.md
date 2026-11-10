# 0004 苹果风格主题与外观设置

日期：2026-11-07 · 状态：已采纳

## 背景

团队希望界面采用苹果（macOS）风格，并支持浅色、深色、跟随系统三种外观。组件库已经定为 Arco。

## 决策

- **在 Arco 之上做主题，不换组件库**。覆盖 Arco 的 CSS 变量：
  - `theme/applePalette.css`：用苹果系统色（systemBlue / Green / Orange / Red，浅色和深色各一套）生成 Arco 的 10 级色阶；
  - `theme/appleTheme.css`：表面色、文字、分隔线、圆角，以及 13px 的 SF 字体（`-apple-system`），并微调 Arco 按钮和分段控件的样式。
  - 两个文件都不放进任何 CSS 层，这样才能压过 Arco。语义色统一映射成 Tailwind token，见 `styles/global.css`。
- **外观偏好**：`useThemePreference` 支持 `system | light | dark`，保存在 localStorage。首帧渲染前先读出偏好并应用（`applyStoredThemeEarly`），避免闪烁。
- **原生外观同步**：界面通过 `Platform.setNativeTheme` → preload → `ipcMain('nexus:set-theme')` 设置 `nativeTheme.themeSource`，这样毛玻璃、红绿灯按钮和右键菜单都会跟着应用内的选择变化。主进程会校验调用方必须是应用自己的页面，参数必须在白名单内。
- **macOS 侧边栏毛玻璃**：窗口使用 `vibrancy: 'sidebar'`，背景透明，内容区保持不透明。设置 `NEXUS_VIBRANCY=0` 可以关闭毛玻璃（CDP 截图拍不到毛玻璃，透明区域会变黑），在非 macOS 平台上也会退回纯色。

## 影响

- 颜色只能使用 token（`surface / elevated / sidebar / fg / line / tint / brand / ok / warn / bad / sys-*`），不能写十六进制颜色，也不能用 Tailwind 调色板。
- Arco 的 Trigger（Tooltip、Dropdown 等弹层）在 React 19 下要求子元素是能拿到 ref 的 DOM 元素或 Arco 组件，因为 React 19 已经移除了 `findDOMNode`。不能把 Tooltip 直接包在 `Radio` 这类组件外面。
- Tab 栏属于 Arco 无法做成 Safari 样式的场景，所以自己实现了 `role="tablist"`，包括方向键导航。这是"交互元素只用 Arco"规则的一个明确例外。

## 补充：品牌标志（2026-11-07）

- 标志源文件在 `assets/logos/`（Relay v0.1，由设计方维护），颜色为深墨绿 `#172924`、薄荷绿 `#70E3B0`、纸白 `#F4F5EF`。
- 界面里的标志是内联 SVG 组件，用 `currentColor` 着色：浅色模式显示深墨绿，深色模式显示纸白。没有直接引用 PNG，这样标志能跟随主题变化，并且任何尺寸都清晰。
- 应用图标（`.icns`）和 favicon 由 `pnpm brand` 根据 `nexus-app-icon.svg` 生成。
- 界面的强调色仍然用苹果的 systemBlue，薄荷绿只用在品牌元素上。如果以后要改成以品牌色为强调色，只需修改 `applePalette.css` 中的 `primary` 色阶。
- 该标志目前是设计概念，尚未做商标检索（见 assets/logos/README.md）。
