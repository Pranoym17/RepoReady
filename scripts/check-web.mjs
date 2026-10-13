import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, join, extname, dirname } from "node:path";
import { load } from "cheerio";

const root = resolve("apps/web/dist");
const pages = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith(".html")) pages.push(path);
  }
}
await walk(root);
for (const route of [
  "",
  "catalog",
  "request",
  "trust-safety",
  "privacy",
  "licenses",
  "support",
  "release-notes",
])
  assert.ok(
    pages.includes(join(root, route, "index.html")),
    `Missing route: /${route}`,
  );
assert.ok(pages.includes(join(root, "404.html")));
assert.equal(
  pages.filter(
    (path) =>
      path.startsWith(join(root, "apps") + "/") ||
      path.startsWith(join(root, "apps") + "\\"),
  ).length,
  10,
);
const titles = new Set();
for (const file of pages) {
  const html = await readFile(file, "utf8");
  const $ = load(html);
  assert.equal($("html").attr("lang"), "en", file);
  assert.equal($("h1").length, 1, file + " needs one heading");
  const title = $("title").text();
  assert.ok(
    title.length > 8 && !titles.has(title),
    file + " needs unique title",
  );
  titles.add(title);
  assert.ok($("meta[name=description]").attr("content")?.length > 30, file);
  assert.equal($("main").length, 1, file);
  assert.ok($("main").text().length > 200, file + " needs static content");
  assert.equal(
    $("input[type=password], input[name*=api], script[src^='http']").length,
    0,
    file,
  );
  for (const element of $(
    "a[href], img[src], script[src], link[href]",
  ).toArray()) {
    const reference = $(element).attr("href") ?? $(element).attr("src");
    assert.ok(reference && reference !== "#", file + " empty link");
    assert.ok(!/^(javascript|data):/i.test(reference), file + " unsafe URL");
    if (/^https?:/.test(reference)) {
      assert.ok(
        !/example\.(org|com|net)|placeholder|\/releases\/latest\/download/i.test(
          reference,
        ),
        file + " fake/mutable URL",
      );
      continue;
    }
    if (/^(mailto:|tel:)/.test(reference)) continue;
    const parsed = new URL(
      reference,
      "https://local.invalid/" +
        file.slice(root.length + 1).replaceAll("\\", "/"),
    );
    const pathname = decodeURIComponent(parsed.pathname);
    let target = reference.startsWith("#")
      ? file
      : resolve(root, "." + pathname);
    if (!extname(target)) target = join(target, "index.html");
    else if (pathname.endsWith("/")) target = join(target, "index.html");
    assert.ok((await stat(target)).isFile(), `${file}: missing ${reference}`);
    if (parsed.hash && target.endsWith(".html")) {
      const targetDocument = load(await readFile(target, "utf8"));
      const id = decodeURIComponent(parsed.hash.slice(1));
      assert.ok(
        targetDocument("[id]")
          .toArray()
          .some((node) => targetDocument(node).attr("id") === id),
        `${file}: missing anchor ${reference}`,
      );
    }
  }
  if (dirname(dirname(file)).endsWith("apps")) {
    assert.match($("main").text(), /draft/i, file);
    assert.match($("main").text(), /not tested|not certified/i, file);
    assert.equal(
      $("a[href]")
        .toArray()
        .filter((node) => /\.(exe|msi|zip)(?:\?|$)/i.test($(node).attr("href")))
        .length,
      0,
      file,
    );
  }
}
console.log(
  `Static website evaluation passed: ${pages.length} HTML pages, 10 drafts, local links/assets/anchors, metadata and no fabricated downloads.`,
);
