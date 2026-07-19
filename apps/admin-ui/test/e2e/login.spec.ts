import { expect, test } from "@playwright/test";

test("manager can sign in and reach the approval queue", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Admin Console" })).toBeVisible();
  await page.getByLabel("Token").fill("manager-token");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByLabel("signed in as manager")).toContainText("manager");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  await page.getByRole("button", { name: "Approval queue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Approval queue" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeEnabled();
});

test("manager confirms an installation change after reviewing it", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Token").fill("manager-token");
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.getByRole("button", { name: "Installations" }).click();
  await page.getByRole("button", { name: "Manage large-invoice-notify" }).click();
  await page.getByRole("button", { name: "Disable installation" }).click();
  await page.getByRole("button", { name: "Review change" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm installation change" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm change" }).click();

  await expect(page.getByRole("cell", { name: "disabled" })).toBeVisible();
});

test("manager reviews schema and capabilities before installing a plugin version", async ({
  page
}) => {
  await page.goto("/");
  await page.getByLabel("Token").fill("manager-token");
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.getByRole("button", { name: "Versions" }).click();
  await page.getByRole("button", { name: "Install large-invoice-notify 1.2.2" }).click();
  await page.getByLabel("notifyChannel (required)").fill("C123");
  await page.getByLabel("Confirm slack.send").check();
  await page.getByLabel("Enable immediately").check();
  await page.getByRole("button", { name: "Review installation" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm plugin installation" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm installation" }).click();

  await page.getByRole("button", { name: "Installations" }).click();
  await expect(page.getByRole("cell", { name: "1.2.2" })).toBeVisible();
});

test("invalid token stays on the login screen", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Token").fill("wrong-token");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText("Token rejected")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Admin Console" })).toBeVisible();
});
