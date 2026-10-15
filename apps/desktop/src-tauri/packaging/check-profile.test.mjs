import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateProfile } from "./check-profile.mjs";

const config = (profile) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../tauri.bundle.${profile === "stable" ? "stable" : "dev"}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
const defaultAuthority = () =>
  JSON.parse(
    readFileSync(new URL("./update-authority.json", import.meta.url), "utf8"),
  );
// Synthetic public configuration exists only in these in-memory tests. No process is spawned,
// no signing tool/key file is generated, and no candidate installer is downloaded or executed.
function authority(channel = "development") {
  const publicKey = Buffer.concat([
    Buffer.from("Ed"),
    Buffer.alloc(8, 4),
    Buffer.alloc(32, 7),
  ]);
  return {
    schemaVersion: 1,
    enabled: true,
    channel,
    policyEndpoint: "https://updates.repoready.org/policy.json",
    policyKeys: { "policy-test-only": "08".repeat(32) },
    artifactOrigins: ["https://updates.repoready.org"],
    artifactPublicKey: Buffer.from(
      `untrusted comment: public TEST fixture\n${publicKey.toString("base64")}\n`,
    ).toString("base64"),
  };
}
const privateBuildEnvironment = {
  REPOREADY_ALLOW_PRIVATE_PACKAGING: "1",
  TAURI_SIGNING_PRIVATE_KEY: "TEST_ONLY_NOT_PRIVATE_MATERIAL",
};

test("checked-in profiles cannot package an unreviewed release", () => {
  assert.throws(
    () =>
      validateProfile("development", config("development"), defaultAuthority()),
    /explicit/,
  );
  assert.throws(
    () =>
      validateProfile(
        "development",
        config("development"),
        defaultAuthority(),
        privateBuildEnvironment,
      ),
    /not configured/,
  );
  assert.throws(
    () =>
      validateProfile(
        "stable",
        config("stable"),
        authority("stable"),
        privateBuildEnvironment,
      ),
    /disabled/,
  );
});

test("private packaging requires explicit opt-in and signing material", () => {
  assert.throws(
    () =>
      validateProfile("development", config("development"), authority(), {}),
    /explicit/,
  );
  assert.throws(
    () =>
      validateProfile("development", config("development"), authority(), {
        REPOREADY_ALLOW_PRIVATE_PACKAGING: "1",
      }),
    /signing material/,
  );
  assert.deepEqual(
    validateProfile(
      "development",
      config("development"),
      authority(),
      privateBuildEnvironment,
    ),
    {
      profile: "development",
      identifier: "org.repoready.development",
      version: "0.1.0-alpha.1",
      target: "windows-x86_64",
      signingRequired: true,
    },
  );
});

test("profile identities, per-user install guards and anti-downgrade configuration cannot drift", () => {
  for (const mutate of [
    (value) => {
      value.identifier = "io.github.pranoym17.repoready";
    },
    (value) => {
      value.productName = "RepoReady";
    },
    (value) => {
      value.bundle.windows.nsis.installMode = "perMachine";
    },
    (value) => {
      value.bundle.windows.allowDowngrades = true;
    },
    (value) => {
      value.bundle.windows.nsis.installerHooks = "other.nsh";
    },
    (value) => {
      value.plugins.updater.requireSignedVersion = false;
    },
    (value) => {
      value.plugins.updater.endpoints = ["https://arbitrary.org/manifest"];
    },
    (value) => {
      value.plugins.updater.dangerousInsecureTransportProtocol = true;
    },
  ]) {
    const changed = config("development");
    mutate(changed);
    assert.throws(() =>
      validateProfile(
        "development",
        changed,
        authority(),
        privateBuildEnvironment,
      ),
    );
  }
});

test("test/local origins, role reuse and placeholder key formats fail closed", () => {
  for (const origin of [
    "http://updates.repoready.org",
    "https://localhost",
    "https://127.0.0.1",
    "https://updates.test",
    "https://example.com",
    "https://updates.repoready.org/path",
    "https://user:secret@updates.repoready.org",
  ]) {
    const changed = authority();
    changed.artifactOrigins = [origin];
    assert.throws(() =>
      validateProfile(
        "development",
        config("development"),
        changed,
        privateBuildEnvironment,
      ),
    );
  }
  const reused = authority();
  reused.policyKeys["policy-test-only"] = "07".repeat(32);
  assert.throws(
    () =>
      validateProfile(
        "development",
        config("development"),
        reused,
        privateBuildEnvironment,
      ),
    /independent/,
  );
  const invalid = authority();
  invalid.artifactPublicKey = "placeholder";
  assert.throws(
    () =>
      validateProfile(
        "development",
        config("development"),
        invalid,
        privateBuildEnvironment,
      ),
    /public key/,
  );
});

test("stable cannot inherit test keys or bypass Windows signing and owner approval", () => {
  const stable = config("stable");
  stable.bundle.active = true;
  const source = authority("stable");
  assert.throws(
    () => validateProfile("stable", stable, source, privateBuildEnvironment),
    /approval/,
  );
  const approved = {
    ...privateBuildEnvironment,
    REPOREADY_STABLE_RELEASE_APPROVED: "1",
  };
  assert.throws(
    () => validateProfile("stable", stable, source, approved),
    /key pin/,
  );
  source.policyKeys = { "policy-approved": "08".repeat(32) };
  assert.throws(
    () => validateProfile("stable", stable, source, approved),
    /Windows publisher signing/,
  );
});

test("uninstall hook retains state and never adds recursive deletion or execution", () => {
  const hooks = readFileSync(new URL("./hooks.nsh", import.meta.url), "utf8");
  assert.match(hooks, /\$DeleteAppDataCheckboxState = 1/);
  assert.match(hooks, /Uncheck 'Delete app data'/);
  assert.match(hooks, /GetFileAttributesW/);
  assert.doesNotMatch(
    hooks,
    /^\s*(?:RMDir|Delete|Exec|ExecWait|DeleteRegKey)\b/im,
  );
});
