// A fail-closed packaging preflight, not signing enrollment or release approval.
// It reads public configuration only, prints no key/environment values and runs no tool.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const parse = (relative) =>
  JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
const fail = (message) => {
  throw new Error(message);
};
function https(value, originOnly = false) {
  if (typeof value !== "string") fail("Missing reviewed HTTPS metadata");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    fail("Invalid HTTPS release metadata");
  if (originOnly && value !== url.origin)
    fail("Artifact origins must be exact origins");
  if (
    !url.hostname.includes(".") ||
    /(?:^|\.)(?:localhost|invalid|test|example)$/.test(url.hostname) ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) ||
    /^example\.(?:com|org|net)$/.test(url.hostname)
  )
    fail("Test/local origins cannot be packaged");
  return url;
}

export function validateProfile(profile, config, authority, environment = {}) {
  if (!["development", "stable"].includes(profile))
    fail("Select development or stable explicitly");
  const expectedId =
    profile === "development"
      ? "org.repoready.development"
      : "io.github.pranoym17.repoready";
  const expectedName =
    profile === "development" ? "RepoReady Development" : "RepoReady";
  if (config.identifier !== expectedId || config.productName !== expectedName)
    fail("Release identity does not match its profile");
  if (profile === "stable" && config.bundle.active !== true)
    fail(
      "Stable bundling is disabled pending identity, signing and final-artifact approval",
    );
  if (
    profile === "development" &&
    environment.REPOREADY_ALLOW_PRIVATE_PACKAGING !== "1"
  )
    fail(
      "Private packaging needs an explicit REPOREADY_ALLOW_PRIVATE_PACKAGING=1 opt-in; no installer has been run",
    );
  if (
    profile === "stable" &&
    environment.REPOREADY_STABLE_RELEASE_APPROVED !== "1"
  )
    fail("Stable release approval has not been recorded");
  if (
    !/^\d+\.\d+\.\d+(?:-alpha\.\d+)?$/.test(config.version) ||
    (profile === "development") !== config.version.includes("-alpha.")
  )
    fail("Invalid profile version");
  if (
    config.bundle.targets?.length !== 1 ||
    config.bundle.targets[0] !== "nsis" ||
    config.bundle.createUpdaterArtifacts !== true
  )
    fail("Only signed NSIS updater artifacts are supported");
  const windows = config.bundle.windows;
  if (
    windows.allowDowngrades !== false ||
    windows.nsis?.installMode !== "currentUser" ||
    windows.nsis?.installerHooks !== "./packaging/hooks.nsh"
  )
    fail("Per-user installer and ownership guards are required");
  if (
    windows.webviewInstallMode?.type !== "downloadBootstrapper" ||
    windows.webviewInstallMode.silent !== false
  )
    fail("WebView2 download behavior must be disclosed and visible");
  const updater = config.plugins?.updater;
  if (
    !updater ||
    updater.requireSignedVersion !== true ||
    updater.endpoints?.length !== 0 ||
    updater.pubkey !== "" ||
    updater.windows?.installMode !== "basicUi" ||
    Object.keys(updater).some((key) => key.startsWith("dangerous"))
  )
    fail("Only the native policy-bound updater is allowed");
  if (
    authority.schemaVersion !== 1 ||
    authority.enabled !== true ||
    authority.channel !== profile ||
    !Object.keys(authority.policyKeys ?? {}).length ||
    !authority.artifactOrigins?.length
  )
    fail("Reviewed update authority is not configured");
  https(authority.policyEndpoint);
  authority.artifactOrigins.forEach((origin) => https(origin, true));
  const decoded = Buffer.from(
    authority.artifactPublicKey ?? "",
    "base64",
  ).toString("utf8");
  const rawArtifactKey = Buffer.from(decoded.split(/\r?\n/)[1] ?? "", "base64");
  if (
    !decoded.startsWith("untrusted comment: ") ||
    rawArtifactKey.length !== 42
  )
    fail("A real Tauri artifact public key is required");
  for (const [id, key] of Object.entries(authority.policyKeys)) {
    if (
      !/^[A-Za-z0-9_.-]{1,100}$/.test(id) ||
      !/^[a-f0-9]{64}$/.test(key) ||
      (profile === "stable" && /test|fixture|example/i.test(id))
    )
      fail("Invalid update policy key pin");
    if (rawArtifactKey.subarray(10).equals(Buffer.from(key, "hex")))
      fail("Policy and artifact key roles must remain independent");
  }
  if (!environment.TAURI_SIGNING_PRIVATE_KEY?.trim())
    fail(
      "Updater signing material must be supplied privately to the bundler; never commit it",
    );
  if (profile === "stable") {
    if (
      !/^[a-f0-9]{40}$/i.test(windows.certificateThumbprint ?? "") ||
      windows.tsp !== true
    )
      fail("Stable packaging requires reviewed Windows publisher signing");
    https(windows.timestampUrl);
  }
  return {
    profile,
    identifier: expectedId,
    version: config.version,
    target: "windows-x86_64",
    signingRequired: true,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const profile = process.argv[2];
    const config = parse(
      profile === "stable"
        ? "../tauri.bundle.stable.json"
        : "../tauri.bundle.dev.json",
    );
    const authority = parse("./update-authority.json");
    console.log(
      JSON.stringify(validateProfile(profile, config, authority, process.env)),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
