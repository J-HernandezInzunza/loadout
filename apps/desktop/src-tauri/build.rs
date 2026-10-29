fn main() {
    // With an app manifest, the app's own commands are denied unless a capability grants them (architecture.md §2.4).
    let manifest = tauri_build::AppManifest::new().commands(&["real_path", "secret_get", "secret_set", "secret_delete"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("failed to run tauri-build");
}
