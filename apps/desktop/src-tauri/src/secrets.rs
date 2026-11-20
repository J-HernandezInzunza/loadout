// The Keychain commands behind HostSecrets (architecture.md §5.5): one generic password per key (the
// account's host), under the app's service. No plugin reaches the Keychain, hence commands (§2.4).
// A debug build on a debug profile (M16) keeps them in the profile's file instead (profile_file below).
use keyring::{Entry, Error};

const SERVICE: &str = "com.jhernandezinzunza.loadout";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

/// None when nothing is stored under the key.
fn get(entry: &Entry) -> Result<Option<String>, String> {
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn set(entry: &Entry, value: &str) -> Result<(), String> {
    entry.set_password(value).map_err(|e| e.to_string())
}

/// Succeeds when nothing was stored, as disconnecting an account that isn't connected does.
fn delete(entry: &Entry) -> Result<(), String> {
    match entry.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    #[cfg(debug_assertions)]
    if let Some(file) = profile_file::path() {
        return profile_file::get(&file, &key);
    }
    get(&entry(&key)?)
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    #[cfg(debug_assertions)]
    if let Some(file) = profile_file::path() {
        return profile_file::set(&file, &key, &value);
    }
    set(&entry(&key)?, &value)
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    #[cfg(debug_assertions)]
    if let Some(file) = profile_file::path() {
        return profile_file::delete(&file, &key);
    }
    delete(&entry(&key)?)
}

/// A debug profile's secrets (M16): a JSON object of key to value in the owner-only file that
/// LOADOUT_PROFILE_SECRETS names, which flows/profile.ts sets. macOS 26 won't let a profile's HOME have a
/// keychain that is both its default and unlockable, so profiles skip the Keychain. Debug builds only: a
/// release build has no such path, whatever its environment.
#[cfg(debug_assertions)]
mod profile_file {
    use serde_json::{Map, Value};
    use std::fs;
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    use std::path::{Path, PathBuf};

    pub fn path() -> Option<PathBuf> {
        std::env::var_os("LOADOUT_PROFILE_SECRETS").map(PathBuf::from)
    }

    /// Empty when the file doesn't exist yet.
    fn read(file: &Path) -> Result<Map<String, Value>, String> {
        match fs::read_to_string(file) {
            Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", file.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
            Err(e) => Err(format!("{}: {e}", file.display())),
        }
    }

    fn write(file: &Path, secrets: &Map<String, Value>) -> Result<(), String> {
        let text = serde_json::to_string_pretty(secrets).map_err(|e| e.to_string())?;
        let fail = |e: std::io::Error| format!("{}: {e}", file.display());
        let mut out = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(file).map_err(fail)?;
        // mode() applies only when the file is created.
        out.set_permissions(fs::Permissions::from_mode(0o600)).map_err(fail)?;
        out.write_all(text.as_bytes()).map_err(fail)
    }

    pub fn get(file: &Path, key: &str) -> Result<Option<String>, String> {
        Ok(read(file)?.get(key).and_then(Value::as_str).map(String::from))
    }

    pub fn set(file: &Path, key: &str, value: &str) -> Result<(), String> {
        let mut secrets = read(file)?;
        secrets.insert(key.into(), value.into());
        write(file, &secrets)
    }

    pub fn delete(file: &Path, key: &str) -> Result<(), String> {
        let mut secrets = read(file)?;
        if secrets.remove(key).is_some() {
            write(file, &secrets)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use keyring::mock::MockCredential;

    // keyring's mock store keeps a password in the entry itself, so each test works on one entry.
    fn mock_entry() -> Entry {
        Entry::new_with_credential(Box::new(MockCredential::default()))
    }

    #[test]
    fn get_is_none_until_set_and_after_delete() {
        let entry = mock_entry();
        assert_eq!(get(&entry), Ok(None));
        set(&entry, "{\"accessToken\":\"t\"}").unwrap();
        assert_eq!(get(&entry), Ok(Some("{\"accessToken\":\"t\"}".into())));
        delete(&entry).unwrap();
        assert_eq!(get(&entry), Ok(None));
    }

    #[test]
    fn deleting_nothing_succeeds() {
        assert_eq!(delete(&mock_entry()), Ok(()));
    }

    #[test]
    fn a_keychain_failure_is_an_error_not_none() {
        let entry = mock_entry();
        let mock: &MockCredential = entry.get_credential().downcast_ref().unwrap();
        mock.set_error(Error::PlatformFailure("locked".into()));
        assert!(get(&entry).unwrap_err().contains("locked"));
    }

    mod profile_file {
        use super::super::profile_file::{delete, get, set};
        use std::os::unix::fs::PermissionsExt;

        fn scratch(name: &str) -> std::path::PathBuf {
            let dir = std::env::temp_dir().join(format!("loadout-secrets-{}-{name}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            dir.join("secrets.json")
        }

        #[test]
        fn get_is_none_until_set_and_after_delete_and_the_file_is_owner_only() {
            let file = scratch("round-trip");
            assert_eq!(get(&file, "github"), Ok(None));
            set(&file, "github", "{\"accessToken\":\"t\"}").unwrap();
            set(&file, "bitbucket.org", "b").unwrap();
            assert_eq!(get(&file, "github"), Ok(Some("{\"accessToken\":\"t\"}".into())));
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
            delete(&file, "github").unwrap();
            assert_eq!(get(&file, "github"), Ok(None));
            assert_eq!(get(&file, "bitbucket.org"), Ok(Some("b".into())));
            std::fs::remove_dir_all(file.parent().unwrap()).unwrap();
        }

        #[test]
        fn deleting_nothing_succeeds_without_making_the_file() {
            let file = scratch("delete-nothing");
            assert_eq!(delete(&file, "github"), Ok(()));
            assert!(!file.exists());
            std::fs::remove_dir_all(file.parent().unwrap()).unwrap();
        }

        #[test]
        fn a_corrupt_file_is_an_error_not_none() {
            let file = scratch("corrupt");
            std::fs::write(&file, "not json").unwrap();
            assert!(get(&file, "github").unwrap_err().contains("secrets.json"));
            std::fs::remove_dir_all(file.parent().unwrap()).unwrap();
        }
    }
}
