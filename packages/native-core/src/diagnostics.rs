//! Diagnostics deliberately accept no free-form messages, URLs, identifiers or paths.
use crate::storage::guard_path;
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
const LIMIT: u64 = 65536;
static LOG_LOCK: Mutex<()> = Mutex::new(());
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Code {
    Started,
    CatalogRefreshed,
    CatalogUnavailable,
    CatalogRejected,
    CacheCleared,
    SettingsSaved,
    StorageRecoveryRequired,
    UpdateUnavailable,
}
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Component {
    Desktop,
    Catalog,
    Storage,
    Update,
}
#[derive(Serialize, Clone, Copy)]
pub struct Event {
    pub code: Code,
    pub component: Component,
}
fn safe(root: &Path) -> Result<(), String> {
    guard_path(root)?;
    if fs::read_to_string(root.join("owner")).map_err(|_| "LOG_STORAGE_FAILED")?
        != "RepoReady native state v1\n"
    {
        return Err("UNOWNED_STATE_ROOT".into());
    }
    for name in ["owner", "events.log", "events.previous.log"] {
        guard_path(&root.join(name))?;
    }
    Ok(())
}
pub fn write(root: &Path, event: Event) -> Result<(), String> {
    let _lock = LOG_LOCK.lock().map_err(|_| "LOG_STORAGE_FAILED")?;
    safe(root)?;
    let line=serde_json::to_vec(&serde_json::json!({"timestamp":SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_|"CLOCK_ANOMALY")?.as_secs(),"event":event})).map_err(|_|"LOG_STORAGE_FAILED")?;
    let path = root.join("events.log");
    let previous = root.join("events.previous.log");
    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size + line.len() as u64 + 1 > LIMIT {
        if previous.exists() {
            fs::remove_file(&previous).map_err(|_| "LOG_STORAGE_FAILED")?;
        }
        fs::rename(&path, &previous).map_err(|_| "LOG_STORAGE_FAILED")?;
    }
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .map_err(|_| "LOG_STORAGE_FAILED")?;
    file.write_all(&line)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_data())
        .map_err(|_| "LOG_STORAGE_FAILED".into())
}
pub fn clear(root: &Path) -> Result<(), String> {
    let _lock = LOG_LOCK.lock().map_err(|_| "LOG_STORAGE_FAILED")?;
    safe(root)?;
    for name in ["events.log", "events.previous.log"] {
        let path = root.join(name);
        if path.exists() {
            fs::remove_file(path).map_err(|_| "LOG_STORAGE_FAILED")?;
        }
    }
    Ok(())
}
pub fn bytes(root: &Path) -> Result<u64, String> {
    let _lock = LOG_LOCK.lock().map_err(|_| "LOG_STORAGE_FAILED")?;
    safe(root)?;
    Ok(["events.log", "events.previous.log"]
        .iter()
        .map(|name| fs::metadata(root.join(name)).map(|m| m.len()).unwrap_or(0))
        .sum())
}

pub fn prune(root: &Path, days: u64) -> Result<(), String> {
    if !(1..=30).contains(&days) {
        return Err("INVALID_PREFERENCES".into());
    }
    let _lock = LOG_LOCK.lock().map_err(|_| "LOG_STORAGE_FAILED")?;
    safe(root)?;
    for name in ["events.log", "events.previous.log"] {
        let path = root.join(name);
        if let Ok(metadata) = fs::metadata(&path) {
            let modified = metadata.modified().map_err(|_| "LOG_STORAGE_FAILED")?;
            if SystemTime::now()
                .duration_since(modified)
                .map(|age| age.as_secs() > days * 86400)
                .unwrap_or(false)
            {
                fs::remove_file(path).map_err(|_| "LOG_STORAGE_FAILED")?;
            }
        }
    }
    Ok(())
}

/// Any legacy diagnostic context is discarded in full. Never truncate a credential.
pub fn redact_context(_untrusted: &str) -> &'static str {
    "[redacted]"
}
