import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { signClientPolicy } from "../src/client-policy.js";
test("protected policy helper binds exact bytes, reviewed key role, origin and freshness", () => {
  // Ephemeral keys stay in memory. No private file, production configuration or installer exists.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicBytes = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const artifact = generateKeyPairSync("ed25519")
    .publicKey.export({ format: "der", type: "spki" })
    .subarray(-32);
  const artifactKey = (key: Buffer) =>
    Buffer.from(
      "untrusted comment: TEST public key\n" +
        Buffer.concat([Buffer.from("Ed"), Buffer.alloc(8), key]).toString(
          "base64",
        ) +
        "\n",
    ).toString("base64");
  const authority = {
    channel: "development",
    policyKeys: { "test-policy": publicBytes.toString("hex") },
    artifactOrigins: ["https://updates.repoready.org"],
    artifactPublicKey: artifactKey(artifact),
  };
  const now = 1_792_022_400;
  const policy = {
    schemaVersion: 1,
    channel: "development",
    sequence: 2,
    issuedAt: new Date(now * 1000).toISOString().replace(".000Z", "Z"),
    expiresAt: new Date((now + 86400) * 1000)
      .toISOString()
      .replace(".000Z", "Z"),
    release: {
      version: "0.1.0-alpha.2",
      target: "windows-x86_64",
      url: "https://updates.repoready.org/0.1.0-alpha.2/client.exe",
      sha256: "a".repeat(64),
      sizeBytes: 10,
      signature: "TEST shape only",
    },
    holds: [],
  };
  const envelope = signClientPolicy(
    policy,
    privateKey,
    "test-policy",
    authority,
    now,
  );
  const bytes = Buffer.from(envelope.payload, "base64"),
    signature = Buffer.from(envelope.signature, "hex");
  assert.ok(
    verify(
      null,
      Buffer.concat([Buffer.from("repoready.client-update.v1:"), bytes]),
      publicKey,
      signature,
    ),
  );
  assert.equal(
    verify(
      null,
      Buffer.concat([Buffer.from("repoready.catalog.v1:"), bytes]),
      publicKey,
      signature,
    ),
    false,
  );
  assert.throws(() =>
    signClientPolicy(policy, privateKey, "unknown", authority, now),
  );
  assert.throws(() =>
    signClientPolicy(
      policy,
      privateKey,
      "test-policy",
      { ...authority, artifactPublicKey: artifactKey(publicBytes) },
      now,
    ),
  );
  assert.throws(() =>
    signClientPolicy(policy, privateKey, "test-policy", authority, now + 86400),
  );
  for (const url of [
    "https://evil.org/0.1.0-alpha.2/client.exe",
    "https://updates.repoready.org/latest/client.exe",
    "https://updates.repoready.org/0.1.0-alpha.2/client.exe?key=secret",
  ]) {
    assert.throws(() =>
      signClientPolicy(
        { ...policy, release: { ...policy.release, url } },
        privateKey,
        "test-policy",
        authority,
        now,
      ),
    );
  }
});
