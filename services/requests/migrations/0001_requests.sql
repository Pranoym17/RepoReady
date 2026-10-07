-- Schema only. Public submission routes and moderation are not enabled in M0.
CREATE TABLE submissions (
 public_id TEXT PRIMARY KEY CHECK(length(public_id)=32),
 normalized_repo_id TEXT NOT NULL UNIQUE,
 github_repository_id INTEGER UNIQUE,
 github_owner TEXT NOT NULL, github_repo TEXT NOT NULL,
 count INTEGER NOT NULL DEFAULT 1 CHECK(count>0),
 status TEXT NOT NULL DEFAULT 'NEW' CHECK(status IN ('NEW','TRIAGE','APPROVED_FOR_REVIEW','REJECTED','DUPLICATE','PACKAGING','QA','READY','FAILED','ON_HOLD')),
 created_at TEXT NOT NULL, last_requested_at TEXT NOT NULL, moderator_notes TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE TABLE request_receipts (
 idempotency_key TEXT PRIMARY KEY, public_id TEXT NOT NULL REFERENCES submissions(public_id), expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX receipt_expiry ON request_receipts(expires_at);
CREATE TABLE rate_windows (
 bucket_hash TEXT NOT NULL, window_start TEXT NOT NULL, accepted INTEGER NOT NULL CHECK(accepted>=0), expires_at TEXT NOT NULL,
 PRIMARY KEY(bucket_hash,window_start)
) STRICT;
CREATE INDEX rate_expiry ON rate_windows(expires_at);
