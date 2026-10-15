import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const root = json("package.json");
assert.equal(root.engines.node, "24.16.x");
assert.equal(root.packageManager, "npm@11.13.0");
assert.match(readFileSync(".npmrc", "utf8"), /^ignore-scripts=true$/m);
for (const workspace of [
  "apps/desktop",
  "apps/web",
  "services/requests",
  "packages/contracts",
  "packages/ui",
  "packages/catalog-tools",
]) {
  const pkg = json(workspace + "/package.json");
  assert.equal(pkg.private, true, workspace + " must not publish accidentally");
  for (const group of ["dependencies", "devDependencies", "peerDependencies"])
    for (const [name, version] of Object.entries(pkg[group] ?? {})) {
      if (!name.startsWith("@repoready/"))
        assert.match(
          version,
          /^\d+\.\d+\.\d+(?:[-.][\w.-]+)?$/,
          name + " must be exact-pinned",
        );
    }
}
const lock = json("package-lock.json");
assert.equal(lock.lockfileVersion, 3);
assert.ok(Object.keys(lock.packages).length > 50);
const config = json("apps/desktop/src-tauri/tauri.conf.json");
assert.equal(config.bundle.active, false);
assert.equal(
  config.app.windows[0].zoomHotkeysEnabled,
  true,
  "Windows WebView2 must allow the planned manual zoom accessibility pass",
);
assert.deepEqual(config.app.security.capabilities, ["main"]);
const capabilities = json("apps/desktop/src-tauri/capabilities/main.json");
assert.deepEqual(capabilities.windows, ["main"]);
assert.deepEqual(capabilities.permissions, [
  "allow-desktop-state",
  "allow-catalog-refresh",
  "allow-preferences-save",
  "allow-catalog-cache-clear",
  "allow-client-update-check",
  "allow-client-update-install",
  "allow-client-update-cancel",
  "allow-diagnostics-clear",
  "allow-open-project-page",
]);
assert.equal(capabilities.remote, undefined);
assert.deepEqual(config.plugins, {
  updater: {
    pubkey: "",
    endpoints: [],
    requireSignedVersion: true,
    windows: { installMode: "basicUi" },
  },
});
assert.equal(
  readdirSync("catalog/apps").filter((f) => f.endsWith(".json")).length,
  0,
  "M0 has no certified releases",
);
assert.deepEqual(json("catalog/trust-roots.json"), {
  schemaVersion: 1,
  keys: [],
});
for (const name of readdirSync(".github/workflows")) {
  const workflow = readFileSync(".github/workflows/" + name, "utf8");
  assert.doesNotMatch(
    workflow,
    /pull_request_target|secrets\.(?:AZURE|SIGN|TAURI|CLOUDFLARE)/,
  );
  for (const line of workflow.split("\n"))
    if (line.includes("uses:"))
      assert.match(
        line,
        /uses: [\w./-]+@[a-f0-9]{40}(?:\s|$)/,
        "Actions must be commit-pinned",
      );
}
console.log("Foundation policy checks passed");
