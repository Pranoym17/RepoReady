use crate::catalog::{self, TrustState};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

const BASE: &str = include_str!("../../../apps/desktop/src-tauri/migrations/001_foundation.sql");
const DESKTOP: &str = include_str!("../../../apps/desktop/src-tauri/migrations/002_desktop.sql");
const MARKER: &str = "RepoReady native state v1\n";
fn error(_: impl std::fmt::Display) -> String {
    "STATE_STORAGE_FAILED".into()
}

pub fn guard_path(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        if let Ok(metadata) = fs::symlink_metadata(ancestor) {
            if metadata.file_type().is_symlink() {
                return Err("UNSAFE_STATE_PATH".into());
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err("UNSAFE_STATE_PATH".into());
                }
            }
        }
    }
    Ok(())
}

pub struct Store {
    connection: Connection,
    root: PathBuf,
    keys: BTreeMap<String, [u8; 32]>,
}
impl Store {
    pub fn open(root: &Path) -> Result<Self, String> {
        if !root.is_absolute()
            || root.parent().is_none()
            || root
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err("UNSAFE_STATE_PATH".into());
        }
        guard_path(root)?;
        fs::create_dir_all(root).map_err(error)?;
        for name in [
            "state.sqlite",
            "state.sqlite-wal",
            "state.sqlite-shm",
            "state.backup.sqlite",
            "state.backup.pending.sqlite",
            "owner",
            "events.log",
            "events.previous.log",
        ] {
            guard_path(&root.join(name))?;
        }
        let marker = root.join("owner");
        if marker.exists() {
            if fs::read_to_string(&marker).map_err(error)? != MARKER {
                return Err("UNOWNED_STATE_ROOT".into());
            }
        } else {
            for entry in fs::read_dir(root).map_err(error)? {
                let name = entry.map_err(error)?.file_name();
                if !["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"]
                    .iter()
                    .any(|known| name == *known)
                {
                    return Err("UNOWNED_STATE_ROOT".into());
                }
            }
            use std::io::Write;
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&marker)
                .map_err(error)?
                .write_all(MARKER.as_bytes())
                .map_err(error)?;
        }
        let mut connection = Connection::open(root.join("state.sqlite")).map_err(error)?;
        connection
            .busy_timeout(Duration::from_millis(500))
            .map_err(error)?;
        connection
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")
            .map_err(error)?;
        integrity(&connection)?;
        migrate(&mut connection, root)?;
        connection
            .execute_batch("PRAGMA journal_mode=WAL;")
            .map_err(error)?;
        let tx = connection.transaction().map_err(error)?;
        tx.execute("UPDATE install_transactions SET stage=CASE WHEN stage IN ('installing','checking','committing') THEN 'recovery-required' ELSE 'failed' END, error_code='RECOVERY_REQUIRED', recovery_state=CASE WHEN stage IN ('installing','checking','committing') THEN 'inspect' ELSE 'none' END, finished_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE stage NOT IN ('installed','canceled','failed','recovery-required')",[]).map_err(error)?;
        tx.execute("UPDATE client_update_intents SET stage=CASE WHEN stage='installing' THEN 'recovery-required' ELSE 'interrupted' END WHERE stage IN ('downloading','downloaded','installing')",[]).map_err(error)?;
        tx.commit().map_err(error)?;
        Ok(Self {
            connection,
            root: root.to_path_buf(),
            keys: BTreeMap::new(),
        })
    }
    pub fn set_catalog_keys(&mut self, keys: BTreeMap<String, [u8; 32]>) {
        self.keys = keys;
    }
    pub fn preferences(&self) -> Result<Value, String> {
        let raw: String = self
            .connection
            .query_row(
                "SELECT value FROM desktop_settings WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .map_err(error)?;
        let value = serde_json::from_str(&raw).map_err(error)?;
        validate_preferences(&value)?;
        Ok(value)
    }
    pub fn save_preferences(&self, value: &Value) -> Result<(), String> {
        validate_preferences(value)?;
        let tx = self.connection.unchecked_transaction().map_err(error)?;
        tx.execute(
            "UPDATE desktop_settings SET value=? WHERE singleton=1",
            [value.to_string()],
        )
        .map_err(error)?;
        let bytes:i64=tx.query_row("SELECT COALESCE((SELECT SUM(length(bytes)) FROM catalog_details),0)+COALESCE((SELECT length(envelope) FROM catalog_snapshots WHERE channel='stable'),0)",[],|row|row.get(0)).map_err(error)?;
        if bytes
            > value["cacheLimitMb"]
                .as_i64()
                .ok_or("INVALID_PREFERENCES")?
                * 1048576
        {
            tx.execute_batch("DELETE FROM catalog_details; DELETE FROM catalog_snapshots;")
                .map_err(error)?;
        }
        tx.commit().map_err(error)?;
        crate::diagnostics::prune(
            &self.root,
            value["logRetentionDays"]
                .as_u64()
                .ok_or("INVALID_PREFERENCES")?,
        )?;
        Ok(())
    }
    pub fn library(&self) -> Result<Vec<Value>, String> {
        let mut query=self.connection.prepare("SELECT app_id,version,artifact_sha256,install_method,installed_at,last_launch_at,update_status,source_summary FROM installed_apps ORDER BY app_id").map_err(error)?;
        let rows=query.query_map([],|row| Ok(json!({"appId":row.get::<_,String>(0)?,"version":row.get::<_,String>(1)?,"artifactSha256":row.get::<_,String>(2)?,"installMethod":row.get::<_,String>(3)?,"installedAt":row.get::<_,String>(4)?,"lastLaunchAt":row.get::<_,Option<String>>(5)?,"updateStatus":row.get::<_,String>(6)?,"sourceSummary":row.get::<_,String>(7)?}))).map_err(error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(error)
    }
    pub fn trust_state(&self) -> Result<TrustState, String> {
        Ok(self
            .connection
            .query_row(
                "SELECT highest_sequence,accepted_digest FROM catalog_state WHERE channel='stable'",
                [],
                |row| {
                    Ok(TrustState {
                        highest_sequence: row.get::<_, i64>(0)? as u64,
                        accepted_digest: Some(row.get(1)?),
                    })
                },
            )
            .optional()
            .map_err(error)?
            .unwrap_or_default())
    }
    pub fn accept_catalog(
        &mut self,
        envelope: &[u8],
        details: &BTreeMap<String, Vec<u8>>,
        keys: &BTreeMap<String, [u8; 32]>,
        now: i64,
    ) -> Result<(), String> {
        // Lock before reading the replay floor: concurrent refreshes cannot roll it back.
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(error)?;
        let state = tx
            .query_row(
                "SELECT highest_sequence,accepted_digest FROM catalog_state WHERE channel='stable'",
                [],
                |row| {
                    Ok(TrustState {
                        highest_sequence: row.get::<_, i64>(0)? as u64,
                        accepted_digest: Some(row.get(1)?),
                    })
                },
            )
            .optional()
            .map_err(error)?
            .unwrap_or_default();
        let verified = catalog::verify_index(envelope, keys, now, &state)?;
        let index = verified.index();
        let references = index["details"].as_array().ok_or("INVALID_CATALOG")?;
        if references.len() != details.len() {
            return Err("INCOMPLETE_CATALOG".into());
        }
        let mut total = 0usize;
        let preferences: String = tx
            .query_row(
                "SELECT value FROM desktop_settings WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .map_err(error)?;
        let preferences: Value = serde_json::from_str(&preferences).map_err(error)?;
        validate_preferences(&preferences)?;
        let budget = preferences["cacheLimitMb"]
            .as_u64()
            .ok_or("INVALID_PREFERENCES")?
            * 1048576;
        for reference in references {
            let id = reference["appId"].as_str().ok_or("INVALID_CATALOG")?;
            let version = reference["version"].as_str().ok_or("INVALID_CATALOG")?;
            let bytes = details
                .get(&format!("{id}/{version}"))
                .ok_or("INCOMPLETE_CATALOG")?;
            total = total.checked_add(bytes.len()).ok_or("CATALOG_TOO_LARGE")?;
            if total > 16_000_000
                || total + envelope.len() > budget as usize
                || bytes.len() > catalog::MAX_PAYLOAD_BYTES
            {
                return Err("CATALOG_TOO_LARGE".into());
            }
            let held = index["holds"].as_array().is_some_and(|holds| {
                holds
                    .iter()
                    .any(|hold| hold["appId"] == id && hold["version"] == version)
            });
            if held {
                if catalog::sha256(bytes)
                    != reference["sha256"].as_str().ok_or("INVALID_CATALOG")?
                {
                    return Err("DETAIL_HASH_MISMATCH".into());
                }
                let value: Value = serde_json::from_slice(bytes).map_err(error)?;
                crate::contracts::validate_manifest(&value)?;
                if value["app"]["id"] != id || value["release"]["version"] != version {
                    return Err("DETAIL_IDENTITY_MISMATCH".into());
                }
            } else {
                catalog::verify_detail(&verified, id, version, bytes, now)?;
            }
        }
        tx.execute("DELETE FROM catalog_details", [])
            .map_err(error)?;
        for reference in references {
            let id = reference["appId"].as_str().ok_or("INVALID_CATALOG")?;
            let version = reference["version"].as_str().ok_or("INVALID_CATALOG")?;
            tx.execute(
                "INSERT INTO catalog_details VALUES(?,?,?)",
                params![id, version, details[&format!("{id}/{version}")]],
            )
            .map_err(error)?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO catalog_snapshots VALUES('stable',?,?,?,?)",
            params![envelope, now, verified.issued_at(), verified.expires_at()],
        )
        .map_err(error)?;
        tx.execute(
            "INSERT OR REPLACE INTO catalog_state VALUES('stable',?,?,?)",
            params![
                verified.sequence() as i64,
                verified.digest(),
                now.to_string()
            ],
        )
        .map_err(error)?;
        tx.commit().map_err(error)?;
        self.keys = keys.clone();
        Ok(())
    }
    pub fn cache_snapshot(&self, now: i64) -> Result<Value, String> {
        let snapshot=self.connection.query_row("SELECT envelope,accepted_at,expires_at FROM catalog_snapshots WHERE channel='stable'",[],|row|Ok((row.get::<_,Vec<u8>>(0)?,row.get::<_,i64>(1)?,row.get::<_,i64>(2)?))).optional().map_err(error)?;
        let Some((bytes, accepted, expires)) = snapshot else {
            return Ok(json!({"status":"empty","apps":[],"executionAllowed":false}));
        };
        if now < accepted {
            return Err("CLOCK_ANOMALY".into());
        }
        let verified = catalog::verify_index(&bytes, &self.keys, accepted, &self.trust_state()?)?;
        if expires != verified.expires_at() {
            return Err("CACHE_CORRUPT".into());
        }
        let mut apps = Vec::new();
        for reference in verified.index()["details"]
            .as_array()
            .ok_or("INVALID_CATALOG")?
        {
            let id = reference["appId"].as_str().ok_or("INVALID_CATALOG")?;
            let version = reference["version"].as_str().ok_or("INVALID_CATALOG")?;
            let detail: Vec<u8> = self
                .connection
                .query_row(
                    "SELECT bytes FROM catalog_details WHERE app_id=? AND version=?",
                    params![id, version],
                    |row| row.get(0),
                )
                .map_err(error)?;
            if catalog::sha256(&detail) != reference["sha256"].as_str().ok_or("INVALID_CATALOG")? {
                return Err("CACHE_CORRUPT".into());
            }
            let manifest: Value = serde_json::from_slice(&detail).map_err(error)?;
            crate::contracts::validate_manifest(&manifest)?;
            let hold = verified.index()["holds"].as_array().and_then(|holds| {
                holds
                    .iter()
                    .find(|hold| hold["appId"] == id && hold["version"] == version)
            });
            apps.push(json!({"app":manifest["app"],"release":manifest["release"],"held":hold.is_some(),"holdStatus":hold.map(|hold|hold["status"].clone()),"executionAllowed":false}));
        }
        Ok(
            json!({"status":if now>=expires {"stale"}else{"verified"},"acceptedAt":accepted,"issuedAt":verified.issued_at(),"expiresAt":expires,"sequence":verified.sequence(),"apps":apps,"executionAllowed":false}),
        )
    }
    pub fn clear_catalog_cache(&mut self) -> Result<(), String> {
        let tx = self.connection.transaction().map_err(error)?;
        tx.execute_batch("DELETE FROM catalog_details; DELETE FROM catalog_snapshots;")
            .map_err(error)?;
        tx.commit().map_err(error)
    }
    pub fn clear_logs(&self) -> Result<(), String> {
        crate::diagnostics::clear(&self.root)
    }
    pub fn log_bytes(&self) -> Result<u64, String> {
        crate::diagnostics::prune(
            &self.root,
            self.preferences()?["logRetentionDays"]
                .as_u64()
                .ok_or("INVALID_PREFERENCES")?,
        )?;
        crate::diagnostics::bytes(&self.root)
    }
    pub fn log_event(&self, event: crate::diagnostics::Event) -> Result<(), String> {
        crate::diagnostics::prune(
            &self.root,
            self.preferences()?["logRetentionDays"]
                .as_u64()
                .ok_or("INVALID_PREFERENCES")?,
        )?;
        crate::diagnostics::write(&self.root, event)
    }
    pub fn update_trust_state(&self, channel: &str) -> Result<TrustState, String> {
        channel_valid(channel)?;
        Ok(self
            .connection
            .query_row(
                "SELECT highest_sequence,accepted_digest FROM client_update_state WHERE channel=?",
                [channel],
                |row| {
                    Ok(TrustState {
                        highest_sequence: row.get::<_, i64>(0)? as u64,
                        accepted_digest: Some(row.get(1)?),
                    })
                },
            )
            .optional()
            .map_err(error)?
            .unwrap_or_default())
    }
    /// Caller must authenticate with the client-update verifier before this purpose-specific CAS.
    pub fn accept_update_policy(
        &mut self,
        channel: &str,
        envelope: &[u8],
        sequence: u64,
        digest: &str,
        now: i64,
    ) -> Result<(), String> {
        channel_valid(channel)?;
        if sequence == 0
            || sequence > 9_007_199_254_740_991
            || envelope.len() > catalog::MAX_ENVELOPE_BYTES
            || digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("INVALID_UPDATE_STATE".into());
        }
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(error)?;
        let old: Option<(i64, String)> = tx
            .query_row(
                "SELECT highest_sequence,accepted_digest FROM client_update_state WHERE channel=?",
                [channel],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(error)?;
        if old.is_some_and(|(old_sequence, old_digest)| {
            sequence < old_sequence as u64
                || (sequence == old_sequence as u64 && digest != old_digest)
        }) {
            return Err("UPDATE_POLICY_REPLAYED".into());
        }
        tx.execute(
            "INSERT OR REPLACE INTO client_update_state VALUES(?,?,?,?,?)",
            params![channel, sequence as i64, digest, envelope, now],
        )
        .map_err(error)?;
        tx.commit().map_err(error)
    }
    pub fn update_policy(&self, channel: &str) -> Result<Option<Vec<u8>>, String> {
        channel_valid(channel)?;
        self.connection
            .query_row(
                "SELECT envelope FROM client_update_state WHERE channel=?",
                [channel],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)
    }
    pub fn save_update_intent(
        &self,
        channel: &str,
        version: &str,
        stage: &str,
        now: i64,
    ) -> Result<(), String> {
        channel_valid(channel)?;
        if version.len() > 80
            || version.is_empty()
            || !version
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte))
            || ![
                "downloading",
                "downloaded",
                "installing",
                "completed",
                "failed",
                "interrupted",
                "recovery-required",
            ]
            .contains(&stage)
        {
            return Err("INVALID_UPDATE_STATE".into());
        }
        self.connection
            .execute(
                "INSERT OR REPLACE INTO client_update_intents VALUES(?,?,?,?)",
                params![channel, version, stage, now],
            )
            .map_err(error)?;
        Ok(())
    }
    pub fn update_intent(&self, channel: &str) -> Result<Option<Value>, String> {
        channel_valid(channel)?;
        self.connection.query_row("SELECT version,stage,updated_at FROM client_update_intents WHERE channel=?",[channel],|row|Ok(json!({"version":row.get::<_,String>(0)?,"stage":row.get::<_,String>(1)?,"updatedAt":row.get::<_,i64>(2)?}))).optional().map_err(error)
    }
    pub fn recovery_required(&self) -> Result<bool, String> {
        self.connection.query_row("SELECT EXISTS(SELECT 1 FROM install_transactions WHERE stage='recovery-required') OR EXISTS(SELECT 1 FROM client_update_intents WHERE stage='recovery-required')",[],|row|row.get(0)).map_err(error)
    }
}

fn channel_valid(channel: &str) -> Result<(), String> {
    if !["stable", "development"].contains(&channel) {
        return Err("INVALID_UPDATE_CHANNEL".into());
    }
    Ok(())
}

fn validate_preferences(value: &Value) -> Result<(), String> {
    let obj = value.as_object().ok_or("INVALID_PREFERENCES")?;
    if obj.len() != 2
        || !value["logRetentionDays"]
            .as_u64()
            .is_some_and(|n| (1..=30).contains(&n))
        || !value["cacheLimitMb"]
            .as_u64()
            .is_some_and(|n| (16..=512).contains(&n))
    {
        return Err("INVALID_PREFERENCES".into());
    }
    Ok(())
}
fn integrity(connection: &Connection) -> Result<(), String> {
    let result: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(error)?;
    if result != "ok" {
        return Err("STATE_DATABASE_CORRUPT".into());
    }
    Ok(())
}
fn migrate(connection: &mut Connection, root: &Path) -> Result<(), String> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='schema_migrations')",
            [],
            |row| row.get(0),
        )
        .map_err(error)?;
    if !exists {
        let count: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table'",
                [],
                |row| row.get(0),
            )
            .map_err(error)?;
        if count != 0 {
            return Err("STATE_SCHEMA_UNKNOWN".into());
        }
        connection.execute_batch(BASE).map_err(error)?;
    }
    let versions: Vec<i64> = connection
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .map_err(error)?
        .query_map([], |row| row.get(0))
        .map_err(error)?
        .collect::<Result<_, _>>()
        .map_err(error)?;
    if versions != [1] && versions != [1, 2] {
        return Err("STATE_SCHEMA_UNKNOWN".into());
    }
    // Validate existing M0 SQL, rather than blessing an arbitrary unchecksummed baseline.
    let reference = Connection::open_in_memory().map_err(error)?;
    reference.execute_batch(BASE).map_err(error)?;
    let mut statement = reference
        .prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
        .map_err(error)?;
    for item in statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(error)?
    {
        let (name, sql) = item.map_err(error)?;
        let actual: Option<String> = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name=?",
                [name],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?;
        if actual.as_deref() != Some(&sql) {
            return Err("STATE_SCHEMA_TAMPERED".into());
        }
    }
    if versions == [1] {
        let pending = root.join("state.backup.pending.sqlite");
        guard_path(&pending)?;
        if pending.exists() {
            fs::remove_file(&pending).map_err(error)?;
        }
        connection.backup("main", &pending, None).map_err(error)?;
        integrity(&Connection::open(&pending).map_err(error)?)?;
        let backup = root.join("state.backup.sqlite");
        // The known-good backup is retained across subsequent startups and failures.
        if !backup.exists() {
            fs::rename(&pending, &backup).map_err(error)?;
        } else {
            fs::remove_file(&pending).map_err(error)?;
        }
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(error)?;
        tx.execute_batch(DESKTOP).map_err(error)?;
        tx.execute(
            "INSERT INTO migration_checksums VALUES(1,?),(2,?)",
            params![
                catalog::sha256(BASE.as_bytes()),
                catalog::sha256(DESKTOP.as_bytes())
            ],
        )
        .map_err(error)?;
        tx.commit().map_err(error)?;
    }
    let checksums: Vec<(i64, String)> = connection
        .prepare("SELECT version,sha256 FROM migration_checksums ORDER BY version")
        .map_err(error)?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(error)?
        .collect::<Result<_, _>>()
        .map_err(error)?;
    if checksums
        != vec![
            (1, catalog::sha256(BASE.as_bytes())),
            (2, catalog::sha256(DESKTOP.as_bytes())),
        ]
    {
        return Err("STATE_MIGRATION_TAMPERED".into());
    }
    reference.execute_batch(DESKTOP).map_err(error)?;
    let mut statement = reference
        .prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
        .map_err(error)?;
    for item in statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(error)?
    {
        let (name, sql) = item.map_err(error)?;
        let actual: Option<String> = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name=?",
                [name],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?;
        if actual.as_deref() != Some(&sql) {
            return Err("STATE_SCHEMA_TAMPERED".into());
        }
    }
    Ok(())
}
