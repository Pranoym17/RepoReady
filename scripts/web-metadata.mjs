import { writeFile } from "node:fs/promises";

export function validateSiteOrigin(value) {
  if (!value) return undefined;
  const site = new URL(value);
  if (
    site.protocol !== "https:" ||
    site.username ||
    site.password ||
    site.port ||
    site.pathname !== "/" ||
    site.search ||
    site.hash
  )
    throw new Error(
      "PUBLIC_SITE_URL must be a public HTTPS origin, without path, credentials, query or fragment",
    );
  return site.origin;
}

export async function writeSitemap(site, pages, dir) {
  if (!site) return;
  const escapeXml = (value) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll('"', "&quot;");
  const locations = [...new Set(pages.map((page) => page.pathname))]
    .filter((path) => !/^\/?404(?:\.html|\/|$)/.test(path))
    .sort()
    .map(
      (path) =>
        `<url><loc>${escapeXml(new URL(path.startsWith("/") ? path : "/" + path, site).href)}</loc></url>`,
    );
  await writeFile(
    new URL("sitemap.xml", dir),
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locations.join("")}</urlset>`,
  );
  await writeFile(
    new URL("robots.txt", dir),
    `User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`,
  );
}
