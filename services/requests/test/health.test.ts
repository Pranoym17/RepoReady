import { test } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.js";
test("health is minimal and unsupported features do not imply availability", async () => {
  const health = await app.request("/api/v1/health");
  assert.deepEqual(await health.json(), { status: "ok", stage: "foundation" });
  assert.equal((await app.request("/api/v1/requests")).status, 404);
});
