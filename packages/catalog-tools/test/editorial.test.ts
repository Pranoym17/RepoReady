import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { CandidateSchema, validateCandidates } from "../src/editorial.js";
const directory = new URL("../../../catalog/candidates/", import.meta.url);
const records = readdirSync(directory).map(
  (file) =>
    JSON.parse(readFileSync(new URL(file, directory), "utf8")) as unknown,
);
test("ten researched drafts have four balanced categories and no install authority", () => {
  const candidates = validateCandidates(records);
  assert.equal(candidates.length, 10);
  assert.deepEqual(
    Object.fromEntries(
      ["ai", "productivity", "media", "utilities"].map((category) => [
        category,
        candidates.filter((entry) => entry.category === category).length,
      ]),
    ),
    { ai: 3, productivity: 3, media: 2, utilities: 2 },
  );
  for (const candidate of candidates) {
    assert.equal(candidate.distribution.capability, "unknown");
    assert.equal(candidate.proposedPackageType, null);
    assert.equal(candidate.screenshots.length, 0);
    assert.match(candidate.review.notes, /Not installed/);
  }
});
test("draft parsing rejects every missing disclosure, extra authority, unsafe links and markup", () => {
  const candidate = CandidateSchema.parse(records[0]);
  for (const field of Object.keys(candidate)) {
    const incomplete = { ...candidate } as Record<string, unknown>;
    delete incomplete[field];
    assert.throws(() => validateCandidates([incomplete]), new RegExp(field));
  }
  assert.throws(
    () => validateCandidates([candidate, { ...candidate, id: "another" }]),
    /duplicate/,
  );
  assert.throws(
    () =>
      validateCandidates([
        {
          ...candidate,
          artifact: { downloadUrl: "https://bad.invalid/a.exe" },
        },
      ]),
    /artifact/,
  );
  assert.throws(
    () =>
      validateCandidates([
        { ...candidate, summary: "<script>alert(1)</script>" },
      ]),
    /summary/,
  );
  for (const evidenceUrl of [
    "javascript:alert(1)",
    "https://user:pass@github.com/a",
    "https://localhost/a",
    "https://127.0.0.1/a",
    "https://github.com/a#b",
  ]) {
    assert.throws(
      () =>
        validateCandidates([
          { ...candidate, license: { ...candidate.license, evidenceUrl } },
        ]),
      /license.evidenceUrl/,
    );
  }
});
