import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readdirSync } from "node:fs";

const appRoutes = readdirSync("catalog/candidates")
  .filter((name) => name.endsWith(".json"))
  .map((name) => `/apps/${name.slice(0, -5)}/`);
const routes = [
  "/",
  "/catalog/",
  "/request/",
  "/trust-safety/",
  "/privacy/",
  "/licenses/",
  "/support/",
  "/release-notes/",
  ...appRoutes,
];

test("all route templates and draft pages pass WCAG automated evaluation", async ({
  page,
}) => {
  for (const route of routes) {
    await page.goto(route);
    await expect(page.locator("h1")).toHaveCount(1);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      results.violations,
      `${route}: ${JSON.stringify(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })))}`,
    ).toEqual([]);
  }
});

test("search, categories, empty state and browser history work", async ({
  page,
}) => {
  await page.goto("/catalog/");
  const search = page.locator("input[type=search]");
  const category = page.locator("select[name=category]");
  const items = page.locator("[data-catalog-item]:visible");
  await expect(items).toHaveCount(10);
  await search.fill("unlikely-zero-result-phrase");
  await expect(items).toHaveCount(0);
  await expect(page.locator("[role=status]")).toContainText(/0|no/i);
  await expect(page).toHaveURL(/q=unlikely-zero-result-phrase/);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(items).toHaveCount(10);
  await category.selectOption("ai");
  await expect(items).toHaveCount(3);
  await expect(page).toHaveURL(/category=ai/);
  await category.selectOption("media");
  await expect(items).toHaveCount(2);
  await page.goBack();
  await expect(category).toHaveValue("ai");
  await expect(items).toHaveCount(3);
  await page.reload();
  await expect(category).toHaveValue("ai");
  await expect(items).toHaveCount(3);
});

test("discovery and disclosures remain available without JavaScript", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4322/catalog/");
  await expect(page.locator("[data-catalog-item]")).toHaveCount(10);
  for (const route of appRoutes) {
    await page.goto("http://127.0.0.1:4322" + route);
    await expect(page.locator("main")).toContainText(/draft/i);
    await expect(page.locator("main")).toContainText(/license/i);
    await expect(page.locator("main")).toContainText(/privacy/i);
    await expect(page.locator("main")).toContainText(
      /not tested|not certified/i,
    );
    await expect(page.locator('a[href$=".exe"],a[href$=".msi"]')).toHaveCount(
      0,
    );
  }
  await context.close();
});

test("keyboard navigation exposes focus and supports discovery", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveText(/skip/i);
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  await page.goto("/catalog/");
  await page.locator("input[type=search]").focus();
  await page.keyboard.type("zz-nothing");
  await expect(page.locator("[data-catalog-item]:visible")).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(page.locator("select[name=category]")).toBeFocused();
  const outline = await page
    .locator(":focus")
    .evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).not.toBe("none");
});

test("all pages reflow across mobile, tablet, desktop and enlarged text", async ({
  page,
}) => {
  for (const width of [320, 375, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of routes) {
      await page.goto(route);
      const dimensions = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }));
      expect(
        dimensions.scroll,
        `${route} at ${width}px overflows`,
      ).toBeLessThanOrEqual(dimensions.viewport + 1);
    }
  }
  await page.setViewportSize({ width: 640, height: 900 });
  for (const route of ["/catalog/", appRoutes[0], "/request/"]) {
    await page.goto(route);
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(641);
    await expect(page.locator("h1")).toBeVisible();
  }
});

test("current availability is honest and request intake never pretends to submit", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("main")).toContainText(
    /not available|not yet available|in development/i,
  );
  await expect(
    page.locator('a[href$=".exe"],a[href$=".msi"],a[download]'),
  ).toHaveCount(0);
  await page.goto("/request/");
  const submissions: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") submissions.push(request.url());
  });
  await page.locator("#repository-url").fill("https://example.com/org/repo");
  await page.getByRole("button", { name: "Check link only" }).click();
  await expect(page.locator("#repository-url")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await page
    .locator("#repository-url")
    .fill("https://github.com/owner/project");
  await page.getByRole("button", { name: "Check link only" }).click();
  await expect(page.locator("#repository-url")).toHaveAttribute(
    "aria-invalid",
    "false",
  );
  await expect(page.locator("#repository-result")).toContainText(
    "Nothing was submitted or saved",
  );
  expect(submissions).toEqual([]);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await expect(page.locator("main")).toContainText(
    /not.*(?:open|available|active)|not accepting|not yet|inactive|coming later/i,
  );
  await expect(
    page.locator('input[type="password"],input[name*="key"]'),
  ).toHaveCount(0);
  await page.goto("/does-not-exist/");
  await expect(page.locator("h1")).toContainText(/not found|404/i);
});
