#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use tauri_plugin_notification::NotificationExt;

// 接收来自 webview 的通知请求
#[tauri::command]
async fn send_notification(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
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
    
    match app.notification()
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![send_notification])
        .run(tauri::generate_context!())
        .expect("运行 Tauri 应用失败");
}
