import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const path = process.argv[2];
if (!path) throw new Error("Pass a cargo-audit JSON report path");
const report = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
assert.equal(
  report.vulnerabilities.found,
  false,
  "Dependency vulnerabilities block acceptance",
);
assert.equal(report.vulnerabilities.count, 0);
const reviewed = new Map([
  ["RUSTSEC-2024-0370", "proc-macro-error@1.0.4"],
  ["RUSTSEC-2024-0429", "glib@0.18.5"],
]);
for (const records of Object.values(report.warnings ?? {}))
  for (const item of records) {
    assert.equal(
      reviewed.get(item.advisory.id),
      item.package.name + "@" + item.package.version,
      "Unreviewed informational advisory: " + item.advisory.id,
    );
  }
console.log(
  "Rust audit policy passed; reviewed optional-platform informational findings remain visible",
);
