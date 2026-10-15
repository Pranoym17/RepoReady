CREATE TABLE migration_checksums(version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT;
CREATE TABLE catalog_snapshots(channel TEXT PRIMARY KEY CHECK(channel='stable'), envelope BLOB NOT NULL, accepted_at INTEGER NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
CREATE TABLE catalog_details(app_id TEXT NOT NULL, version TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(app_id,version)) STRICT;
CREATE TABLE desktop_settings(singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL) STRICT;
INSERT INTO desktop_settings VALUES(1,'{"cacheLimitMb":64,"logRetentionDays":7}');
CREATE TABLE client_update_state(channel TEXT PRIMARY KEY CHECK(channel IN ('stable','development')), highest_sequence INTEGER NOT NULL CHECK(highest_sequence>0), accepted_digest TEXT NOT NULL CHECK(length(accepted_digest)=64), envelope BLOB NOT NULL, accepted_at INTEGER NOT NULL) STRICT;
CREATE TABLE client_update_intents(channel TEXT PRIMARY KEY CHECK(channel IN ('stable','development')), version TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('downloading','downloaded','installing','completed','failed','interrupted','recovery-required')), updated_at INTEGER NOT NULL) STRICT;
INSERT INTO schema_migrations VALUES(2,strftime('%Y-%m-%dT%H:%M:%SZ','now'));
