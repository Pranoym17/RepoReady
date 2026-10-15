import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { acceptanceReport } from "./acceptance.mjs";
const fixture = () => {
  const value = JSON.parse(
    readFileSync(new URL("./acceptance.json", import.meta.url), "utf8"),
  );
  for (const check of value.checks) {
    check.status = "pending";
    check.evidence = null;
  }
  return value;
};
test("missing, duplicated, failed and unsubstantiated checks cannot close M0-M2", () => {
  const value = fixture();
  assert.equal(acceptanceReport(value).readyToCloseM0M2, false);
  assert.throws(() =>
    acceptanceReport({ ...value, checks: value.checks.slice(1) }),
  );
  const duplicate = fixture();
  duplicate.checks[1] = duplicate.checks[0];
  assert.throws(() => acceptanceReport(duplicate));
  const passing = fixture();
  for (const check of passing.checks) {
    check.status = "passed";
    check.evidence = "Synthetic test evidence only";
  }
  assert.equal(acceptanceReport(passing).readyToCloseM0M2, true);
  passing.checks[0].evidence = null;
  assert.throws(() => acceptanceReport(passing));
  passing.checks[0].status = "failed";
  assert.equal(acceptanceReport(passing).readyToCloseM0M2, false);
});
