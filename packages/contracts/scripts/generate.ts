import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { schemas } from "../src/index.js";
const destination = new URL("../schemas/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  const content =
    JSON.stringify(z.toJSONSchema(schema, { target: "draft-7" }), null, 2) +
    "\n";
  const file = new URL(`${name}.json`, destination);
  if (process.argv.includes("--check")) {
    if ((await readFile(file, "utf8")) !== content)
      throw new Error(`Schema drift: ${name}`);
  } else {
    await writeFile(file, content);
  }
}
