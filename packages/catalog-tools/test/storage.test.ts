import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, backup } from "node:sqlite";
import { readFileSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("local schema enforces exclusive operations, terminal dates and bounded preferences", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      readFileSync(
        new URL(
          "../../../apps/desktop/src-tauri/migrations/001_foundation.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const add = db.prepare(
      "INSERT INTO install_transactions(id,app_id,version,stage,started_at) VALUES(?,?,?,?,?)",
    );
    add.run("op-a", "app-a", "1.0.0", "preflight", "2026-10-04T12:00:00Z");
    assert.throws(() =>
      add.run("op-b", "app-a", "1.0.0", "preflight", "2026-10-04T12:00:00Z"),
    );
    assert.throws(() =>
      db.exec("UPDATE install_transactions SET stage='installed'"),
    );
    db.exec(
      "UPDATE install_transactions SET stage='failed',finished_at='2026-10-04T12:01:00Z'",
    );
    add.run("op-b", "app-a", "1.0.0", "preflight", "2026-10-04T12:02:00Z");
    assert.throws(() =>
      db.exec("INSERT INTO preferences VALUES('api_key','should-not-store')"),
    );
    const columns = db
      .prepare("PRAGMA table_info(credential_state)")
      .all()
      .map((r) => r.name);
    assert.deepEqual(columns, ["app_id", "provider", "configured"]);
  } finally {
    db.close();
  }
});

test("SQLite backup remains readable after a failed migration is rolled back", async () => {
  const db = new DatabaseSync(":memory:");
  const directory = mkdtempSync(join(tmpdir(), "repoready-m0-"));
  const file = join(directory, "backup.sqlite");
  try {
    db.exec(
      readFileSync(
        new URL(
          "../../../apps/desktop/src-tauri/migrations/001_foundation.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    db.exec("INSERT INTO preferences VALUES('analytics_enabled','false')");
    await backup(db, file);
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() =>
      db.exec(
        "CREATE TABLE attempted_upgrade(value TEXT); INSERT INTO missing_table VALUES(1)",
      ),
    );
    db.exec("ROLLBACK");
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE name='attempted_upgrade'",
        )
        .get()?.count,
      0,
    );
    const saved = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(
        saved.prepare("PRAGMA integrity_check").get()?.integrity_check,
        "ok",
      );
      assert.equal(
        saved
          .prepare(
            "SELECT value FROM preferences WHERE name='analytics_enabled'",
          )
          .get()?.value,
        "false",
      );
      assert.equal(
        saved
          .prepare("SELECT max(version) AS version FROM schema_migrations")
          .get()?.version,
        1,
      );
    } finally {
      saved.close();
    }
  } finally {
    db.close();
    unlinkSync(file);
    rmdirSync(directory);
  }
});

test("request schema constrains deduplication identities, receipts and review states", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(
      readFileSync(
        new URL(
          "../../../services/requests/migrations/0001_requests.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const add = db.prepare(
      "INSERT INTO submissions(public_id,normalized_repo_id,github_owner,github_repo,created_at,last_requested_at) VALUES(?,?,?,?,?,?)",
    );
    add.run(
      "a".repeat(32),
      "example/project",
      "example",
      "project",
      "2026-10-04T12:00:00Z",
      "2026-10-04T12:00:00Z",
    );
    assert.throws(() =>
      add.run(
        "b".repeat(32),
        "example/project",
        "example",
        "project",
        "2026-10-04T12:00:00Z",
        "2026-10-04T12:00:00Z",
      ),
    );
    assert.throws(() => db.exec("UPDATE submissions SET status='AUTO_BUILD'"));
    const receipt = db.prepare("INSERT INTO request_receipts VALUES(?,?,?)");
    receipt.run("test-idempotency", "a".repeat(32), "2026-10-05T12:00:00Z");
    assert.throws(() =>
      receipt.run("test-idempotency", "a".repeat(32), "2026-10-05T12:00:00Z"),
    );
    assert.throws(() =>
      receipt.run("missing-parent", "c".repeat(32), "2026-10-05T12:00:00Z"),
    );
  } finally {
    db.close();
  }
});
