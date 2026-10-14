import { resolve } from "node:path";
import { lintCatalog } from "./publication.js";
try {
  const result = lintCatalog(resolve(process.argv[2] ?? process.cwd()));
  console.log(
    `Catalog valid: ${result.candidates.length} drafts, ${result.releases.filter((release) => !release.held).length} certified active releases, ${result.releases.filter((release) => release.held).length} held releases.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
