# 构建与发布指南

## Windows 构建（GitHub Actions）

Windows 安装包通过 GitHub Actions 构建，推送 `master` 后自动触发，产出 NSIS `.exe` 与 MSI `.msi`。

GitHub 仓库：`git@github.com:amtwatermelon/desktop_dock.git`

```bash
# 首次推送（remote 已添加为 github）
git push -u github master

# 之后每次更新
pnpm deploy:github
# 或
git push github master
```

- 推送后自动触发 `.github/workflows/build-windows.yml`，也可在仓库 **Actions** 页面点 **Run workflow** 手动触发。
- 构建完成后，在 Run 页面底部 **Artifacts** 下载 `windows-installer`：
  - NSIS 安装包：`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe`
  - MSI 安装包：`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/*.msi`

> 仅 Windows 在 Actions 上构建；macOS 在本地构建。

## macOS 构建（本地）

```bash
pnpm tauri:build:universal
```

同时编译 arm64 (Apple Silicon) 和 x86_64 (Intel)，合并为通用二进制。

产物路径：

```
src-tauri/target/universal-apple-darwin/release/bundle/dmg/007-Desk-universal.dmg
```
