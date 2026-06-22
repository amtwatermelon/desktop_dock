# 构建与发布指南

## Mac 构建（GitHub Actions 远程）

> GitHub Actions **仅在仓库托管在 github.com 时**会自动运行。

**GitHub 仓库：** https://github.com/xuyabin88-prog/dock.git

```bash
# 首次（远程已添加为 github 时可跳过 add）
git remote add github https://github.com/xuyabin88-prog/dock.git
git push -u github master

# 之后更新
pnpm deploy:github
# 或
git push github master
```

3. 打开 GitHub 仓库 → **Actions** → **Build macOS DMG**
4. 点击 **Run workflow** 手动触发，或推送 `master` 后自动触发
5. 构建完成后，在 Run 页面底部 **Artifacts** 下载 `007-desk-macos-dmg`

本地无需 Mac 环境；构建在 GitHub 的 `macos-latest` 机器上执行。

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
