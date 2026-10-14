import assert from "node:assert/strict";
import test from "node:test";
import { canonicalGithubRepository, searchCatalog } from "../src/search.js";

const candidates = [
  {
    name: "Zebra",
    slug: "zebra",
    category: "media",
    summary: "Video editor",
    description: "Offline editing",
    tags: ["film"],
    useCases: ["Trim footage"],
  },
  {
    name: "Álpha",
    slug: "alpha",
    category: "ai",
    summary: "Local assistant",
    description: "Model runner",
    tags: ["inference"],
    useCases: ["Write notes"],
  },
];

test("search matches normalized names, use cases, tags, and descriptions", () => {
  for (const query of ["ALPHA", " inference ", "write notes", "model runner"])
    assert.equal(searchCatalog(candidates, query)[0]?.slug, "alpha");
  assert.equal(searchCatalog(candidates, "trim film")[0]?.slug, "zebra");
  assert.equal(searchCatalog(candidates, "trim assistant").length, 0);
});

test("categories compose with queries and input is not mutated", () => {
  assert.equal(searchCatalog(candidates, "offline", "ai").length, 0);
  assert.equal(searchCatalog(candidates, "", "media")[0]?.slug, "zebra");
  assert.equal(searchCatalog(candidates, "", "unknown").length, 0);
  assert.deepEqual(
    searchCatalog(candidates).map((app) => app.slug),
    ["alpha", "zebra"],
  );
  assert.equal(candidates[0].slug, "zebra");
});

test("request validation accepts only a canonical HTTPS GitHub repository", () => {
  assert.equal(
    canonicalGithubRepository(" https://github.com/org/repo.git/ "),
    "https://github.com/org/repo",
  );
  for (const value of [
    "http://github.com/org/repo",
    "https://github.com.evil.test/org/repo",
    "https://user@github.com/org/repo",
    "https://github.com/org/repo/tree/main",
    "https://github.com/org/repo?token=x",
    "https://github.com/org/repo#x",
    "javascript:alert(1)",
    "https://github.com/org/.git",
    "not a URL",
  ])
    assert.equal(canonicalGithubRepository(value), null, value);
});
