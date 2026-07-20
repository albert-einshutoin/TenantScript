import { expect, test, type Locator, type Page } from "@playwright/test";

const viewports = [
  { width: 320, height: 900 },
  { width: 768, height: 900 },
  { width: 1024, height: 900 },
  { width: 1440, height: 900 }
] as const;

const surfaces = [
  { name: "overview", route: "Overview" },
  { name: "installations", route: "Installations" },
  { name: "versions", route: "Versions" },
  { name: "approval-queue", route: "Approval queue" },
  { name: "executions", route: "Executions" },
  { name: "connections", route: "Connections" },
  { name: "audit-log", route: "Audit log" }
] as const;

test.describe("visual regression", { tag: "@visual" }, () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  });

  for (const viewport of viewports) {
    test(`matches every primary surface at ${String(viewport.width)}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await prepareForScreenshot(page);
      await expect(page).toHaveScreenshot(`login-${String(viewport.width)}.png`, {
        fullPage: true
      });

      await signIn(page);
      for (const surface of surfaces) {
        await page.getByRole("button", { name: surface.route }).click();
        await expect(page.getByRole("heading", { level: 1, name: surface.route })).toBeVisible();
        await expectRouteLoaded(page, surface.route);
        if (viewport.width === 320) await expectMobileOverflowContained(page);
        await prepareForScreenshot(page);
        await expect(page).toHaveScreenshot(`${surface.name}-${String(viewport.width)}.png`, {
          fullPage: true
        });
      }
    });
  }

  test.describe("major visual states", () => {
    test.use({ viewport: { width: 1024, height: 900 } });

    test("matches the empty state", async ({ page }) => {
      await openVisualScenario(page, "empty");
      await page.getByRole("button", { name: "Connections" }).click();
      await expect(page.getByText("No provider connections yet")).toBeVisible();
      await prepareForScreenshot(page);
      await expect(page).toHaveScreenshot("empty-1024.png", { fullPage: true });
    });

    test("matches the loading state", async ({ page }) => {
      await openVisualScenario(page, "loading");
      await expect(page.getByText("Loading", { exact: true })).toBeVisible();
      await prepareForScreenshot(page);
      await expect(page).toHaveScreenshot("loading-1024.png", { fullPage: true });
    });

    test("matches the error state", async ({ page }) => {
      await openVisualScenario(page, "error");
      await expect(page.getByText("Dashboard unavailable")).toBeVisible();
      await prepareForScreenshot(page);
      await expect(page).toHaveScreenshot("error-1024.png", { fullPage: true });
    });

    test("matches a large dataset without page overflow", async ({ page }) => {
      await openVisualScenario(page, "large-dataset");
      await page.getByRole("button", { name: "Installations" }).click();
      await expect(page.getByText("visual-plugin-35-with-bounded-synthetic-name")).toBeVisible();
      await prepareForScreenshot(page);
      await expect(page).toHaveScreenshot("large-dataset-1024.png", { fullPage: true });
    });

    test("matches a privileged confirmation dialog", async ({ page }) => {
      await openVisualScenario(page, "default");
      await page.getByRole("button", { name: "Versions" }).click();
      await page
        .getByRole("button", { name: "Rollback large-invoice-notify from 1.3.0 to 1.2.2" })
        .first()
        .click();
      await expect(page.getByRole("dialog", { name: "Confirm plugin rollback" })).toBeVisible();
      await prepareForScreenshot(page);
      await expect(page).toHaveScreenshot("confirmation-dialog-1024.png", { fullPage: true });
    });
  });
});

async function openVisualScenario(page: Page, scenario: string): Promise<void> {
  await page.goto(`/test/e2e/fixtures/visual.html?scenario=${scenario}`);
  await signIn(page);
}

async function signIn(page: Page): Promise<void> {
  await page.getByLabel("Token").fill("manager-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
}

async function expectRouteLoaded(
  page: Page,
  route: (typeof surfaces)[number]["route"]
): Promise<void> {
  const routeContent: Record<(typeof surfaces)[number]["route"], () => Locator> = {
    Overview: () => page.getByRole("region", { name: "Operations summary" }),
    Installations: () => page.getByRole("region", { name: "Installation table" }),
    Versions: () => page.getByRole("region", { name: "Plugin version table" }),
    "Approval queue": () => page.getByRole("button", { name: "Approve" }).first(),
    Executions: () => page.getByRole("button", { name: "Search executions" }),
    Connections: () => page.getByRole("region", { name: "Provider connections" }),
    "Audit log": () => page.getByRole("region", { name: "Tenant audit log" })
  };
  await expect(routeContent[route]()).toBeVisible();
}

async function expectMobileOverflowContained(page: Page): Promise<void> {
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    tableRegions: Array.from(document.querySelectorAll<HTMLElement>(".table-wrap")).map(
      (element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        right: element.getBoundingClientRect().right
      })
    )
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  for (const region of layout.tableRegions) {
    expect(region.right).toBeLessThanOrEqual(layout.clientWidth);
    expect(region.scrollWidth).toBeGreaterThanOrEqual(region.clientWidth);
  }
}

async function prepareForScreenshot(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
  });
}
