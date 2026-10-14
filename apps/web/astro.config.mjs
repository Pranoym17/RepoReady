import { defineConfig } from "astro/config";
import {
  validateSiteOrigin,
  writeSitemap,
} from "../../scripts/web-metadata.mjs";
const site = validateSiteOrigin(process.env.PUBLIC_SITE_URL);
export default defineConfig({
  output: "static",
  site,
  integrations: [
    {
      name: "repoready-static-metadata",
      hooks: {
        "astro:build:done": ({ pages, dir }) => writeSitemap(site, pages, dir),
      },
    },
  ],
});
