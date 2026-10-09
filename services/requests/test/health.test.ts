import { test } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.js";
test("health is minimal and unsupported features do not imply availability", async () => {
  const health = await app.request("/api/v1/health");
  assert.deepEqual(await health.json(), { status: "ok", stage: "foundation" });
  const missing = await app.request("/api/v1/requests");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), {
    code: "NOT_AVAILABLE",
    retryable: false,
  });
});
