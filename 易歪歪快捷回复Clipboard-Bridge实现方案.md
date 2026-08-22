# 易歪歪快捷回复 Clipboard Bridge 实现方案

> 对《Tauri_兼容易歪歪快捷回复调整说明.md》（需求文档）的落地实现总结。
> 涉及提交：`2300b12` → `213a03d` → `9f543b1` → `984afae` → `961613a`

## 1. 问题背景

Windows 客户端（Tauri 2.10 + WebView2）的工作台是子 webview 承载的外部页面
（`https://www.007proxy.uk/dock/login`）。与易歪歪同时使用时：

1. 点击易歪歪窗口 → 本应用失去 Windows 前台焦点，WebView2 输入框失焦
2. 双击易歪歪快捷回复 → 易歪歪"激活目标窗口 → 写剪贴板 → 发粘贴"
3. 粘贴落不进失焦的 WebView2 输入框 → 内容进不来

macOS 正常（NSWindow 激活链路会自然恢复 key webview），仅 Windows 有此问题。

**约束**（需求文档明确）：禁止用 `set_focus()` / `SetForegroundWindow()` 抢焦点解决
（会两窗口互抢、闪烁），必须走 **Clipboard Bridge**。

## 2. 方案总览

```
易歪歪双击快捷回复
   ↓
先把本应用窗口激活到前台          ← 关键时序（见 §5 宽限期）
   ↓
写 Windows 剪贴板（序列号 +1）
   ↓
Rust 监视线程（150ms 轮询序列号，仅 Windows）
   ↓ 门槛判定：非稳定聚焦 + (失焦窗口期 | refocus 宽限期 | 前台=易歪歪)
emit `clipboard-quick-reply` {text}
   ↓
主窗口 JS 监听 → invoke `eval_in_webview` 注入插入脚本到活动页签
   ↓
子页面执行：定位输入框 → 光标处插入文本 → __TAURI__.event.emit 回传结果
```

全程**不抢焦点、不清剪贴板、不做文本去重**。

## 3. 修改文件清单

| 文件 | 改动 |
|---|---|
| `src-tauri/Cargo.toml` | `serde_json`；仅 Windows 的 `windows 0.61`（与 lockfile 中 tauri 传递依赖同版本，零冲突） |
| `src-tauri/src/main.rs` | `yy_bridge` 常量、`yy_clipboard` 监视模块、`eval_in_webview` 命令、builder 挂接、MEDIA_FIX_SCRIPT 输入框追踪 |
| `src/main.ts` | `listen('clipboard-quick-reply')` + 插入脚本 + 三处 eval 改造 + 结果回传监听 |

## 4. 核心实现

### 4.1 Rust：剪贴板监视线程（仅 Windows）

- **轮询 `GetClipboardSequenceNumber()`**（150ms），序列号变化才继续——
  连点相同快捷回复 A,A,A 每次都触发（无文本去重，需求验收测试 5）
- **门槛判定**（防误把普通复制当快捷回复，需求 §9/§10）：
  - 稳定聚焦中 → 跳过（用户自己 Ctrl+C）
  - 失焦后 10s 捕获窗口内 → 放行（方案 B）
  - blur→focus 后 2s 宽限期内 → 放行（见 §5）
  - 前台进程在允许清单 → 放行（真实 exe 名可从日志回填 `FOREGROUND_ALLOWLIST`）
- 读取 `CF_UNICODETEXT`（失败小重试 3 次，兜底 delayed render），非文本/空跳过
- `app.emit("clipboard-quick-reply", {text})`，**不清空剪贴板**（方案 C）

### 4.2 前台进程查询（诊断 + 门槛）

`GetForegroundWindow → GetWindowThreadProcessId → OpenProcess(QUERY_LIMITED) →
QueryFullProcessImageNameW`，取 exe 文件名小写。同时用于允许清单匹配和
`[YY-DEBUG]` 日志。

### 4.3 注入脚本：输入框追踪（MEDIA_FIX_SCRIPT 内）

`focusin` 时缓存可编辑元素（input[text 类]/textarea/contenteditable）到
`window.__yyLastEditable`——窗口失焦后部分 WebView2 版本会丢 `activeElement`，
用缓存兜底定位。

### 4.4 前端：事件监听 + 文本插入

- 守卫：设置弹窗打开 / 无活动页签 → 跳过
- 插入脚本在子页面执行：目标 = `activeElement` 或 `__yyLastEditable`；
  首选 `document.execCommand('insertText')`（触发原生 input 事件，
  React/Vue 受控组件状态同步），降级 `setRangeText`+InputEvent / Range 插入；
  **光标处插入不覆盖已有内容**（需求 §12 模式 3）
- 文本经 `JSON.stringify` 内嵌，任意引号/换行/unicode 安全
- macOS 不编入监视线程、事件不会发出，走系统原生行为，无双重插入

## 5. 踩过的两个坑（重要）

### 坑 1：`Webview.eval` 在 api 2.x 不存在

`@tauri-apps/api` 2.x 的 `Webview` 类**没有 eval 方法**（v2 只保留 Rust 侧
`Webview::eval()`）。`(view as any).eval(...)` 会抛
`e.event.eval is not a function`；项目原有两处调用
（`waitForWebviewLoad` / `pollTabUrl`）一直在静默失败靠超时兜底。

**修复**：新增 Rust 命令中转：

```rust
#[tauri::command]
async fn eval_in_webview(app, label, js) -> Result<(), String> {
    app.get_webview(&label).ok_or(...)?.eval(js).map_err(...)
}
```

注意 `eval` 是 fire-and-forget **拿不到返回值**——需要结果时由子页面
`window.__TAURI__.event.emit(...)` 回传（`withGlobalTauri` 开启 +
capabilities 覆盖 `tab-*`，事件可达）。现有回传事件：
`yy-webview-ready`（加载检测）、`yy-tab-url`（URL/标题轮询）、
`yy-insert-result`（插入结果）。

### 坑 2：需点 3 次才生效——refocus 竞态

易歪歪双击时序是"**先把本应用激活到前台 → 写剪贴板 → 发粘贴**"。
剪贴板变化落在聚焦后几百毫秒内，被聚焦门槛误判为"用户自己复制"跳过；
第 3 次点击时（先点回易歪歪使本应用失焦）才走通。

**修复**：`Focused` 事件跟踪 blur→focus 转换，记录 `LAST_FOCUS_AT`，
聚焦后 **2s 宽限期**（`REFOCUS_GRACE_MS`）内的剪贴板变化视为快捷回复。
稳定聚焦（超 2s）仍跳过，用户 Ctrl+C 不会误插入。

## 6. 诊断设施（保留在代码里）

- **文件日志**：`%APPDATA%\007Desk\yy-bridge.log`（release 包无 stdout，
  这是唯一现场）。每次剪贴板变化记录：序列号、focused、前台进程、
  门槛判定、文本长度+8 字符预览（不打印全文，需求 §16）
- **系统通知信号**：收到事件 / 插入成功 / 未插入（含原因）/ 注入失败
  都弹通知，链路通断立即可见
- 排查思路：日志里**没有** `Clipboard changed` → 易歪歪不走剪贴板
  （SendInput 方案），本桥接不适用，按需求文档 §13 另行排查

## 7. 验收对照（需求 §18）

| # | 测试 | 状态 |
|---|---|---|
| 1 | 双击快捷回复进输入框 | ✅（宽限期修复后） |
| 2 | 手动点击输入、打字 | ✅ 未改动 |
| 3 | Ctrl+V 正常粘贴 | ✅ 未改动 |
| 4 | 普通复制不误插入 | ✅ 门槛 + 稳定聚焦跳过 |
| 5 | 连点相同快捷回复不丢 | ✅ 序列号判定，无文本去重 |
| 6 | 无抢焦点/闪烁 | ✅ 全程不调用任何抢焦点 API |

## 8. 可调参数（`yy_bridge` 常量，main.rs）

| 常量 | 默认 | 说明 |
|---|---|---|
| `POLL_INTERVAL_MS` | 150 | 剪贴板序列号轮询间隔 |
| `CAPTURE_WINDOW_MS` | 10_000 | 失焦后捕获窗口 |
| `REFOCUS_GRACE_MS` | 2_000 | blur→focus 宽限期（易歪歪激活→写剪贴板的间隔若更长，调大此值） |
| `FOREGROUND_ALLOWLIST` | 猜测值 | 前台进程白名单，从日志取真实 exe 名回填 |

## 9. Windows 测试方法

1. `pnpm deploy:github` 推送触发 CI（GitHub Actions `Build Windows Installer`）
2. 下载 artifact（zip 解压得 nsis/msi 安装包）安装
3. 按需求文档 §18 六项过一遍
4. 异常时收集 `%APPDATA%\007Desk\yy-bridge.log` 对照 §6 排查
