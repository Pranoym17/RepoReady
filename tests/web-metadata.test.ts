import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateSiteOrigin, writeSitemap } from "../scripts/web-metadata.mjs";

test("canonical origin is optional and rejects credentials and non-origin values", () => {
  assert.equal(validateSiteOrigin(undefined), undefined);
  assert.equal(
    validateSiteOrigin("https://repoready.test/"),
    "https://repoready.test",
  ); // Test only; not configured in production.
  for (const origin of [
    "http://repoready.test",
    "https://user:password@repoready.test",
    "https://repoready.test/path",
    "https://repoready.test/?q=1",
    "https://repoready.test/#fragment",
  ])
    assert.throws(() => validateSiteOrigin(origin));
});

test("sitemap includes indexable paths exactly once and excludes the error page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repoready-metadata-"));
  try {
    const dir = pathToFileURL(directory + "/");
    await writeSitemap(
      "https://repoready.test",
      [
        { pathname: "/" },
        { pathname: "catalog/" },
        { pathname: "apps/tool/" },
        { pathname: "catalog/" },
        { pathname: "404.html" },
      ],
      dir,
    );
    const sitemap = await readFile(join(directory, "sitemap.xml"), "utf8");
    assert.match(sitemap, /https:\/\/repoready.test\/apps\/tool\//);
    assert.equal((sitemap.match(/<url>/g) ?? []).length, 3);
    assert.doesNotMatch(sitemap, /404/);
    assert.match(
      await readFile(join(directory, "robots.txt"), "utf8"),
      /Sitemap: https:\/\/repoready.test\/sitemap.xml/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
