# 构建与发布指南

## Mac 构建（本地）

```bash
pnpm tauri:build:universal
```

同时编译 arm64 (Apple Silicon) 和 x86_64 (Intel)，合并为通用二进制。

产物路径：
```
src-tauri/target/universal-apple-darwin/release/bundle/dmg/007-Desk-universal.dmg
```

## Windows 构建（GitHub Actions）

```bash
pnpm deploy:github
```

将代码推送到 GitHub，自动触发 Actions 构建 Windows 安装包（`.github/workflows/build-windows.yml`）。

产物在 GitHub Actions 的 Artifacts 中下载：
- NSIS 安装包：`src-tauri/target/release/bundle/nsis/*.exe`
- MSI 安装包：`src-tauri/target/release/bundle/msi/*.msi`

也可在 Actions 页面手动触发构建（workflow_dispatch）。
