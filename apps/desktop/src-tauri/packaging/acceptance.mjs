// Evidence checklist only. Never imported by the installer, updater or catalog authority.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const required = [
  "owner-decisions",
  "isolated-build-and-test-environment",
  "protected-signing-backup-and-restore",
  "supported-msvc-package-build",
  "clean-windows-install-restart-offline",
  "final-artifact-a-to-b-update",
  "update-rejection-cancel-and-recovery",
  "uninstall-retain-and-delete-client-state",
  "native-path-acl-and-reparse-review",
  "web-narrator-keyboard-and-400-percent-zoom",
  "native-narrator-keyboard-and-400-percent-zoom",
  "native-startup-and-memory-measurements",
  "production-signing-identity-pins-and-https",
  "final-commit-hosted-ci-and-repository-protection",
  "maintainer-m0-m2-sign-off",
];
export function acceptanceReport(value) {
  if (
    value?.schemaVersion !== 1 ||
    !Array.isArray(value.checks) ||
    value.checks.length !== required.length
  )
    throw new Error("Invalid acceptance checklist");
  const seen = new Set();
  const outstanding = [];
  for (const check of value.checks) {
    if (
      !required.includes(check.id) ||
      seen.has(check.id) ||
      !["pending", "passed", "failed"].includes(check.status) ||
      !["agent", "maintainer", "joint"].includes(check.owner)
    )
      throw new Error("Invalid acceptance check");
    seen.add(check.id);
    if (
      check.status === "passed" &&
      (typeof check.evidence !== "string" || check.evidence.trim().length < 10)
    )
      throw new Error("Passing acceptance needs a concrete evidence reference");
    if (check.status !== "passed")
      outstanding.push({
        id: check.id,
        owner: check.owner,
        status: check.status,
      });
  }
  return { readyToCloseM0M2: outstanding.length === 0, outstanding };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const report = acceptanceReport(
    JSON.parse(
      readFileSync(new URL("./acceptance.json", import.meta.url), "utf8"),
    ),
  );
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes("--check") && !report.readyToCloseM0M2)
    process.exitCode = 1;
}
