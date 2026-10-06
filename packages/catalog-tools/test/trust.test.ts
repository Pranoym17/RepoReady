import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  DOMAIN,
  sha256,
  verifyCatalog,
  verifyDetail,
  type Index,
} from "../src/index.js";
const seed = Buffer.alloc(32, 7); // Public deterministic TEST key; never a production key.
const privateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]),
  format: "der",
  type: "pkcs8",
});
const publicKey = createPublicKey(privateKey);
const keys = new Map([["test-only", publicKey]]);
const fixtures = JSON.parse(
  readFileSync(
    new URL("../../contracts/fixtures/cases.json", import.meta.url),
    "utf8",
  ),
) as { schema: string; valid: boolean; value: unknown }[];
const detail = Buffer.from(
  JSON.stringify(
    fixtures.find((f) => f.schema === "InstallManifest" && f.valid)?.value,
  ),
);
const index: Index = {
  schemaVersion: 1,
  channel: "stable",
  sequence: 2,
  issuedAt: "2026-10-04T12:00:00Z",
  expiresAt: "2026-10-11T12:00:00Z",
  details: [
    { appId: "test-fixture", version: "1.0.0", sha256: sha256(detail) },
  ],
  holds: [],
};
const now = Date.parse("2026-10-05T12:00:00Z");
const initial = { highestSequence: 0, acceptedDigest: null };
function envelope(value: unknown) {
  const payload = Buffer.from(JSON.stringify(value));
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      keyId: "test-only",
      payload: payload.toString("base64"),
      signature: sign(
        null,
        Buffer.concat([DOMAIN, payload]),
        privateKey,
      ).toString("hex"),
    }),
  );
}
test("catalog signatures bind exact bytes and detail references", () => {
  const signed = envelope(index);
  const trusted = verifyCatalog(signed, keys, now, initial);
  assert.equal(
    verifyDetail(trusted.index, "test-fixture", "1.0.0", detail).app.id,
    "test-fixture",
  );
  assert.throws(() =>
    verifyDetail(trusted.index, "test-fixture", "1.0.0", Buffer.from("{}")),
  );
  const tampered = JSON.parse(signed.toString());
  tampered.signature = "0".repeat(128);
  assert.throws(() =>
    verifyCatalog(Buffer.from(JSON.stringify(tampered)), keys, now, initial),
  );
  assert.throws(() => verifyCatalog(signed, new Map(), now, initial));
  assert.throws(() =>
    verifyCatalog(signed, keys, Date.parse(index.expiresAt), initial),
  );
  assert.throws(() => verifyCatalog(signed, keys, now - 7 * 86400000, initial));
  assert.throws(() =>
    verifyCatalog(signed, keys, now, {
      highestSequence: 3,
      acceptedDigest: null,
    }),
  );
  assert.throws(() =>
    verifyCatalog(signed, keys, now, {
      highestSequence: 2,
      acceptedDigest: "b".repeat(64),
    }),
  );
  assert.doesNotThrow(() =>
    verifyCatalog(signed, keys, now, {
      highestSequence: 2,
      acceptedDigest: trusted.digest,
    }),
  );
  assert.throws(() =>
    verifyCatalog(
      envelope({ ...index, details: [...index.details, ...index.details] }),
      keys,
      now,
      initial,
    ),
  );
  assert.throws(() =>
    verifyCatalog(envelope({ ...index, schemaVersion: 2 }), keys, now, initial),
  );
});
test("signed holds override previously ready detail", () => {
  const held = {
    ...index,
    holds: [
      {
        appId: "test-fixture",
        version: "1.0.0",
        status: "revoked" as const,
        reason: "Fixture only",
      },
    ],
  };
  assert.throws(() =>
    verifyDetail(
      verifyCatalog(envelope(held), keys, now, initial).index,
      "test-fixture",
      "1.0.0",
      detail,
    ),
  );
});
