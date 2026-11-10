# 0003 界面：React 19 + Arco Design + Tailwind v4（仅布局）

日期：2026-11-07 · 状态：已采纳

## 背景

团队选定 Arco 作为组件库，同时希望用工具类快速搭布局。两者的基础样式和颜色体系可能冲突，Arco 在 React 19 下也需要适配。

## 决策

- 交互元素统一使用 Arco 组件。入口要先引入 `@arco-design/web-react/es/_util/react-19-adapter`（封装在 `@nexus/ui/setup` 中）。
- Tailwind v4 只引入 `theme` 和 `utilities`，**不引入 preflight**。CSS 层顺序为 `theme, arco, components, utilities`，这样工具类能覆盖 Arco 的样式。
- 颜色只用映射到 Arco 变量的语义色：`surface / fg / line / tint / brand / ok / warn / bad`。不能用十六进制颜色或 Tailwind 调色板。暗色模式通过 `arco-theme` 属性跟随系统设置。
- 代码检查用 Biome，并开启 Tailwind 指令解析。

## 影响

- 暗色模式和主题定制都在 Arco 变量这一处完成。
- AionUi 也是 React 19 + Arco 的组合，遇到问题可以对照它的实现。
