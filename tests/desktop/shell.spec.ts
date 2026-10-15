import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Test-only IPC data: never bundled into the desktop application or catalog.
const snapshot = {
  version: "0.1.0-alpha.1",
  mode: "development",
  catalog: {
    status: "not-configured",
    issuedAt: null,
    expiresAt: null,
    lastVerifiedAt: null,
    sequence: null,
    items: [],
  },
  library: [],
  preferences: { cacheLimitMb: 64, logRetentionDays: 7 },
  recoveryRequired: false,
  update: {
    status: "not-configured",
    version: null,
    messageCode: "NOT_CONFIGURED",
  },
  diagnostics: { logBytes: 0 },
  capabilities: { manageApps: false, requests: false },
  lastError: null,
};
async function mockNative(page: Page, value: unknown = snapshot) {
  await page.addInitScript((initial: unknown) => {
    let state = initial;
    const calls: string[] = [];
    const consents: unknown[] = [];
    Object.defineProperty(window, "isTauri", { value: true });
    Object.defineProperty(window, "__desktopTestCalls", { value: calls });
    Object.defineProperty(window, "__desktopTestConsents", { value: consents });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        invoke: async (
          command: string,
          args?: { preferences?: unknown; consent?: boolean },
        ) => {
          calls.push(command);
          if (command === "client_update_install") consents.push(args?.consent);
          if (
            command === "preferences_save" &&
            args &&
            typeof state === "object" &&
            state
          )
            state = { ...state, preferences: args.preferences };
          return state;
        },
      },
    });
  }, value);
}

test("all five screens expose truthful drafts and unavailable actions", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText(/Browser preview —/)).toBeVisible();
  await expect(page.locator("[data-catalog-item]")).toHaveCount(10);
  await page.getByRole("button", { name: "AppFlowy", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "AppFlowy", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/This is research content, not a certified/),
  ).toBeVisible();
  for (const heading of [
    "Author, source, and license",
    "Compatibility and requirements",
    "Setup and lifecycle",
    "Research and media",
  ])
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your library is empty" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Request a project", exact: true })
    .click();
  await expect(
    page.getByText(/Nothing entered here is sent, saved, or queued/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByText("Updates are not configured", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await expect(
    page.getByRole("button", {
      name: /^Install |^Launch |^Uninstall |^Repair /,
    }),
  ).toHaveCount(0);
});

test("keyboard search and categories retain usable focus", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  const query = page.getByRole("searchbox");
  await query.fill("no-matches-anywhere");
  await expect(
    page.getByRole("heading", { name: "No matches", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByLabel("Category", { exact: true }).selectOption("ai");
  await expect(page.locator("[data-catalog-item]")).toHaveCount(3);
  await query.fill("ollama");
  await expect(page.locator("[data-catalog-item]")).toHaveCount(1);
  await expect(query).toBeFocused();
});

test("native mock saves preferences through IPC and exposes offline state", async ({
  page,
}) => {
  await mockNative(page, {
    ...snapshot,
    catalog: { ...snapshot.catalog, status: "offline" },
  });
  await page.goto("/");
  await expect(page.getByText(/You are offline/)).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByLabel("Catalog cache limit (MB)", { exact: true })
    .fill("128");
  await page
    .getByLabel("Diagnostic log retention (days)", { exact: true })
    .fill("10");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(
    page.getByText("Preferences saved.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByLabel("Catalog cache limit (MB)", { exact: true }),
  ).toHaveValue("128");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __desktopTestCalls: string[] })
          .__desktopTestCalls,
    ),
  ).toContain("preferences_save");
});

test("malformed native responses fail safely without rendering sensitive error detail", async ({
  page,
}) => {
  await mockNative(page, {
    error: "C:\\private\\credential-secret",
    catalog: { items: [] },
  });
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText(
    "could not safely read its local state",
  );
  await expect(page.locator("body")).not.toContainText("credential-secret");
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save preferences" }),
  ).toHaveCount(0);
});

test("client update requires explicit confirmation before IPC", async ({
  page,
}) => {
  await mockNative(page, {
    ...snapshot,
    update: {
      status: "available",
      version: "0.1.0-alpha.2",
      messageCode: "UPDATE_AVAILABLE",
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Review client update" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __desktopTestCalls: string[] })
          .__desktopTestCalls,
    ),
  ).not.toContain("client_update_install");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Review client update" }).click();
  await page.getByRole("button", { name: "Confirm client update" }).click();
  await expect
    .poll(async () =>
      page.evaluate(() =>
        (
          window as unknown as { __desktopTestCalls: string[] }
        ).__desktopTestCalls.includes("client_update_install"),
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __desktopTestConsents: unknown[] })
          .__desktopTestConsents,
    ),
  ).toEqual([true]);
});

test("screens reflow and pass automated accessibility checks", async ({
  page,
}) => {
  await page.goto("/");
  for (const width of [320, 650, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const screen of [
      "Discover",
      "Library",
      "Request a project",
      "Settings",
    ]) {
      await page.getByRole("button", { name: screen, exact: true }).click();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width + 1);
    }
  }
  await page.setViewportSize({ width: 1024, height: 900 });
  for (const screen of [
    "Discover",
    "Library",
    "Request a project",
    "Settings",
  ]) {
    await page.getByRole("button", { name: screen, exact: true }).click();
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(result.violations, screen).toEqual([]);
  }
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  await page.getByRole("button", { name: "AppFlowy", exact: true }).click();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});

test("pending update can request cancellation and failure releases the interface", async ({
  page,
}) => {
  await page.addInitScript(
    (initial) => {
      let rejectUpdate: ((reason: Error) => void) | null = null;
      const calls: string[] = [];
      Object.defineProperty(window, "isTauri", { value: true });
      Object.defineProperty(window, "__desktopTestCalls", { value: calls });
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        value: {
          invoke: async (command: string) => {
            calls.push(command);
            if (command === "client_update_install")
              return new Promise((_resolve, reject) => {
                rejectUpdate = reject;
              });
            if (command === "client_update_cancel") {
              rejectUpdate?.(new Error("private-native-cancel-detail"));
              return;
            }
            return initial;
          },
        },
      });
    },
    {
      ...snapshot,
      update: {
        status: "available",
        version: "0.1.0-alpha.2",
        messageCode: "UPDATE_AVAILABLE",
      },
    },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Review client update" }).click();
  await page.getByRole("button", { name: "Confirm client update" }).click();
  await expect(
    page.getByRole("button", { name: "Save preferences" }),
  ).toBeDisabled();
  await expect(
    page.getByText(/cannot undo an installation that has already started/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel download", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save preferences" }),
  ).toBeEnabled();
  await expect(page.getByRole("status")).toContainText(
    "The client update did not complete.",
  );
  await expect(
    page.getByRole("region", { name: "Client update in progress" }),
  ).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(
    "private-native-cancel-detail",
  );
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __desktopTestCalls: string[] })
          .__desktopTestCalls,
    ),
  ).toContain("client_update_cancel");
});

test("held native descriptions disclose missing release data without installer authority", async ({
  page,
}) => {
  const app = {
    id: "held-test",
    slug: "held-test",
    name: "Held test application",
    summary: "Test-only descriptive fixture.",
    description:
      "A held release must remain descriptive and cannot offer application actions.",
    category: "utilities",
    tags: ["test"],
    sourceUrl: "https://github.com/test/held",
    upstreamAuthor: "Test fixture",
    licenseSpdx: "MIT",
    status: "paused",
    screenshots: ["https://example.org/screenshot.png"],
    requirements: {
      minWindowsBuild: 22000,
      minRamMb: 1024,
      diskMb: 100,
      gpuNotes: "No GPU required.",
      internetRequired: false,
      externalApiProviders: [],
      apiChargesDisclosed: true,
      extraDownloadBytes: 0,
    },
    verifiedAt: "2026-10-14T12:00:00Z",
    supportUrl: "https://github.com/test/held/issues",
  };
  await mockNative(page, {
    ...snapshot,
    catalog: {
      ...snapshot.catalog,
      status: "stale",
      lastVerifiedAt: "2026-10-14T12:00:00Z",
      items: [app],
    },
  });
  await page.goto("/");
  await expect(page.getByText(/Cached catalog has expired/)).toBeVisible();
  await page.getByRole("button", { name: app.name, exact: true }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/does not include release-specific standalone/),
  ).toBeVisible();
  await expect(page.getByText(/lists 1 screenshot references/)).toBeVisible();
  await expect(page.locator("img")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: /^Install |^Launch |^Uninstall |^Repair /,
    }),
  ).toHaveCount(0);
});
