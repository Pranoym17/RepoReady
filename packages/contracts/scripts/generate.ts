import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { schemas } from "../src/index.js";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
const destination = new URL("../schemas/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  const content =
    JSON.stringify(z.toJSONSchema(schema, { target: "draft-7" }), null, 2) +
    "\n";
  const file = new URL(`${name}.json`, destination);
  if (process.argv.includes("--check")) {
    if ((await readFile(file, "utf8")) !== content)
      throw new Error(`Schema drift: ${name}`);
  } else {
    await writeFile(file, content);
  }
}

// Public deterministic interoperability vector. This seed is deliberately not secret.
const fixtures = JSON.parse(
  await readFile(new URL("../fixtures/cases.json", import.meta.url), "utf8"),
) as { schema: string; valid: boolean; value: unknown }[];
const detail = Buffer.from(
  JSON.stringify(
    fixtures.find((f) => f.schema === "InstallManifest" && f.valid)?.value,
  ),
);
const seed = Buffer.alloc(32, 7);
const key = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]),
  format: "der",
  type: "pkcs8",
});
const publicBytes = createPublicKey(key)
  .export({ format: "der", type: "spki" })
  .subarray(-32);
const payload = Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    channel: "stable",
    sequence: 2,
    issuedAt: "2026-10-04T12:00:00Z",
    expiresAt: "2026-10-11T12:00:00Z",
    details: [
      {
        appId: "test-fixture",
        version: "1.0.0",
        sha256: createHash("sha256").update(detail).digest("hex"),
      },
    ],
    holds: [],
  }),
);
const vector = {
  purpose: "PUBLIC TEST VECTOR ONLY — never a production trust root",
  publicKeyHex: publicBytes.toString("hex"),
  nowUnixSeconds: Date.parse("2026-10-05T12:00:00Z") / 1000,
  envelope: {
    schemaVersion: 1,
    keyId: "test-only",
    payload: payload.toString("base64"),
    signature: sign(
      null,
      Buffer.concat([Buffer.from("repoready.catalog.v1:"), payload]),
      key,
    ).toString("hex"),
  },
  detailBase64: detail.toString("base64"),
};
const vectorFile = new URL("../fixtures/catalog-vector.json", import.meta.url);
const vectorContent = JSON.stringify(vector, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if ((await readFile(vectorFile, "utf8")) !== vectorContent)
    throw new Error("Trust vector drift");
} else await writeFile(vectorFile, vectorContent);
