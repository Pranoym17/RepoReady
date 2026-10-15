import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DesktopPreferences,
  DesktopSnapshot,
  ClientReleasePolicy,
} from "../src/index.js";

test("desktop preferences bound local disk and log retention without accepting arbitrary settings", () => {
  assert.deepEqual(
    DesktopPreferences.parse({ cacheLimitMb: 64, logRetentionDays: 7 }),
    { cacheLimitMb: 64, logRetentionDays: 7 },
  );
  for (const value of [
    { cacheLimitMb: 0, logRetentionDays: 7 },
    { cacheLimitMb: 64, logRetentionDays: 100 },
    { cacheLimitMb: 64, logRetentionDays: 7, sql: "DELETE" },
  ])
    assert.equal(DesktopPreferences.safeParse(value).success, false);
});

test("desktop public state cannot claim unimplemented app or request capabilities", () => {
  const value = {
    version: "0.1.0-alpha.1",
    mode: "development",
    catalog: {
      status: "not-configured",
      issuedAt: null,
      expiresAt: null,
      lastVerifiedAt: null,
      sequence: null,
      items: [],
    },
    library: [],
    preferences: { cacheLimitMb: 64, logRetentionDays: 7 },
    recoveryRequired: false,
    update: {
      status: "not-configured",
      version: null,
      messageCode: "NOT_CONFIGURED",
    },
    diagnostics: { logBytes: 0 },
    capabilities: { manageApps: false, requests: false },
    lastError: null,
  };
  assert.ok(DesktopSnapshot.safeParse(value).success);
  assert.equal(
    DesktopSnapshot.safeParse({
      ...value,
      capabilities: { manageApps: true, requests: false },
    }).success,
    false,
  );
  assert.equal(
    DesktopSnapshot.safeParse({ ...value, privateKey: "never" }).success,
    false,
  );
});

test("client update policy is version/target bound and distinct from a catalog", () => {
  const policy = {
    schemaVersion: 1,
    channel: "development",
    sequence: 1,
    issuedAt: "2026-10-15T00:00:00Z",
    expiresAt: "2026-10-16T00:00:00Z",
    release: {
      version: "0.1.0-alpha.2",
      target: "windows-x86_64",
      url: "https://example.org/fixtures/update.exe",
      sha256: "a".repeat(64),
      sizeBytes: 128,
      signature: "test-only",
    },
    holds: [],
  };
  assert.ok(ClientReleasePolicy.safeParse(policy).success);
  for (const value of [
    { ...policy, schemaVersion: 2 },
    { ...policy, issuedAt: "2026-10-15T00:00:00.123Z" },
    { ...policy, release: { ...policy.release, target: "linux-x86_64" } },
    { ...policy, release: { ...policy.release, sizeBytes: 0 } },
  ])
    assert.equal(ClientReleasePolicy.safeParse(value).success, false);
});
