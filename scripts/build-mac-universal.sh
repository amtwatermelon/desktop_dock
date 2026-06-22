#!/usr/bin/env bash
set -euo pipefail

# 构建 arm64 和 x86_64 两个架构的 Tauri 应用
# CI / 本地统一通过 pnpm exec 调用 tauri CLI

run_tauri() {
  pnpm exec tauri "$@"
}

echo "[1/4] Building arm64 (M-chip) app..."
run_tauri build --target aarch64-apple-darwin

echo "[2/4] Building x86_64 (Intel) app..."
run_tauri build --target x86_64-apple-darwin

# 路径变量（注意 productName: 007 Desk）
APP_NAME="007 Desk.app"
TARGET_DIR="src-tauri/target"

ARM_APP_DIR="$TARGET_DIR/aarch64-apple-darwin/release/bundle/macos/$APP_NAME"
X64_APP_DIR="$TARGET_DIR/x86_64-apple-darwin/release/bundle/macos/$APP_NAME"
UNIVERSAL_DIR="$TARGET_DIR/universal-apple-darwin/release/bundle/macos"
UNIVERSAL_APP_DIR="$UNIVERSAL_DIR/$APP_NAME"

ARM_BIN="$ARM_APP_DIR/Contents/MacOS/src-tauri"
X64_BIN="$X64_APP_DIR/Contents/MacOS/src-tauri"
UNIVERSAL_BIN="$UNIVERSAL_APP_DIR/Contents/MacOS/src-tauri"

mkdir -p "$UNIVERSAL_APP_DIR/Contents/MacOS"

echo "[3/4] Creating universal binary with lipo..."
cp -R "$ARM_APP_DIR/" "$UNIVERSAL_APP_DIR/"

lipo -create -output "$UNIVERSAL_BIN" "$ARM_BIN" "$X64_BIN"

# 使用 hdiutil 创建一个通用 dmg
DMG_OUTPUT_DIR="$TARGET_DIR/universal-apple-darwin/release/bundle/dmg"
mkdir -p "$DMG_OUTPUT_DIR"
DMG_PATH="$DMG_OUTPUT_DIR/007-Desk-universal.dmg"

echo "[4/4] Creating universal dmg at: $DMG_PATH"
hdiutil create -volname "007 Desk" -srcfolder "$UNIVERSAL_APP_DIR" -ov -format UDZO "$DMG_PATH"

echo "Universal dmg created: $DMG_PATH"
