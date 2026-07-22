import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("renders approved catalog compatibility and safe source links", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toContainText("permission surface");
  await expect(page.getByText("1 template found")).toBeVisible();

  const card = page.getByRole("article", { name: "Ticket priority normalizer" });
  await expect(card).toContainText("ticket.created");
  await expect(card).toContainText("^0.0.0");
  await expect(card).toContainText("No outbound egress");
  await expect(card).toContainText("Reviewed: approved");

  const source = card.getByRole("link", { name: "View source for Ticket priority normalizer" });
  await expect(source).toHaveAttribute("href", /^https:\/\//u);
  await expect(source).toHaveAttribute("target", "_blank");
  await expect(source).toHaveAttribute("rel", "noopener noreferrer");
});

test("filters the static catalog and restores the empty state", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("searchbox", { name: "Search templates" }).fill("does-not-exist");
  await expect(page.getByText("No templates match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Reset and show all templates" }).click();
  await expect(page.getByRole("article", { name: "Ticket priority normalizer" })).toBeVisible();
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
  await expect(page.getByRole("article", { name: "Ticket priority normalizer" })).toBeVisible();
});
