import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  schemas,
  validateManifest,
  normalizeGithubUrl,
  canTransition,
  reconcileStage,
} from "../src/index.js";
type Case = {
  name: string;
  schema: keyof typeof schemas;
  valid: boolean;
  value: unknown;
};
const cases = JSON.parse(
  readFileSync(new URL("../fixtures/cases.json", import.meta.url), "utf8"),
) as Case[];
for (const entry of cases)
  test(entry.name, () =>
    assert.equal(
      schemas[entry.schema].safeParse(entry.value).success,
      entry.valid,
    ),
  );
test("canonical GitHub normalization rejects fetch and path tricks", () => {
  assert.equal(
    normalizeGithubUrl("https://GitHub.com/Owner/Project.git/"),
    "https://github.com/owner/project",
  );
  for (const input of [
    "http://github.com/a/b",
    "https://github.com.evil.test/a/b",
    "https://user@github.com/a/b",
    "https://github.com/a/..",
    "https://github.com/a/b/issues",
    "https://github.com/a/b?x=1",
    "https://github.com/a/%2e%2e",
    "https://github.com:443/a/b",
  ])
    assert.throws(() => normalizeGithubUrl(input));
});
test("post-installer crashes require recovery rather than fake success or cancel", () => {
  assert.equal(canTransition("installing", "canceled"), false);
  assert.equal(canTransition("preflight", "installed"), false);
  assert.equal(canTransition("checking", "committing"), true);
  assert.equal(reconcileStage("installing"), "recovery-required");
  assert.equal(reconcileStage("downloading"), "failed");
  assert.equal(reconcileStage("installed"), "installed");
  assert.throws(() => reconcileStage("unknown"));
});
test("certification, identity and disclosures are bound to one artifact", () => {
  const fixture = cases.find(
    (entry) => entry.schema === "InstallManifest" && entry.valid,
  );
  assert.ok(fixture);
  const good = validateManifest(fixture.value);
  for (const mutate of [
    (v: typeof good) => {
      v.artifact.sha256 = "b".repeat(64);
    },
    (v: typeof good) => {
      v.release.appId = "other";
    },
    (v: typeof good) => {
      v.app.status = "requested";
    },
    (v: typeof good) => {
      v.app.requirements.externalApiProviders = ["provider"];
    },
  ]) {
    const changed = structuredClone(good);
    mutate(changed);
    assert.throws(() => validateManifest(changed));
  }
});
