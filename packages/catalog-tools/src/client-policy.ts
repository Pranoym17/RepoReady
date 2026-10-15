/** Protected-release helper only. Its output remains subject to native policy/artifact verification. */
import { createPublicKey, sign, type KeyObject } from "node:crypto";
import { ClientReleasePolicy, SignedEnvelope } from "@repoready/contracts";
const domain = Buffer.from("repoready.client-update.v1:");
export function signClientPolicy(
  input: unknown,
  privateKey: KeyObject,
  keyId: string,
  authority: {
    channel: string;
    policyKeys: Record<string, string>;
    artifactOrigins: string[];
    artifactPublicKey: string;
  },
  now = Math.floor(Date.now() / 1000),
) {
  const policy = ClientReleasePolicy.parse(input);
  if (
    privateKey.type !== "private" ||
    privateKey.asymmetricKeyType !== "ed25519" ||
    authority.channel !== policy.channel
  )
    throw new Error("Invalid policy signing context");
  const issued = Date.parse(policy.issuedAt) / 1000,
    expires = Date.parse(policy.expiresAt) / 1000;
  if (
    issued > now ||
    expires <= now ||
    expires <= issued ||
    expires - issued > 7 * 86400
  )
    throw new Error("Invalid policy lifetime");
  const key = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  if (authority.policyKeys[keyId] !== key.toString("hex"))
    throw new Error("Policy signing key does not match reviewed pin");
  const artifactKeyText = Buffer.from(
    authority.artifactPublicKey,
    "base64",
  ).toString("utf8");
  const artifactKey = Buffer.from(
    artifactKeyText.split(/\r?\n/)[1] ?? "",
    "base64",
  );
  if (
    !artifactKeyText.startsWith("untrusted comment: ") ||
    artifactKey.length !== 42 ||
    artifactKey.subarray(10).equals(key)
  )
    throw new Error("Independent artifact key is required");
  const url = new URL(policy.release.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !authority.artifactOrigins.includes(url.origin) ||
    /latest/i.test(url.pathname) ||
    !url.pathname
      .split("/")
      .some(
        (part) =>
          part === policy.release.version ||
          part === `v${policy.release.version}`,
      )
  )
    throw new Error("Unapproved artifact URL");
  const bytes = Buffer.from(JSON.stringify(policy));
  const envelope = SignedEnvelope.parse({
    schemaVersion: 1,
    keyId,
    payload: bytes.toString("base64"),
    signature: sign(null, Buffer.concat([domain, bytes]), privateKey).toString(
      "hex",
    ),
  });
  if (Buffer.byteLength(JSON.stringify(envelope)) > 96 * 1024)
    throw new Error("Policy envelope too large");
  return envelope;
}
