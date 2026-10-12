import { resolve } from "node:path";
import { lintCatalog } from "./publication.js";
try {
  const result = lintCatalog(resolve(process.argv[2] ?? process.cwd()));
  console.log(
    `Catalog valid: ${result.candidates.length} drafts, ${result.releases.length} certified available releases.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
