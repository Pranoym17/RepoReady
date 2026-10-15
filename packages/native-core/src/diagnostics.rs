//! Diagnostics deliberately accept no free-form messages, URLs, identifiers or paths.
use crate::storage::guard_path;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
const LIMIT: u64 = 65536;
static LOG_LOCK: Mutex<()> = Mutex::new(());
#[derive(Serialize, Deserialize, Clone, Copy)]
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
#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Component {
    Desktop,
    Catalog,
    Storage,
    Update,
}
#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(deny_unknown_fields)]
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
    for name in [
        "owner",
        "events.log",
        "events.previous.log",
        "events.prune.pending",
    ] {
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
    for name in ["events.log", "events.previous.log", "events.prune.pending"] {
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
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "CLOCK_ANOMALY")?
        .as_secs();
    prune_at(root, days, now)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    timestamp: u64,
    event: Event,
}

fn prune_at(root: &Path, days: u64, now: u64) -> Result<(), String> {
    if !(1..=30).contains(&days) {
        return Err("INVALID_PREFERENCES".into());
    }
    let _lock = LOG_LOCK.lock().map_err(|_| "LOG_STORAGE_FAILED")?;
    safe(root)?;
    let pending = root.join("events.prune.pending");
    // A crash before replacement can leave an older temporary record set. Never retain it.
    if pending.exists() {
        fs::remove_file(&pending).map_err(|_| "LOG_STORAGE_FAILED")?;
    }
    for name in ["events.log", "events.previous.log"] {
        let path = root.join(name);
        let file = match fs::File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("LOG_STORAGE_FAILED".into()),
        };
        let mut bytes = Vec::new();
        file.take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "LOG_STORAGE_FAILED")?;
        if bytes.len() as u64 > LIMIT {
            return Err("LOG_TOO_LARGE".into());
        }
        let mut retained = Vec::new();
        for line in bytes.split(|byte| *byte == b'\n') {
            if let Ok(record) = serde_json::from_slice::<Record>(line)
                && record.timestamp >= now.saturating_sub(days * 86400)
                && record.timestamp <= now
            {
                serde_json::to_writer(&mut retained, &record).map_err(|_| "LOG_STORAGE_FAILED")?;
                retained.push(b'\n');
            }
        }
        if retained == bytes {
            continue;
        }
        // The exact temporary file is owned by this logger. A directory or link is never removed.
        if pending.exists() {
            fs::remove_file(&pending).map_err(|_| "LOG_STORAGE_FAILED")?;
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
            .map_err(|_| "LOG_STORAGE_FAILED")?;
        output
            .write_all(&retained)
            .and_then(|_| output.sync_all())
            .map_err(|_| "LOG_STORAGE_FAILED")?;
        drop(output);
        fs::rename(&pending, &path).map_err(|_| "LOG_STORAGE_FAILED")?;
    }
    Ok(())
}

/// Any legacy diagnostic context is discarded in full. Never truncate a credential.
pub fn redact_context(_untrusted: &str) -> &'static str {
    "[redacted]"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retention_uses_record_age_even_when_recent_activity_refreshes_file_time() {
        let root = tempfile::tempdir().unwrap();
        let _store = crate::storage::Store::open(root.path()).unwrap();
        let now = 2_000_000_000u64;
        for name in ["events.log", "events.previous.log"] {
            let records=[now-30*86400,now-7*86400,now,now+1].map(|timestamp|serde_json::json!({"timestamp":timestamp,"event":{"code":"STARTED","component":"desktop"}}).to_string());
            fs::write(
                root.path().join(name),
                records.join("\n") + "\n{\"secret\":\"untrusted\"}\ninvalid\n",
            )
            .unwrap();
        }
        prune_at(root.path(), 7, now).unwrap();
        for name in ["events.log", "events.previous.log"] {
            let bytes = fs::read_to_string(root.path().join(name)).unwrap();
            let records: Vec<Record> = bytes
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            assert_eq!(
                records.iter().map(|r| r.timestamp).collect::<Vec<_>>(),
                [now - 7 * 86400, now]
            );
            assert!(!bytes.contains("secret"));
        }
        prune_at(root.path(), 1, now + 86401).unwrap();
        assert_eq!(fs::read(root.path().join("events.log")).unwrap(), b"");
    }
    #[test]
    fn malformed_future_and_oversized_logs_cannot_escape_retention_bounds() {
        let root = tempfile::tempdir().unwrap();
        let _store = crate::storage::Store::open(root.path()).unwrap();
        fs::write(
            root.path().join("events.log"),
            vec![b'x'; LIMIT as usize + 1],
        )
        .unwrap();
        assert_eq!(prune_at(root.path(), 7, 100).unwrap_err(), "LOG_TOO_LARGE");
        assert!(prune_at(root.path(), 0, 100).is_err());
        fs::write(root.path().join("events.log"), b"not-json\n").unwrap();
        prune_at(root.path(), 7, 0).unwrap();
        assert!(fs::read(root.path().join("events.log")).unwrap().is_empty());
        fs::write(
            root.path().join("events.prune.pending"),
            b"old crash residue",
        )
        .unwrap();
        prune_at(root.path(), 7, 100).unwrap();
        assert!(!root.path().join("events.prune.pending").exists());
        fs::write(
            root.path().join("events.prune.pending"),
            b"old crash residue",
        )
        .unwrap();
        clear(root.path()).unwrap();
        assert!(!root.path().join("events.prune.pending").exists());
    }
}
