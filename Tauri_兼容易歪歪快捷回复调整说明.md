# Tauri 客户端兼容易歪歪快捷回复：焦点与剪贴板问题调整说明

## 1. 问题背景

当前 Windows 客户端使用 **Tauri** 开发。

与 **易歪歪** 同时使用时出现兼容问题：

1. Tauri 客户端正常打开。
2. Tauri 聊天输入框原本处于可输入状态。
3. 点击易歪歪窗口。
4. Tauri 客户端失去 Windows 前台焦点，WebView2/HTML 输入框也失去 focus。
5. 在易歪歪中点击快捷回复。
6. 易歪歪的快捷回复内容无法正常进入 Tauri 客户端的聊天输入框。

目标：

> **让 Tauri 客户端能够稳定兼容易歪歪的快捷回复，不要通过让两个窗口反复抢焦点的方式解决。**

---

## 2. 当前技术栈

- Windows
- Tauri
- WebView2
- 前端输入框可能是：
  - `<textarea>`
  - `<input>`
  - `contenteditable`
  - Vue/React 等框架封装的输入组件
- 外部软件：易歪歪

请 AI 首先检查当前项目实际使用的：
- Tauri 版本（Tauri 1 / Tauri 2）
- 前端框架
- 输入框具体实现
- 是否已经存在 clipboard、focus、window API 相关代码

**不要假设项目技术栈，必须先读取现有代码。**

---

# 3. 问题判断

优先怀疑以下链路：

```text
Tauri.exe
  └── WebView2
       └── HTML 输入框
            ↓
       原本拥有 focus

点击易歪歪
       ↓
易歪歪窗口成为 Windows Foreground Window
       ↓
Tauri / WebView2 / HTML 输入框失去 focus
       ↓
易歪歪执行快捷回复
       ↓
快捷回复内容通过 Clipboard / 粘贴机制发送
       ↓
当前输入目标已经不是 Tauri 输入框
       ↓
内容无法进入 Tauri
```

不要简单认为是 HTML 输入框本身不支持粘贴。

---

# 4. 禁止使用的错误解决方式

不要优先采用以下方案：

```rust
window.set_focus();
```

或者：

```text
SetForegroundWindow()
SetFocus()
BringWindowToTop()
AttachThreadInput()
```

来强制 Tauri 在易歪歪操作时抢回 Windows 前台焦点。

原因：

```text
点击易歪歪
    ↓
Tauri 抢焦点
    ↓
易歪歪失去目标窗口
    ↓
快捷回复/粘贴可能失败
```

甚至可能出现两个程序反复抢焦点、闪烁、输入异常。

除非经过验证，否则不要采用“两个窗口互相抢焦点”的方案。

---

# 5. 第一阶段：先确认易歪歪的实际行为

在修改代码之前，请先通过代码和调试日志确认：

## 5.1 检查是否是 Clipboard

测试：

1. 打开 Tauri 输入框。
2. 打开易歪歪。
3. 点击易歪歪快捷回复。
4. 打开 Windows 记事本。
5. Ctrl+V。

如果记事本能够粘贴出易歪歪快捷回复内容：

```text
易歪歪快捷回复内容
```

则说明易歪歪很可能通过 Windows Clipboard 完成快捷回复。

这种情况下优先考虑：

```text
易歪歪
  ↓
Windows Clipboard
  ↓
Tauri Rust 侧监听 Clipboard
  ↓
读取文本
  ↓
Tauri emit
  ↓
WebView2 前端
  ↓
聊天输入框
```

---

# 6. 第二阶段：检查 WebView2 的 focus 和 paste

在当前聊天输入框所在页面增加临时调试：

```javascript
document.addEventListener('focusin', (e) => {
    console.log('[FOCUS IN]', e.target);
});

document.addEventListener('focusout', (e) => {
    console.log('[FOCUS OUT]', e.target);
});

document.addEventListener('paste', (e) => {
    console.log(
        '[PASTE]',
        e.clipboardData?.getData('text/plain')
    );
});
```

测试：

1. Tauri 输入框获得焦点。
2. 点击易歪歪。
3. 点击快捷回复。
4. 查看日志。

需要区分以下情况。

### 情况 A：发生 focusout，但没有 paste

```text
[FOCUS OUT]
```

没有：

```text
[PASTE]
```

说明外部快捷回复没有进入 WebView2 的 paste 事件。

重点检查：

- Windows 焦点
- WebView2 输入目标
- Clipboard
- 易歪歪的粘贴实现

---

### 情况 B：收到 paste，但输入框没有文字

例如：

```text
[PASTE] 你好，这是一条快捷回复
```

但是页面输入框没有内容。

说明：

- Clipboard 正常
- paste 事件已经进入 WebView2
- 问题可能在前端输入框处理逻辑

重点检查：

- `textarea`
- `contenteditable`
- React/Vue controlled input
- `preventDefault`
- 自定义 paste handler
- 输入框状态同步
- selection/caret

---

### 情况 C：focusout / paste 都没有

重点检查：

- Tauri WebView2 是否仍然正常接收事件
- Windows 原生窗口焦点
- WebView2 focus
- 是否有窗口级别的输入拦截
- 是否有全局快捷键/鼠标钩子

---

# 7. 推荐解决方向：Clipboard Bridge

如果确认易歪歪是通过 Clipboard 发送快捷回复，优先实现：

```text
易歪歪
   ↓
复制快捷回复
   ↓
Windows Clipboard
   ↓
Tauri Rust
   ↓
监听 Clipboard 内容变化
   ↓
读取 text/plain
   ↓
判断是否为新的文本内容
   ↓
emit 到前端
   ↓
前端写入聊天输入框
```

这样不要依赖：

```text
易歪歪
  ↓
Ctrl+V
  ↓
当前 Windows 焦点
  ↓
WebView2
  ↓
HTML 输入框
```

从而避免焦点冲突。

---

# 8. Clipboard Bridge 的实现要求

## Rust 侧

根据当前项目依赖选择合适的 Clipboard 库或 Tauri 插件。

需要实现：

```text
start_clipboard_monitor()
stop_clipboard_monitor()
```

监听 Clipboard 内容变化。

当 Clipboard 中出现新的纯文本内容：

```text
text/plain
```

通过 Tauri event 发送给前端，例如：

```text
clipboard-text-received
```

payload：

```json
{
  "text": "快捷回复内容"
}
```

---

# 9. 防止 Clipboard 监听造成副作用

不能简单地：

```text
Clipboard 每变化一次
→ 自动写入聊天输入框
```

必须考虑：

### 9.1 用户正常复制文字

用户自己 Ctrl+C：

```text
网页文字
↓
Clipboard
```

不能自动把它塞进聊天输入框。

### 9.2 用户复制图片

忽略。

### 9.3 Clipboard 频繁变化

需要避免高频事件。

### 9.4 重复内容

如果 Clipboard 内容没有变化，不重复发送。

### 9.5 Tauri 自己写入 Clipboard

如果客户端自己修改 Clipboard，要避免触发自己的监听逻辑。

建议维护：

```text
last_clipboard_text
last_processed_text
self_written_clipboard
```

等状态。

---

# 10. 更重要：不能误把普通复制内容当成易歪歪快捷回复

需要设计“是否应该接收”的判断机制。

优先考虑：

### 方案 A：只在用户正在使用易歪歪时处理

如果可以可靠判断易歪歪窗口状态，可以结合 Windows 前台窗口/进程信息。

例如：

```text
Foreground Window Process == 易歪歪
```

再处理 Clipboard。

---

### 方案 B：使用短时间窗口

例如：

```text
用户点击易歪歪
      ↓
进入短暂监听状态
      ↓
Clipboard 发生文本变化
      ↓
认为是快捷回复
```

具体时间不要写死，先做成配置常量，例如：

```text
CLIPBOARD_CAPTURE_WINDOW_MS
```

---

### 方案 C：保留原始 Clipboard 行为

不要破坏用户剪贴板。

如果需要读取 Clipboard：

```text
读取
↓
将内容发送给 Tauri
↓
不要主动清空 Clipboard
```

除非项目原本业务逻辑明确要求。

---

# 11. 前端输入框处理

收到：

```text
clipboard-text-received
```

后：

```text
text
 ↓
聊天输入框
```

但不要简单：

```javascript
input.value = text;
```

如果项目使用 Vue / React 等框架，需要使用项目当前的数据绑定方式。

例如：

```text
Vue:
state.message = text

React:
setMessage(text)
```

如果是：

```html
<textarea>
```

需要确保：

- UI 状态同步
- 光标位置正确
- 用户正在编辑的文字不会被无条件覆盖

---

# 12. 非覆盖式插入

如果用户输入框已经存在文字：

```text
用户已经输入：
您好，我想咨询
```

易歪歪快捷回复：

```text
请问有什么可以帮助您？
```

不要默认直接覆盖用户原来的内容。

应该根据当前产品需求选择：

### 模式 1：覆盖

```text
快捷回复
```

### 模式 2：追加

```text
您好，我想咨询请问有什么可以帮助您？
```

### 模式 3：插入到当前光标位置

推荐优先考虑：

```text
用户原文字
      +
快捷回复
```

插入位置使用当前 selection/caret。

**请先检查现有产品逻辑，不要自行改变用户输入行为。**

---

# 13. 如果 Clipboard 方案不适用

如果测试发现易歪歪并不是通过 Clipboard，而是通过 Windows 消息/模拟键盘输入实现，则不要继续强行使用 Clipboard Bridge。

改为排查：

```text
Windows SendInput
WM_PASTE
WM_CHAR
WM_KEYDOWN
WM_KEYUP
窗口消息
WebView2 输入
```

重点确认易歪歪向哪个 HWND / Thread / Process 发送输入。

---

# 14. Tauri 原生窗口层检查

请检查当前项目是否存在：

```text
SetForegroundWindow
SetFocus
BringWindowToTop
AttachThreadInput
SetActiveWindow
ShowWindow
Activate
focus()
```

搜索：

```text
set_focus
set_focus()
SetForegroundWindow
SetFocus
BringWindowToTop
AttachThreadInput
SetActiveWindow
focus()
```

如果存在，请分析这些代码是否在：

```text
窗口激活
窗口显示
输入框聚焦
快捷键
鼠标事件
Clipboard
```

相关流程中造成焦点抢夺。

**不要直接删除。先分析调用链。**

---

# 15. 最终目标

最终用户体验应该是：

```text
┌──────────────┐
│   Tauri      │
│              │
│ 聊天输入框   │
└──────────────┘
        ↕
   Clipboard Bridge
        ↕
┌──────────────┐
│   易歪歪      │
│              │
│ 快捷回复     │
└──────────────┘
```

用户操作：

```text
1. Tauri 输入框正常打开
2. 点击易歪歪
3. 点击快捷回复
4. Tauri 不需要抢回 Windows 前台焦点
5. 快捷回复内容自动进入 Tauri 输入框
6. 用户可以继续发送
```

---

# 16. 调试日志要求

请加入清晰的日志，例如：

```text
[YY-DEBUG] Clipboard changed
[YY-DEBUG] Clipboard text length: 25
[YY-DEBUG] Clipboard text: ********
[YY-DEBUG] Foreground process: xxx.exe
[YY-DEBUG] Tauri window focused: false
[YY-DEBUG] Clipboard event emitted
[YY-DEBUG] Frontend received clipboard-text-received
[YY-DEBUG] Input element found: true
[YY-DEBUG] Message inserted: true
```

不要默认打印用户完整的聊天内容。

生产环境需要：

- 关闭敏感文本日志
- 避免长期记录 Clipboard 内容
- 避免泄露用户复制的密码、Token、隐私数据

---

# 17. 实现原则

请严格遵循：

1. **先读取现有项目代码，再修改。**
2. 不要假设 Tauri 版本。
3. 不要假设前端框架。
4. 不要直接重构整个输入框。
5. 不要通过反复抢 Windows 焦点解决问题。
6. 优先确认易歪歪是否使用 Clipboard。
7. 如果使用 Clipboard，优先实现 Rust Clipboard → Tauri Event → 前端输入框的桥接。
8. 保持原有聊天输入功能不变。
9. 不要破坏用户正常复制/粘贴。
10. 不要自动覆盖用户正在编辑的内容，除非当前业务逻辑就是覆盖。
11. 处理 Clipboard 重复事件。
12. 防止 Tauri 自己修改 Clipboard 造成循环。
13. 对 Windows 环境重点测试。
14. 最后给出修改了哪些文件、为什么修改、如何测试。

---

# 18. 验收标准

### 测试 1：易歪歪快捷回复

```text
Tauri 输入框
→ 点击易歪歪
→ 点击快捷回复
→ 快捷回复进入 Tauri 输入框
```

必须成功。

### 测试 2：Tauri 正常输入

```text
手动点击输入框
→ 键盘输入
```

必须正常。

### 测试 3：Tauri Ctrl+V

```text
其他程序复制文本
→ Tauri 输入框
→ Ctrl+V
```

必须正常。

### 测试 4：用户普通复制

```text
Tauri/其他程序 Ctrl+C
```

不能因为 Clipboard Monitor 而自动修改聊天输入框。

### 测试 5：重复快捷回复

连续点击相同快捷回复：

```text
A
A
A
```

必须按照易歪歪原本预期处理，不能因为去重逻辑导致后续内容丢失。

### 测试 6：焦点

点击易歪歪后：

```text
Tauri 不应该疯狂抢回 Windows Foreground
```

不能出现：

- 窗口闪烁
- 两个窗口反复抢焦点
- 易歪歪无法点击
- 快捷回复失败
- Tauri 卡顿

---

# 19. 请 AI 最终输出

完成代码分析和修改后，请明确告诉我：

```text
1. 根本原因是什么
2. 易歪歪到底采用什么方式把快捷回复发送出去
3. 修改了哪些文件
4. 每个文件修改了什么
5. 是否增加了 Rust Clipboard Monitor
6. 是否增加了 Tauri Event
7. 前端输入框如何接收
8. 是否修改了 Windows Focus 逻辑
9. 是否存在副作用
10. Windows 下如何测试
```

**优先目标不是“让窗口重新获得焦点”，而是让 Tauri 客户端在失去 Windows 前台焦点后，仍然能够可靠接收易歪歪的快捷回复内容。**
