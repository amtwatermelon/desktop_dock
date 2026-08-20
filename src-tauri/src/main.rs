#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::path::PathBuf;

use tauri::{Manager, WebviewUrl};
use tauri_plugin_notification::NotificationExt;

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
        .invoke_handler(tauri::generate_handler![
            send_notification,
            create_tab_webview
        ])
        .run(tauri::generate_context!())
        .expect("运行 Tauri 应用失败");
}
