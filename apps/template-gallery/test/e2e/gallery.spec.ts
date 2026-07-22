import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import catalog from "../../../../templates/catalog.json" with { type: "json" };
import { getReviewedRevisionUrl } from "../../src/catalog.js";

const firstTemplate = catalog.templates[0];

if (firstTemplate === undefined) {
  throw new Error("template gallery E2E requires at least one approved catalog item");
}

test("renders approved catalog compatibility and safe source links", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toContainText("permission surface");
  const countLabel = `${String(catalog.templates.length)} ${catalog.templates.length === 1 ? "template" : "templates"} found`;
  await expect(page.getByText(countLabel)).toBeVisible();

  const card = page.getByRole("article", { name: firstTemplate.displayName });
  await expect(card).toContainText(firstTemplate.hook.name);
  await expect(card).toContainText(firstTemplate.sdk.range);
  await expect(card).toContainText("No outbound egress");
  await expect(card).toContainText("Reviewed: approved");

  const reviewedRevisionUrl = getReviewedRevisionUrl(firstTemplate.source);
  expect(reviewedRevisionUrl).toBeDefined();
  const source = card.getByRole("link", {
    name: `View reviewed source for ${firstTemplate.displayName}`
  });
  await expect(source).toHaveAttribute("href", reviewedRevisionUrl ?? "");
  await expect(source).toHaveAttribute("target", "_blank");
  await expect(source).toHaveAttribute("rel", "noopener noreferrer");
  await expect(card.getByText(firstTemplate.source.revision.slice(0, 12))).toBeVisible();
});

test("filters the static catalog and restores the empty state", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("searchbox", { name: "Search templates" }).fill("does-not-exist");
  await expect(page.getByText("No templates match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Reset and show all templates" }).click();
  await expect(page.getByRole("article", { name: firstTemplate.displayName })).toBeVisible();
});

test("has no serious accessibility violations", async ({ page }) => {
  await page.goto("/");

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((violation) =>
      ["critical", "serious"].includes(violation.impact ?? "")
    )
  ).toEqual([]);
});

test("keeps the catalog within the mobile viewport", async ({ page }) => {
  test.skip(!test.info().project.name.startsWith("mobile"), "mobile-only overflow assertion");
  await page.goto("/");

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByRole("article", { name: firstTemplate.displayName })).toBeVisible();
});
