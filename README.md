# Desktop Dock 项目操作说明

> Tauri v2 桌面应用（007 Desk），Rust 后端 + Vite/TypeScript 前端，支持 macOS 和 Windows。打包成 mac 和 windows 的桌面应用 desk 程序。

## 1. 环境要求

| 依赖 | 版本要求 |
|------|----------|
| Node.js | v20 LTS |
| pnpm | v8 |
| Rust | stable（通过 rustup 安装） |

### macOS 额外要求
- Xcode Command Line Tools

### Windows 额外要求
- Visual Studio Installer：勾选「Desktop development with C++」、MSVC v143 (x64)、Windows 10/11 SDK
- Rust target：`rustup target add x86_64-pc-windows-msvc`

## 2. 安装依赖

```bash
pnpm install
```

## 3. 启动开发

```bash
pnpm tauri:dev
```

- 自动启动 Vite 开发服务器（端口 **5173**），然后打开原生桌面窗口
- 支持热重载

仅启动前端（不打开桌面窗口）：

```bash
pnpm dev
```

## 4. 构建打包

### 4.1 仅构建前端

```bash
pnpm build
```

- 产物目录：`dist/`

### 4.2 macOS 构建

**当前架构构建（Apple Silicon 或 Intel，取决于本机）：**

```bash
pnpm tauri:build
```

**通用二进制（Universal，同时支持 Apple Silicon + Intel）：**

```bash
pnpm tauri:build:universal
```

该脚本自动执行：
1. 编译 `aarch64-apple-darwin`（Apple Silicon）
2. 编译 `x86_64-apple-darwin`（Intel）
3. 用 `lipo` 合并为通用二进制
4. 用 `hdiutil` 生成 DMG

**产物路径：**

| 类型 | 路径 |
|------|------|
| .app（单架构） | `src-tauri/target/release/bundle/macos/007 Desk.app` |
| .dmg（单架构） | `src-tauri/target/release/bundle/dmg/007 Desk_0.1.0_aarch64.dmg` |
| .app（通用） | `src-tauri/target/universal-apple-darwin/release/bundle/macos/007 Desk.app` |
| .dmg（通用） | `src-tauri/target/universal-apple-darwin/release/bundle/dmg/007-Desk-universal.dmg` |

### 4.3 Windows 构建

> 当前项目正在使用 GitHub Actions CI 构建 Windows 版本（无需本地 Windows 环境）。

**方式一：GitHub Actions CI（当前使用 ✅）**

执行以下命令，将代码推送到 GitHub 的 `main` 分支即可触发 Windows 构建：

```bash
pnpm deploy:github
```

> `deploy:github` 会把 `main` 分支推送到 `package.json` 里 `deploy:github` 写明的 GitHub 仓库地址，推送后自动触发 `.github/workflows/build-windows.yml`，在 `windows-latest` runner 上构建。
>
> ⚠️ `package.json` 中默认是**示例地址** `https://github.com/your-username/your-repo.git`，使用前需替换为你的真实仓库地址（直接改 `package.json` 中 `deploy:github` 对应的 URL 即可）。

构建流程：
- 文件：`.github/workflows/build-windows.yml`
- 触发条件：推送 `main` 分支 / PR 到 `main` / GitHub Actions 页面手动触发（`workflow_dispatch`）
- 构建机器：`windows-latest` runner

**方式二：Windows 虚拟机（备选）**

参考 `trauri_win_build.md`，在 Parallels Desktop 等 Windows 虚拟机中执行：

```bash
pnpm tauri:build
```

**产物路径：**

| 类型 | 路径 |
|------|------|
| NSIS 安装包 (.exe) | `src-tauri/target/release/bundle/nsis/*.exe` |
| MSI 安装包 (.msi) | `src-tauri/target/release/bundle/msi/*.msi` |
| 独立 exe | `src-tauri/target/release/*.exe` |

### 4.4 Linux 构建

当前未配置 Linux 构建目标。如需支持，需在 `src-tauri/tauri.conf.json` 的 `bundle.targets` 中添加 `"deb"` 和/或 `"appimage"`，并在 Linux 主机上运行 `pnpm tauri:build`。

## 5. CI/CD

项目包含两个 GitHub Actions workflow：

| Workflow | 触发条件 | 构建平台 |
|----------|----------|----------|
| `build.yml` | 推送 `v*` 标签 / 手动触发 | macOS Universal + Windows |
| `build-windows.yml` | 推送 `main` / 手动触发 | 仅 Windows |

CI 使用 GitHub Secrets：
- `TAURI_PRIVATE_KEY` — Tauri 更新签名密钥
- `TAURI_KEY_PASSWORD` — 签名密钥密码
