use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use repoready_core::{
    catalog::{DOMAIN, sha256},
    diagnostics::{Code, Component, Event, redact_context},
    storage::Store,
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::Path};
const BASE: &str = include_str!("../../../apps/desktop/src-tauri/migrations/001_foundation.sql");
fn connection(root: &Path) -> Connection {
    Connection::open(root.join("state.sqlite")).unwrap()
}
type Fixture = (
    Vec<u8>,
    BTreeMap<String, Vec<u8>>,
    BTreeMap<String, [u8; 32]>,
    i64,
);
fn fixture(sequence: u64, held: bool) -> Fixture {
    let vector: Value =
        serde_json::from_str(include_str!("../../contracts/fixtures/catalog-vector.json")).unwrap();
    let detail = STANDARD
        .decode(vector["detailBase64"].as_str().unwrap())
        .unwrap();
    let now = vector["nowUnixSeconds"].as_i64().unwrap();
    // Existing, public M0 deterministic TEST seed. No private material is generated or persisted.
    let signing = SigningKey::from_bytes(&[7; 32]);
    let index = json!({"schemaVersion":1,"channel":"stable","sequence":sequence,"issuedAt":"2026-10-04T12:00:00Z","expiresAt":"2026-10-11T12:00:00Z","details":[{"appId":"test-fixture","version":"1.0.0","sha256":sha256(&detail)}],"holds":if held {json!([{"appId":"test-fixture","version":"1.0.0","status":"paused","reason":"Test hold"}])}else{json!([])}});
    let payload = serde_json::to_vec(&index).unwrap();
    let mut message = DOMAIN.to_vec();
    message.extend_from_slice(&payload);
    let envelope=serde_json::to_vec(&json!({"schemaVersion":1,"keyId":"test-only","payload":STANDARD.encode(&payload),"signature":hex::encode(signing.sign(&message).to_bytes())})).unwrap();
    (
        envelope,
        BTreeMap::from([("test-fixture/1.0.0".into(), detail)]),
        BTreeMap::from([("test-only".into(), signing.verifying_key().to_bytes())]),
        now,
    )
}
#[test]
fn fresh_restart_preferences_and_no_seed_library() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path()).unwrap();
    assert_eq!(
        store.preferences().unwrap(),
        json!({"cacheLimitMb":64,"logRetentionDays":7})
    );
    assert!(store.library().unwrap().is_empty());
    let prefs = json!({"cacheLimitMb":32,"logRetentionDays":3});
    store.save_preferences(&prefs).unwrap();
    drop(store);
    assert_eq!(
        Store::open(root.path()).unwrap().preferences().unwrap(),
        prefs
    );
    for value in [
        json!({"cacheLimitMb":64,"logRetentionDays":0}),
        json!({"cacheLimitMb":1,"logRetentionDays":7}),
        json!({"cacheLimitMb":64,"logRetentionDays":31}),
        json!({"cacheLimitMb":64,"logRetentionDays":7,"apiKey":"secret"}),
    ] {
        assert!(
            Store::open(root.path())
                .unwrap()
                .save_preferences(&value)
                .is_err()
        );
    }
}
#[test]
fn m0_upgrade_online_backup_and_operation_reconciliation() {
    let root = tempfile::tempdir().unwrap();
    let db = connection(root.path());
    db.execute_batch(BASE).unwrap();
    db.execute("INSERT INTO install_transactions(id,app_id,version,stage,started_at) VALUES('one','one','1.0.0','installing','2026-10-01T00:00:00Z'),('two','two','1.0.0','downloading','2026-10-01T00:00:00Z')",[]).unwrap();
    drop(db);
    let store = Store::open(root.path()).unwrap();
    let backup = root.path().join("state.backup.sqlite");
    assert!(backup.exists());
    let db = connection(root.path());
    assert_eq!(
        db.query_row(
            "SELECT stage FROM install_transactions WHERE id='one'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "recovery-required"
    );
    assert_eq!(
        db.query_row(
            "SELECT stage FROM install_transactions WHERE id='two'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "failed"
    );
    let backed = Connection::open(&backup).unwrap();
    assert_eq!(
        backed
            .query_row("SELECT max(version) FROM schema_migrations", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        1
    );
    assert_eq!(
        backed
            .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    let bytes = fs::read(&backup).unwrap();
    drop(store);
    Store::open(root.path()).unwrap();
    assert_eq!(fs::read(backup).unwrap(), bytes);
}
#[test]
fn corruption_unknown_versions_checksums_and_schema_tamper_are_refused() {
    for sql in [
        "INSERT INTO schema_migrations VALUES(3,'test')",
        "UPDATE migration_checksums SET sha256='0000000000000000000000000000000000000000000000000000000000000000' WHERE version=2",
        "ALTER TABLE catalog_details ADD COLUMN secret TEXT",
    ] {
        let root = tempfile::tempdir().unwrap();
        drop(Store::open(root.path()).unwrap());
        connection(root.path()).execute_batch(sql).unwrap();
        assert!(Store::open(root.path()).is_err());
    }
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("state.sqlite"), b"not a database").unwrap();
    assert!(Store::open(root.path()).is_err());
    assert_eq!(
        fs::read(root.path().join("state.sqlite")).unwrap(),
        b"not a database"
    );
}
#[test]
fn failed_migration_rolls_back_and_backup_failure_preserves_data() {
    let root = tempfile::tempdir().unwrap();
    let db = connection(root.path());
    db.execute_batch(BASE).unwrap();
    db.execute_batch("CREATE TABLE desktop_settings(unexpected TEXT);")
        .unwrap();
    drop(db);
    assert!(Store::open(root.path()).is_err());
    let db = connection(root.path());
    assert_eq!(
        db.query_row("SELECT max(version) FROM schema_migrations", [], |row| row
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        1
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='catalog_snapshots'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    drop(db);
    let root = tempfile::tempdir().unwrap();
    let db = connection(root.path());
    db.execute_batch(BASE).unwrap();
    drop(db);
    fs::create_dir(root.path().join("state.backup.pending.sqlite")).unwrap();
    assert!(Store::open(root.path()).is_err());
    assert_eq!(
        connection(root.path())
            .query_row("SELECT max(version) FROM schema_migrations", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        1
    );
}
#[test]
fn locked_database_is_reported_without_resetting_it() {
    let root = tempfile::tempdir().unwrap();
    drop(Store::open(root.path()).unwrap());
    let db = connection(root.path());
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert!(Store::open(root.path()).is_err());
    db.execute_batch("ROLLBACK").unwrap();
    assert!(Store::open(root.path()).is_ok());
}
#[test]
fn cache_atomicity_expiry_offline_clear_and_monotonic_floor() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let (envelope, details, keys, now) = fixture(2, false);
    store
        .accept_catalog(&envelope, &details, &keys, now)
        .unwrap();
    assert_eq!(store.cache_snapshot(now).unwrap()["status"], "verified");
    let old = store.cache_snapshot(now).unwrap();
    let (lower, _, _, _) = fixture(1, false);
    assert!(store.accept_catalog(&lower, &details, &keys, now).is_err());
    assert_eq!(store.cache_snapshot(now).unwrap(), old);
    let (newer, _, _, _) = fixture(3, false);
    assert!(
        store
            .accept_catalog(&newer, &BTreeMap::new(), &keys, now)
            .is_err()
    );
    assert_eq!(store.trust_state().unwrap().highest_sequence, 2);
    drop(store);
    let mut store = Store::open(root.path()).unwrap();
    store.set_catalog_keys(keys.clone());
    let offline = store.cache_snapshot(now + 10 * 86400).unwrap();
    assert_eq!(offline["status"], "stale");
    assert_eq!(offline["executionAllowed"], false);
    assert!(offline["apps"][0].get("artifact").is_none());
    assert!(store.cache_snapshot(now - 1).is_err());
    store.clear_catalog_cache().unwrap();
    assert_eq!(store.cache_snapshot(now).unwrap()["status"], "empty");
    assert_eq!(store.trust_state().unwrap().highest_sequence, 2);
    assert!(store.accept_catalog(&lower, &details, &keys, now).is_err());
}
#[test]
fn bad_hash_unknown_key_future_clock_and_equivocation_do_not_overwrite() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let (envelope, details, keys, now) = fixture(2, false);
    store
        .accept_catalog(&envelope, &details, &keys, now)
        .unwrap();
    let (newer, _, _, _) = fixture(3, false);
    let mut bad = details.clone();
    bad.get_mut("test-fixture/1.0.0").unwrap().push(b' ');
    assert!(store.accept_catalog(&newer, &bad, &keys, now).is_err());
    assert!(
        store
            .accept_catalog(&newer, &details, &BTreeMap::new(), now)
            .is_err()
    );
    assert!(
        store
            .accept_catalog(&newer, &details, &keys, now - 10 * 86400)
            .is_err()
    );
    let (equivocation, _, _, _) = fixture(2, true);
    assert!(
        store
            .accept_catalog(&equivocation, &details, &keys, now)
            .is_err()
    );
    assert_eq!(store.trust_state().unwrap().highest_sequence, 2);
}
#[test]
fn held_snapshots_are_descriptive_only_and_cache_corruption_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let (envelope, details, keys, now) = fixture(2, true);
    store
        .accept_catalog(&envelope, &details, &keys, now)
        .unwrap();
    assert_eq!(store.cache_snapshot(now).unwrap()["apps"][0]["held"], true);
    connection(root.path())
        .execute("UPDATE catalog_snapshots SET expires_at=expires_at+100", [])
        .unwrap();
    assert!(store.cache_snapshot(now).is_err());
    store.clear_catalog_cache().unwrap();
    store
        .accept_catalog(&envelope, &details, &keys, now)
        .unwrap();
    connection(root.path())
        .execute(
            "UPDATE catalog_details SET bytes=?",
            params![b"{}".to_vec()],
        )
        .unwrap();
    assert!(store.cache_snapshot(now).is_err());
}
#[test]
fn interrupted_promotion_rolls_back_every_table() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let (envelope, details, keys, now) = fixture(2, false);
    store
        .accept_catalog(&envelope, &details, &keys, now)
        .unwrap();
    connection(root.path()).execute_batch("CREATE TRIGGER fail_promote BEFORE INSERT ON catalog_details BEGIN SELECT RAISE(ABORT,'injected full disk'); END;").unwrap();
    let (newer, _, _, _) = fixture(3, false);
    assert!(store.accept_catalog(&newer, &details, &keys, now).is_err());
    assert_eq!(store.trust_state().unwrap().highest_sequence, 2);
    assert_eq!(store.cache_snapshot(now).unwrap()["sequence"], 2);
}
#[test]
fn concurrent_store_promotions_never_lower_floor() {
    let root = tempfile::tempdir().unwrap();
    let mut a = Store::open(root.path()).unwrap();
    let mut b = Store::open(root.path()).unwrap();
    let one = std::thread::spawn(move || {
        let (e, d, k, n) = fixture(3, false);
        a.accept_catalog(&e, &d, &k, n)
    });
    let two = std::thread::spawn(move || {
        let (e, d, k, n) = fixture(2, false);
        b.accept_catalog(&e, &d, &k, n)
    });
    let _ = one.join().unwrap();
    let _ = two.join().unwrap();
    assert_eq!(
        Store::open(root.path())
            .unwrap()
            .trust_state()
            .unwrap()
            .highest_sequence,
        3
    );
}
#[test]
fn logs_accept_only_typed_events_bound_storage_and_discard_context() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path()).unwrap();
    let secret =
        "Authorization: Bearer sk-secret https://host/a?token=secret C:\\Users\\Alice\\profile";
    assert_eq!(redact_context(secret), "[redacted]");
    for _ in 0..1500 {
        store
            .log_event(Event {
                code: Code::CatalogRejected,
                component: Component::Catalog,
            })
            .unwrap();
    }
    assert!(store.log_bytes().unwrap() <= 2 * 65536);
    assert!(root.path().join("events.previous.log").exists());
    for file in ["events.log", "events.previous.log"] {
        let text = fs::read_to_string(root.path().join(file)).unwrap();
        assert!(!text.contains("secret"));
        assert!(!text.contains("Alice"));
    }
    store.clear_logs().unwrap();
    assert_eq!(store.log_bytes().unwrap(), 0);
    assert_eq!(store.preferences().unwrap()["logRetentionDays"], 7);
}
#[test]
fn root_ownership_and_parent_path_escape_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("unowned.txt"), "preserve").unwrap();
    assert!(Store::open(root.path()).is_err());
    assert_eq!(
        fs::read_to_string(root.path().join("unowned.txt")).unwrap(),
        "preserve"
    );
    assert!(Store::open(Path::new("relative")).is_err());
    assert!(Store::open(&root.path().join("..").join("escape")).is_err());
}

#[test]
fn client_update_floor_is_separate_durable_monotonic_and_recovery_conservative() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let digest = sha256(b"test-only accepted client policy");
    store
        .accept_update_policy(
            "development",
            b"test-only signed bytes supplied after caller auth",
            3,
            &digest,
            100,
        )
        .unwrap();
    assert!(
        store
            .accept_update_policy("development", b"older", 2, &digest, 101)
            .is_err()
    );
    assert!(
        store
            .accept_update_policy("development", b"equivocated", 3, &sha256(b"other"), 101)
            .is_err()
    );
    store
        .save_update_intent("development", "0.1.0-alpha.1", "installing", 100)
        .unwrap();
    store.clear_catalog_cache().unwrap();
    assert_eq!(
        store
            .update_trust_state("development")
            .unwrap()
            .highest_sequence,
        3
    );
    assert_eq!(
        store.update_trust_state("stable").unwrap().highest_sequence,
        0
    );
    drop(store);
    let store = Store::open(root.path()).unwrap();
    assert_eq!(
        store.update_intent("development").unwrap().unwrap()["stage"],
        "recovery-required"
    );
    assert!(store.update_policy("development").unwrap().is_some());
    assert!(
        store
            .save_update_intent("arbitrary", "1.0.0", "completed", 101)
            .is_err()
    );
}
#[test]
fn library_survives_cache_clear_and_log_retention_is_applied() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    connection(root.path()).execute("INSERT INTO installed_apps(app_id,version,artifact_sha256,install_path,install_method,installed_at,source_summary,ownership_marker) VALUES('test-only','1.0.0',?,'test-only path','managed-folder','2026-10-01T00:00:00Z','fixture','test-only')",[sha256(b"test artifact")]).unwrap();
    store.clear_catalog_cache().unwrap();
    assert_eq!(store.library().unwrap().len(), 1);
    store
        .log_event(Event {
            code: Code::Started,
            component: Component::Desktop,
        })
        .unwrap();
    let file = fs::File::options()
        .write(true)
        .open(root.path().join("events.log"))
        .unwrap();
    file.set_times(fs::FileTimes::new().set_modified(std::time::SystemTime::UNIX_EPOCH))
        .unwrap();
    drop(file);
    assert_eq!(store.log_bytes().unwrap(), 0);
    drop(store);
    assert_eq!(
        Store::open(root.path()).unwrap().library().unwrap().len(),
        1
    );
}
