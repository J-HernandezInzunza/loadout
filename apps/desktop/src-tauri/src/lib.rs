// Rust holds no domain logic and no commands (architecture.md §2.4): plugin registration only.
// PATH widening for a Finder-launched bundle (§5.3) lands with the Tauri host in M4.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first: one process mutates receipts and clones at a time.
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running Loadout");
}
