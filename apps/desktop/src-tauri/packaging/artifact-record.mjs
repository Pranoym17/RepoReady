// Read-only final-byte inventory. Run AFTER all Windows signing and updater signing.
// The output is descriptive and must still pass policy/artifact verification and human review.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function ownedFile(root, input) {
  const workspace = realpathSync(root);
  const path = resolve(workspace, input);
  const within = (value) => {
    const rel = relative(workspace, value);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  if (!within(path))
    throw new Error("Artifact input must stay inside the workspace");
  for (
    let ancestor = path;
    ancestor !== workspace;
    ancestor = dirname(ancestor)
  ) {
    if (!within(ancestor) || lstatSync(ancestor).isSymbolicLink())
      throw new Error("Artifact input must not traverse a link");
  }
  const actual = realpathSync(path);
  if (!within(actual) || !statSync(actual).isFile())
    throw new Error("Artifact input must be an owned file");
  return actual;
}

export function artifactRecord(
  root,
  artifactPath,
  signaturePath,
  version,
  url,
) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))
    throw new Error("A concrete release version is required");
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    !target.pathname
      .split("/")
      .some((part) => part === version || part === `v${version}`) ||
    /latest/i.test(target.pathname)
  )
    throw new Error("A version-specific HTTPS artifact URL is required");
  const artifact = ownedFile(root, artifactPath);
  const signature = ownedFile(root, signaturePath);
  const sizeBytes = statSync(artifact).size;
  if (
    sizeBytes < 2 ||
    sizeBytes > 2147483648 ||
    statSync(signature).size > 4096
  )
    throw new Error("Artifact/signature size is invalid");
  const bytes = readFileSync(artifact);
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a)
    throw new Error("Expected final Windows installer bytes");
  const signed = readFileSync(signature, "utf8").trim();
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signed) ||
    !Buffer.from(signed, "base64")
      .toString("utf8")
      .startsWith("untrusted comment: ")
  )
    throw new Error(
      "Expected a Tauri updater signature, never private key material",
    );
  return {
    version,
    target: "windows-x86_64",
    url: target.href,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes,
    signature: signed,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const [, , artifact, signature, version, url] = process.argv;
    if (!artifact || !signature || !version || !url)
      throw new Error(
        "Usage: artifact-record.mjs <workspace artifact> <workspace .sig> <version> <approved HTTPS URL>",
      );
    console.log(
      JSON.stringify(
        artifactRecord(root, artifact, signature, version, url),
        null,
        2,
      ),
    );
  } catch {
    console.error(
      "Final artifact inventory failed; check paths, final bytes, signature and versioned URL.",
    );
    process.exitCode = 1;
  }
}
