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

test("invalid token stays on the login screen", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Token").fill("wrong-token");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText("Token rejected")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Admin Console" })).toBeVisible();
});
