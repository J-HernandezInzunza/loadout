// Rust holds no domain logic (architecture.md §2.4): environment repair for a Finder-launched bundle
// (§5.3), plugin registration, and the few commands no plugin covers (real_path, QUESTIONS.md Q6).

mod fs;
mod path;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    path::repair_env();
    tauri::Builder::default()
        // Must be registered first: one process mutates receipts and clones at a time.
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![fs::real_path])
        .run(tauri::generate_context!())
        .expect("error while running Loadout");
}
