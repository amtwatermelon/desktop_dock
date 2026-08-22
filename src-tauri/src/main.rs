#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::path::PathBuf;

use tauri::{Manager, WebviewUrl};
use tauri_plugin_notification::NotificationExt;

// ==== 易歪歪 Clipboard Bridge 配置（仅 Windows 生效）====
// 背景见根目录《Tauri_兼容易歪歪快捷回复调整说明.md》：
// 点击易歪歪快捷回复时它把文本写入 Windows 剪贴板，但我们的窗口已失去前台焦点，
// 粘贴落不进 WebView2 输入框。方案是 Rust 侧监听剪贴板变化 → emit 事件 →
// 前端把文本插入活动页签的输入框。全程不抢 Windows 前台焦点。
#[cfg(target_os = "windows")]
mod yy_bridge {
    pub const ENABLED: bool = true;
    // 诊断期收紧轮询间隔：易歪歪可能是"写剪贴板→立即还原"的瞬时操作，
    // 300ms 可能漏看中间状态（序列号仍会递增，但前台进程可能已切走）。
    pub const POLL_INTERVAL_MS: u64 = 150;
    // 我们窗口失焦后该时长内的剪贴板文本变化视为快捷回复（说明文档 §10 方案B）
    pub const CAPTURE_WINDOW_MS: u128 = 10_000;
    // 前台进程允许清单（exe 文件名小写）。真实 exe 名上线后按 [YY-DEBUG] 日志修正。
    pub const FOREGROUND_ALLOWLIST: &[&str] = &["yiwaiwai.exe", "易歪歪.exe", "yy.exe"];
    // 调试日志只打长度与截断预览，不打印全文（说明文档 §16）
    pub const LOG_PREVIEW_CHARS: usize = 8;
    pub const EVENT_NAME: &str = "clipboard-quick-reply";
}

// ==== 易歪歪 Clipboard Bridge 实现（仅 Windows）====
#[cfg(target_os = "windows")]
mod yy_clipboard {
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use tauri::{AppHandle, Emitter};

    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HGLOBAL, HWND};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, GetClipboardSequenceNumber, OpenClipboard,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId,
    };

    use super::yy_bridge::*;

    // 由 on_window_event 维护：我们窗口当前是否聚焦、上次失焦时间
    pub static WINDOW_FOCUSED: AtomicBool = AtomicBool::new(false);
    pub static LAST_BLUR_AT: Mutex<Option<Instant>> = Mutex::new(None);

    // 日志串行写（监视线程 + 窗口事件回调都会写）
    fn log_lock() -> &'static Mutex<()> {
        static LOCK: Mutex<()> = Mutex::new(());
        &LOCK
    }

    /// [YY-DEBUG] 同时写 stdout 和 %APPDATA%\007Desk\yy-bridge.log。
    /// release 包 windows_subsystem=windows 没有 stdout，文件是唯一现场。
    pub fn log(args: std::fmt::Arguments) {
        let line = format!("[{}] {}", {
            let secs = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let (h, m, s) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
            format!("{h:02}:{m:02}:{s:02}")
        }, args);
        println!("{line}");
        let _guard = log_lock().lock().unwrap();
        let Ok(app_data) = std::env::var("APPDATA") else { return };
        let dir = PathBuf::from(app_data).join("007Desk");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("yy-bridge.log"))
        {
            let _ = writeln!(file, "{line}");
        }
    }

    /// 前台进程 exe 名（小写，如 "yiwaiwai.exe"）。查询失败返回 None。
    fn foreground_process_name() -> Option<String> {
        unsafe {
            let hwnd: HWND = GetForegroundWindow();
            if hwnd.0.is_null() {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return None;
            }
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return None;
            };
            let mut buf = [0u16; 512];
            let mut len = buf.len() as u32;
            let queried = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
            .is_ok();
            let _ = CloseHandle(handle);
            if !queried {
                return None;
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            path.rsplit(['\\', '/'])
                .next()
                .map(|s| s.to_lowercase())
        }
    }

    /// 读取剪贴板文本（CF_UNICODETEXT）。非文本格式或打开失败返回 None。
    fn read_clipboard_text() -> Option<String> {
        unsafe {
            if !OpenClipboard(None).is_ok() {
                return None; // 被其他进程占用 → 由调用方小重试兜底
            }
            let result = (|| {
                // CF_UNICODETEXT = 13
                let Ok(handle) = GetClipboardData(13) else {
                    return None;
                };
                let hglobal = HGLOBAL(handle.0);
                let ptr = GlobalLock(hglobal) as *const u16;
                if ptr.is_null() {
                    return None;
                }
                let mut len = 0usize;
                while *ptr.add(len) != 0 {
                    len += 1;
                }
                let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
                let _ = GlobalUnlock(hglobal);
                Some(text)
            })();
            let _ = CloseClipboard();
            result
        }
    }

    /// 带小重试的文本读取：易歪歪可能用 delayed render 写剪贴板，序列号先变、
    /// 数据稍后才可读。
    fn read_clipboard_text_with_retry() -> Option<String> {
        for attempt in 0..3 {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(150));
            }
            if let Some(text) = read_clipboard_text() {
                return Some(text);
            }
        }
        None
    }

    pub fn spawn_monitor(app: AppHandle) {
        std::thread::spawn(move || {
            let mut last_seq = unsafe { GetClipboardSequenceNumber() };
            log(format_args!(
                "[YY-DEBUG] clipboard monitor started, initial seq={last_seq}"
            ));
            loop {
                std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
                if !ENABLED {
                    continue;
                }

                let seq = unsafe { GetClipboardSequenceNumber() };
                if seq == last_seq {
                    continue;
                }
                last_seq = seq;
                log(format_args!("[YY-DEBUG] Clipboard changed, seq={seq}"));

                // —— 接收门槛（说明文档 §10）——
                let focused = WINDOW_FOCUSED.load(Ordering::Relaxed);
                let foreground = foreground_process_name();
                let fg_allowed = foreground
                    .as_deref()
                    .map(|name| FOREGROUND_ALLOWLIST.iter().any(|allowed| *allowed == name))
                    .unwrap_or(false);
                let in_capture_window = {
                    let last_blur = LAST_BLUR_AT.lock().unwrap();
                    match *last_blur {
                        Some(t) => t.elapsed().as_millis() <= CAPTURE_WINDOW_MS,
                        // 启动后从未聚焦/失焦过 → 不处理
                        None => false,
                    }
                };
                log(format_args!(
                    "[YY-DEBUG] focused={focused} foreground={foreground:?} allowed={fg_allowed} in_capture_window={in_capture_window}"
                ));

                // 窗口聚焦中的剪贴板变化 = 用户自己复制，不处理（§9.1）
                if focused {
                    log(format_args!(
                        "[YY-DEBUG] skip: our window focused (user normal copy)"
                    ));
                    continue;
                }
                // 前台不是易歪歪且失焦时间窗已过 → 别处的普通复制，不处理
                if !fg_allowed && !in_capture_window {
                    log(format_args!("[YY-DEBUG] skip: gate denied"));
                    continue;
                }

                let Some(raw) = read_clipboard_text_with_retry() else {
                    log(format_args!(
                        "[YY-DEBUG] skip: no text (image or delayed render)"
                    ));
                    continue;
                };
                let text = raw.trim().to_string();
                if text.is_empty() {
                    log(format_args!("[YY-DEBUG] skip: empty text"));
                    continue;
                }

                let preview: String = text.chars().take(LOG_PREVIEW_CHARS).collect();
                log(format_args!(
                    "[YY-DEBUG] text length={} preview={preview}…",
                    text.chars().count()
                ));

                match app.emit(EVENT_NAME, serde_json::json!({ "text": text })) {
                    Ok(_) => log(format_args!("[YY-DEBUG] Clipboard event emitted")),
                    Err(e) => log(format_args!("[YY-DEBUG] emit failed: {e}")),
                }
                // 不清空剪贴板（§10 方案C），不破坏用户复制/粘贴
            }
        });
    }
}

// 接收来自 webview 的通知请求
#[tauri::command]
async fn send_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    println!("📬 收到通知请求: {} - {}", title, body);

    // 在 Windows 上，需要确保应用已安装且具有通知权限
    #[cfg(target_os = "windows")]
    {
        println!("🪟 Windows 平台: 准备发送通知");
    }

    #[cfg(target_os = "macos")]
    {
        println!("🍎 macOS 平台: 准备发送通知");
    }

    match app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
    {
        Ok(_) => {
            println!("✅ 通知已成功发送");
            Ok(())
        }
        Err(e) => {
            let error_msg = format!("❌ 通知发送失败: {}", e);
            println!("{}", error_msg);
            Err(error_msg)
        }
    }
}

// 清理建议文件名：替换 Windows 非法字符与控制字符，去掉首尾空白/点号，空值兜底，截断到 200 字符
fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if (c as u32) < 0x20 => '-',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "download".into()
    } else {
        trimmed.chars().take(200).collect()
    }
}

// 修复视频无法播放：站点 CDN（Cloudflare）对 mp4 等媒体错误地启用了 Brotli 压缩
// （响应带 content-encoding: br 且不支持 Range/206）。Chrome 的媒体管线会透明解压，
// 但 WKWebView / WebView2 的 <video> 管线拒绝带 content-encoding 的媒体响应，
// 报 SRC_NOT_SUPPORTED，表现为视频黑屏不能播。
// 修复方式：注入初始化脚本，把同源 <video>/<audio>/<source> 的 src 改写为
// fetch（fetch/XHR 管线会正确解压 content-encoding）→ Blob → objectURL。
// 仅处理同源 URL，避免跨域 CORS 问题。
const MEDIA_FIX_SCRIPT: &str = r#"
(function () {
  if (window.__mediaFixInstalled) return;
  window.__mediaFixInstalled = true;

  var MEDIA_EXT = /\.(mp4|webm|mov|m4v|ogv|ogg|mp3|wav|m4a|aac|flac)(\?|$)/i;

  function isSameOriginMedia(url) {
    try {
      var u = new URL(url, location.href);
      if (u.origin !== location.origin) return false;
      return MEDIA_EXT.test(u.pathname);
    } catch (e) { return false; }
  }

  // 已处理/处理中的 src 集合，避免循环触发
  var handled = new WeakSet();
  var inFlight = new WeakSet();

  function fixMediaSource(el) {
    var src = el.getAttribute('src');
    if (!src || !isSameOriginMedia(src)) return;
    if (handled.has(el) || inFlight.has(el)) return;
    inFlight.add(el);

    var absUrl = new URL(src, location.href).href;
    fetch(absUrl)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        handled.add(el);
        el.src = URL.createObjectURL(blob);
        el.load();
      })
      .catch(function () {
        // 失败则保留原 src，行为退回未修复状态
      })
      .finally(function () { inFlight.delete(el); });
  }

  function scan(root) {
    try {
      var nodes = (root || document).querySelectorAll('video, audio, source');
      for (var i = 0; i < nodes.length; i++) fixMediaSource(nodes[i]);
    } catch (e) {}
  }

  // 捕获加载失败的媒体，重试一次 blob 路径（防止扫描时序遗漏）
  document.addEventListener('error', function (ev) {
    var t = ev.target;
    if (t && (t.tagName === 'VIDEO' || t.tagName === 'AUDIO' || t.tagName === 'SOURCE')) {
      fixMediaSource(t);
    }
  }, true);

  var mo = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === 'childList') {
        for (var j = 0; j < m.addedNodes.length; j++) {
          var n = m.addedNodes[j];
          if (n.nodeType !== 1) continue;
          if (n.tagName === 'VIDEO' || n.tagName === 'AUDIO' || n.tagName === 'SOURCE') fixMediaSource(n);
          else if (n.querySelectorAll) scan(n);
        }
      } else if (m.type === 'attributes' && m.target.nodeType === 1) {
        fixMediaSource(m.target);
      }
    }
  });
  mo.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['src']
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { scan(document); });
  } else {
    scan(document);
  }

  // ==== 易歪歪 Clipboard Bridge：记录最近聚焦的可编辑元素 ====
  // 窗口失焦后部分 WebView2 版本会丢失 activeElement，这里在 focusin 时缓存一份，
  // 供剪贴板快捷回复插入脚本（见 src/main.ts）定位目标输入框。
  window.__yyLastEditable = null;
  function __yyIsEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (tag === 'INPUT') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'search', 'url', 'tel', 'email', ''].indexOf(t) !== -1;
    }
    if (tag === 'TEXTAREA') return true;
    return el.isContentEditable === true;
  }
  document.addEventListener('focusin', function (ev) {
    if (__yyIsEditable(ev.target)) window.__yyLastEditable = ev.target;
  }, true);
  document.addEventListener('DOMContentLoaded', function () {
    if (__yyIsEditable(document.activeElement)) window.__yyLastEditable = document.activeElement;
  });
})();
"#;

// 由 Rust 侧创建子 webview，以便在构建时挂上 on_download 下载处理器。
// JS 的 new Webview(...) 走内置 create_webview 命令，不会附加下载钩子，
// 导致点击下载按钮时 Windows/WebView2 无反应、macOS/WKWebView 静默失败。
#[tauri::command]
async fn create_tab_webview(
    window: tauri::Window,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;

    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .on_download(move |view, event| match event {
            tauri::webview::DownloadEvent::Requested { destination, .. } => {
                let suggested = sanitize_file_name(
                    destination
                        .file_name()
                        .and_then(|f| f.to_str())
                        .unwrap_or("download"),
                );
                // 用 rfd 同步 API 就地弹出"另存为"对话框。注意：这里不能用
                // tauri-plugin-dialog 的 blocking_save_file()——它会向主线程事件
                // 循环投递任务并同步等待结果，而本回调就运行在主线程上，会自等待
                // 死锁（弹窗后整个应用卡死）。rfd 检测到已在主线程后直接
                // runModal / IFileDialog::Show，模态循环内部自行泵事件，是安全的。
                //
                // Windows 关键点：必须 set_parent 挂上宿主窗口。否则
                // IFileDialog::Show(NULL) 的对话框无 owner，从 WebView2 事件回调里
                // 弹出时不会被带到前台，看起来就是"点了没反应"（对话框其实弹在
                // 主窗口后面）。macOS 上 run_modal 本身会强制接管，父窗口仅影响
                // sheet 样式，无副作用。
                let window = view.window();
                let mut dialog = rfd::FileDialog::new()
                    .set_title("保存文件")
                    .set_file_name(&suggested);
                dialog = dialog.set_parent(&window);
                match dialog.save_file() {
                    Some(p) => {
                        *destination = p;
                        true
                    }
                    None => false, // 用户取消 → 中止下载
                }
            }
            tauri::webview::DownloadEvent::Finished { path, success, .. } => {
                let app = view.app_handle().clone();
                let name = path
                    .as_ref()
                    .and_then(|p: &PathBuf| p.file_name())
                    .and_then(|f| f.to_str())
                    .map(String::from)
                    .unwrap_or_else(|| "文件".into());
                let (title, body) = if success {
                    ("下载完成", name)
                } else {
                    ("下载失败", format!("{} 未能保存", name))
                };
                let _ = app.notification().builder().title(title).body(&body).show();
                true
            }
            _ => true,
        })
        // 不注册 on_new_window 时，wry 在 Windows 上对 window.open 的默认行为是
        // SetHandled(true) 直接静默拒绝（macOS 无 handler 时由 WebKit 默认放行）。
        // 聊天页面里的视频播放器/登录弹窗等依赖 window.open，会被无声吞掉，
        // 表现为"视频点不开"。这里放行为系统默认行为。
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Allow)
        // 视频播放修复脚本（见 MEDIA_FIX_SCRIPT 注释），在每个页面加载前注入
        .initialization_script(MEDIA_FIX_SCRIPT.to_string());

    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // 易歪歪 Clipboard Bridge：启动剪贴板监视线程（仅 Windows）
            #[cfg(target_os = "windows")]
            yy_clipboard::spawn_monitor(app.handle().clone());
            #[cfg(not(target_os = "windows"))]
            let _ = app; // macOS 上无监视线程，消除 unused 警告
            Ok(())
        })
        .on_window_event(|_window, #[cfg_attr(not(target_os = "windows"), allow(unused_variables))] event| {
            // 维护易歪歪 Bridge 的焦点状态：聚焦中不处理剪贴板（用户自己复制），
            // 失焦时间戳用于限定"快捷回复捕获窗口"。只记录，不抢焦点。
            #[cfg(target_os = "windows")]
            if let tauri::WindowEvent::Focused(focused) = event {
                yy_clipboard::WINDOW_FOCUSED.store(*focused, std::sync::atomic::Ordering::Relaxed);
                if !*focused {
                    let mut last_blur = yy_clipboard::LAST_BLUR_AT.lock().unwrap();
                    *last_blur = Some(std::time::Instant::now());
                    yy_clipboard::log(format_args!(
                        "[YY-DEBUG] window blurred, capture window opens ({}ms)",
                        yy_bridge::CAPTURE_WINDOW_MS
                    ));
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            send_notification,
            create_tab_webview
        ])
        .run(tauri::generate_context!())
        .expect("运行 Tauri 应用失败");
}
