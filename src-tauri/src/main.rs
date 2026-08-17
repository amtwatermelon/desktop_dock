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
                match rfd::FileDialog::new()
                    .set_title("保存文件")
                    .set_file_name(&suggested)
                    .save_file()
                {
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
        });

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
