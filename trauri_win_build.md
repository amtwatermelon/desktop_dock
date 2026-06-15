# Tauri：在 Mac（Apple Silicon）上打包 Windows x64 可安装 exe

目标：
在 macOS（M 系列芯片）上，通过 Windows 虚拟机，
生成 **可在所有主流 Windows 电脑安装的 x64 exe（Tauri）**

约束：
- macOS 无法原生打包 Windows 安装器
- 必须使用 Windows 环境
- 最终目标架构：x86_64-pc-windows-msvc

---

## Step 1：在 Mac 上创建 Windows 虚拟机

- 安装 Parallels Desktop（最新版）
- 新建虚拟机
- 操作系统：**Windows 11 ARM64**
- 说明：Apple Silicon 无法安装 Windows x64，这是正常限制

---

## Step 2：Windows 虚拟机内准备构建环境

在 Windows 虚拟机中安装以下软件：

1. Node.js（LTS）
2. pnpm 或 npm
3. Rust（通过 rustup）
4. Visual Studio Installer

Visual Studio 中必须勾选以下组件：
- Desktop development with C++
- MSVC v143（x64）
- Windows 10 / 11 SDK

---

## Step 3：配置 Rust 目标架构（关键步骤）

在 Windows 终端中执行：

```bash
rustup target add x86_64-pc-windows-msvc
