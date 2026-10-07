import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
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
