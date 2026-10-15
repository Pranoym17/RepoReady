// Never logs private keys/passphrases. Writes only the public signed envelope to stdout.
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { signClientPolicy } from "../src/client-policy.js";
try {
  const [policyPath, authorityPath, keyId] = process.argv.slice(2);
  const privatePath = process.env.REPOREADY_POLICY_PRIVATE_KEY_FILE;
  if (!policyPath || !authorityPath || !keyId || !privatePath)
    throw new Error("Missing input");
  const authority = JSON.parse(readFileSync(authorityPath, "utf8"));
  if (
    authority.enabled !== true ||
    (authority.channel === "stable" &&
      process.env.REPOREADY_STABLE_RELEASE_APPROVED !== "1")
  )
    throw new Error("Signing not approved");
  const privateKey = createPrivateKey({
    key: readFileSync(privatePath),
    format: "pem",
    passphrase: process.env.REPOREADY_POLICY_KEY_PASSPHRASE,
  });
  const envelope = signClientPolicy(
    JSON.parse(readFileSync(policyPath, "utf8")),
    privateKey,
    keyId,
    authority,
  );
  process.stdout.write(JSON.stringify(envelope) + "\n");
} catch {
  process.stderr.write(
    "Policy signing failed. Check the reviewed public inputs, protected signing key and release approval. No secret values were printed.\n",
  );
  process.exitCode = 1;
}
