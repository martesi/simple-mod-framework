mod commands;
mod paths;

use commands::{archive, deploy, fs_bridge};

pub fn run() {
    #[cfg(debug_assertions)]
    paths::debug_check_layout();

    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            // path helpers
            paths::get_framework_root,
            paths::get_app_dir,
            // filesystem bridge
            fs_bridge::fs_read_text,
            fs_bridge::fs_write_text,
            fs_bridge::fs_exists,
            fs_bridge::fs_is_file,
            fs_bridge::fs_read_dir,
            fs_bridge::fs_copy,
            fs_bridge::fs_copy_file,
            fs_bridge::fs_remove,
            fs_bridge::fs_empty_dir,
            fs_bridge::fs_ensure_dir,
            fs_bridge::klaw_walk,
            // archives
            archive::extract_archive,
            archive::write_temp_bytes,
            // deploy
            deploy::run_deploy,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
