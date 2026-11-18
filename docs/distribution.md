# 分发：签名与公证（macOS）

v0.2 内测暂缓签名（2026-11-18 决定）：`pnpm pack:mac` 产出未签名 `.app`，首次打开用「右键 → 打开」。本文是证书到位后的操作手册。

## 前提

- Apple Developer Program 账号（付费）与 Team ID。
- 一份 **Developer ID Application** 证书（在钥匙串里，或导出为 `.p12`）。
- 公证凭证，二选一：
  - App Store Connect API key（`APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER`），或
  - Apple ID + app-specific password（`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`）。

## 打开签名

`packages/desktop/electron-builder.yml` 的 `mac` 段改为：

```yaml
mac:
  category: public.app-category.developer-tools
  icon: build/icon.icns
  target:
    - dmg
    - zip
  hardenedRuntime: true
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  notarize: true
  # identity 删除（自动从钥匙串/CSC_LINK 发现 Developer ID Application）
```

证书不在本机钥匙串时用环境变量：`CSC_LINK`（p12 路径或 base64）、`CSC_KEY_PASSWORD`。

## 验证清单

1. `pnpm pack:mac` 后 `codesign -dv --verbose=4 release/mac*/Nexus.app` 显示 Developer ID。
2. `spctl -a -vv release/mac*/Nexus.app` 显示 `accepted source=Notarized Developer ID`。
3. 在一台**没有开发环境**的 Mac 上从 dmg 安装并启动，确认 Gatekeeper 不拦截、能检测到本机 CLI。

## 国内网络

electron-builder 要从 GitHub Releases 下载 Electron 包体，直连容易在 100% 处挂起
（`Timeout awaiting 'request'`）。用 npmmirror 镜像即可：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm pack:mac
```

## 注意

- appId 是 `io.github.6ikun6.nexus`，v0.2 前从占位符改过来的；**签名发布后不要再改**，否则用户钥匙串条目与自动更新标识全部失效。
- 公证要求所有 Mach-O 都签名；`better-sqlite3` 的原生模块与 `nexus-helper` 会随 asarUnpack 一起被 electron-builder 处理，不要在打包后手工改动 .app 内容。
