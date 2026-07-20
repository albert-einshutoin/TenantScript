import { expect, test } from "@playwright/test";

const EXECUTION_COUNT = 100_000;
const INITIAL_RENDER_BUDGET_MS = 1_000;
const MAX_DATA_ROWS_IN_DOM = 32;

test("keeps 100k executions within the browser render and DOM budgets", async ({ page }) => {
  await page.goto("/test/e2e/fixtures/executions-performance.html");
  await expect(page.locator("html")).toHaveAttribute("data-performance-ready", "true");

  const metrics = await page.evaluate(() => {
    const value = (
      globalThis as typeof globalThis & {
        __executionPerformance?: { executionCount: number; initialRenderMs: number };
      }
    ).__executionPerformance;
    if (value === undefined) throw new Error("execution performance metrics are missing");
    return value;
  });
  expect(metrics.executionCount).toBe(EXECUTION_COUNT);
  expect(metrics.initialRenderMs).toBeLessThanOrEqual(INITIAL_RENDER_BUDGET_MS);

  const table = page.getByRole("table");
  await expect(table).toHaveAttribute("aria-rowcount", String(EXECUTION_COUNT + 1));
  expect(await page.locator(".virtual-execution-row").count()).toBeLessThanOrEqual(
    MAX_DATA_ROWS_IN_DOM
  );
  await expect(page.getByRole("cell", { name: "exec_perf_000000", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "exec_perf_099999", exact: true })).toHaveCount(0);

  await page.getByLabel("Execution results").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });

  await expect(page.getByRole("cell", { name: "exec_perf_099999", exact: true })).toBeVisible();
  expect(await page.locator(".virtual-execution-row").count()).toBeLessThanOrEqual(
    MAX_DATA_ROWS_IN_DOM
  );
  await page.getByRole("button", { name: "View exec_perf_099999" }).click();
  await expect(page.getByRole("status")).toHaveText("Opened exec_perf_099999");
});
