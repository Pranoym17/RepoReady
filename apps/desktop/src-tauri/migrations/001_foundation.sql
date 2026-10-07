PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
CREATE TABLE installed_apps (
 app_id TEXT PRIMARY KEY, version TEXT NOT NULL, artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256)=64),
 install_path TEXT NOT NULL UNIQUE, install_method TEXT NOT NULL CHECK(install_method IN ('managed-folder','repoready-nsis','publisher-msi','publisher-exe')),
 installed_at TEXT NOT NULL, last_launch_at TEXT, update_status TEXT NOT NULL DEFAULT 'unknown' CHECK(update_status IN ('unknown','current','available','held')),
 source_summary TEXT NOT NULL, ownership_marker TEXT NOT NULL
) STRICT;
CREATE TABLE install_transactions (
 id TEXT PRIMARY KEY, app_id TEXT NOT NULL, version TEXT NOT NULL,
 stage TEXT NOT NULL CHECK(stage IN ('preflight','downloading','verifying','staging','installing','checking','committing','installed','canceled','failed','recovery-required')),
 bytes_downloaded INTEGER NOT NULL DEFAULT 0 CHECK(bytes_downloaded>=0), error_code TEXT,
 started_at TEXT NOT NULL, finished_at TEXT, recovery_state TEXT NOT NULL DEFAULT 'none' CHECK(recovery_state IN ('none','inspect','retry','guided-recovery')),
 CHECK((stage IN ('installed','canceled','failed','recovery-required')) = (finished_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX one_active_operation_per_app ON install_transactions(app_id) WHERE stage NOT IN ('installed','canceled','failed','recovery-required');
CREATE TABLE preferences(name TEXT PRIMARY KEY CHECK(name IN ('analytics_enabled','cache_limit_mb','update_channel')), value TEXT NOT NULL) STRICT;
CREATE TABLE credential_state(app_id TEXT NOT NULL, provider TEXT NOT NULL, configured INTEGER NOT NULL CHECK(configured IN (0,1)), PRIMARY KEY(app_id,provider)) STRICT;
CREATE TABLE catalog_state(channel TEXT PRIMARY KEY CHECK(channel='stable'), highest_sequence INTEGER NOT NULL CHECK(highest_sequence>0), accepted_digest TEXT NOT NULL CHECK(length(accepted_digest)=64), accepted_at TEXT NOT NULL) STRICT;
INSERT INTO schema_migrations VALUES(1, strftime('%Y-%m-%dT%H:%M:%SZ','now'));
COMMIT;
