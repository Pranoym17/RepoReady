import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const tools = {
  astro: "../node_modules/astro/bin/astro.mjs",
  wrangler: "../node_modules/wrangler/bin/wrangler.js",
};
const [tool, ...args] = process.argv.slice(2);
if (!Object.hasOwn(tools, tool)) throw new Error("Unknown local tool");
const env = {
  ...process.env,
  ASTRO_TELEMETRY_DISABLED: "1",
  WRANGLER_SEND_METRICS: "false",
  XDG_CONFIG_HOME: fileURLToPath(new URL("../.cache/config/", import.meta.url)),
};
const result = spawnSync(
  process.execPath,
  [fileURLToPath(new URL(tools[tool], import.meta.url)), ...args],
  { stdio: "inherit", env },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
