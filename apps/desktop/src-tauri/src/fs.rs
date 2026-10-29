// The one fs operation tauri-plugin-fs lacks: resolving symlinks, for HostFs.realPath (QUESTIONS.md Q6).
// It reads no file content, so it carries no fs scope of its own.

/// The path with every symlink resolved; rejects with the io error's text, e.g. "… (os error 2)".
#[tauri::command]
pub fn real_path(path: String) -> Result<String, String> {
    std::fs::canonicalize(&path).map(|p| p.to_string_lossy().into_owned()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_a_symlinked_dir_and_rejects_a_missing_path_with_its_errno() {
        let root = std::env::temp_dir().join(format!("loadout-real-path-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("real")).unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("link")).unwrap();
        let canonical_root = std::fs::canonicalize(&root).unwrap();

        let resolved = real_path(root.join("link").to_string_lossy().into_owned()).unwrap();
        assert_eq!(resolved, canonical_root.join("real").to_string_lossy());
        let missing = real_path(root.join("none").to_string_lossy().into_owned()).unwrap_err();
        assert!(missing.ends_with("(os error 2)"), "{missing}");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
