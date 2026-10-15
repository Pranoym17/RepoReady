import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".cache/playwright");
export default defineConfig({
  testDir: "./tests/desktop",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.platform === "win32" ? 1 : 3,
  timeout: 60_000,
  outputDir: ".cache/desktop-test-results",
  reporter: [
    ["list"],
    ["json", { outputFile: ".cache/desktop-evaluation.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:4323",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: {
    command:
      "npm run preview -w @repoready/desktop -- --host 127.0.0.1 --port 4323 --strictPort",
    url: "http://127.0.0.1:4323",
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
