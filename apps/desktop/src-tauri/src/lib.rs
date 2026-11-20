// Rust holds no domain logic (architecture.md §2.4): environment repair for a Finder-launched bundle
// (§5.3), plugin registration, and the few commands no plugin covers: the Keychain (§5.5), real_path
// (QUESTIONS.md Q6) and which, a lookup on the repaired PATH.

mod fs;
mod path;
mod secrets;

// The WebDriver server lets anything on this machine drive the app: never in a release build.
#[cfg(all(feature = "webdriver", not(debug_assertions)))]
compile_error!("the webdriver feature is for debug builds only");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    path::repair_env();
    let builder = tauri::Builder::default()
        // Must be registered first: one process mutates receipts and clones at a time.
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}));
    // Flows drive the app through it (M16.11); only builds with the webdriver feature have it.
    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            fs::real_path,
            path::which,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running Loadout");
}
