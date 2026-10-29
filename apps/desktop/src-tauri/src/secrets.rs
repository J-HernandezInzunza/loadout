// The Keychain commands behind HostSecrets (architecture.md §5.5): one generic password per key (the
// account's host), under the app's service. No plugin reaches the Keychain, hence commands (§2.4).
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
    get(&entry(&key)?)
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    set(&entry(&key)?, &value)
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    delete(&entry(&key)?)
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
}
