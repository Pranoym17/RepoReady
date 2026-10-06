import { createHash, verify, type KeyObject } from "node:crypto";
import {
  Artifact,
  CatalogIndex,
  SignedEnvelope,
  validateManifest,
} from "@repoready/contracts";
import type { z } from "zod";
export const DOMAIN = Buffer.from("repoready.catalog.v1:");
export const MAX_ENVELOPE_BYTES = 1_500_000;
export const MAX_PAYLOAD_BYTES = 1_000_000;
export type Index = z.infer<typeof CatalogIndex>;
export type TrustState = {
  highestSequence: number;
  acceptedDigest: string | null;
};
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function verifyCatalog(
  bytes: Uint8Array,
  pinnedKeys: ReadonlyMap<string, KeyObject>,
  now: number,
  state: TrustState,
): { index: Index; digest: string } {
  if (bytes.length > MAX_ENVELOPE_BYTES) throw new Error("Catalog too large");
  const envelope = SignedEnvelope.parse(
    JSON.parse(Buffer.from(bytes).toString("utf8")),
  );
  const key = pinnedKeys.get(envelope.keyId);
  if (!key || key.asymmetricKeyType !== "ed25519")
    throw new Error("Unknown key");
  const payload = Buffer.from(envelope.payload, "base64");
  if (
    payload.length > MAX_PAYLOAD_BYTES ||
    payload.toString("base64") !== envelope.payload
  )
    throw new Error("Invalid payload");
  if (
    !verify(
      null,
      Buffer.concat([DOMAIN, payload]),
      key,
      Buffer.from(envelope.signature, "hex"),
    )
  )
    throw new Error("Untrusted catalog");
  const index = CatalogIndex.parse(JSON.parse(payload.toString("utf8")));
  const digest = sha256(payload);
  if (
    index.sequence < state.highestSequence ||
    (index.sequence === state.highestSequence &&
      digest !== state.acceptedDigest)
  )
    throw new Error("Replayed or equivocated catalog");
  const issued = Date.parse(index.issuedAt);
  const expires = Date.parse(index.expiresAt);
  if (
    !Number.isSafeInteger(now) ||
    issued > now ||
    expires <= now ||
    expires <= issued ||
    expires - issued > 7 * 86400000
  )
    throw new Error("Stale catalog or invalid clock");
  const pairs = index.details.map((r) => r.appId + "/" + r.version);
  if (new Set(pairs).size !== pairs.length)
    throw new Error("Duplicate release identity");
  return { index, digest };
}
// Maintainer lint helper, not consumer authorization: callers must first verifyCatalog.
export function verifyDetail(
  index: Index,
  appId: string,
  version: string,
  bytes: Uint8Array,
) {
  CatalogIndex.parse(index);
  if (bytes.length > MAX_PAYLOAD_BYTES) throw new Error("Detail too large");
  if (index.holds.some((h) => h.appId === appId && h.version === version))
    throw new Error("Version held");
  const reference = index.details.find(
    (r) => r.appId === appId && r.version === version,
  );
  if (!reference || reference.sha256 !== sha256(bytes))
    throw new Error("Detail digest mismatch");
  const value = validateManifest(
    JSON.parse(Buffer.from(bytes).toString("utf8")),
  );
  if (value.app.id !== appId || value.release.version !== version)
    throw new Error("Detail identity mismatch");
  Artifact.parse(value.artifact);
  return value;
}
