import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const authenticatedRoutes = [
  "Overview",
  "Installations",
  "Versions",
  "Approval queue",
  "Executions",
  "Connections",
  "Audit log"
] as const;

test("login and every primary Admin route have no axe violations", async ({ page }) => {
  await page.goto("/");
  await expectNoAxeViolations(page, "login");

  await page.getByLabel("Token").fill("manager-token");
  await page.getByRole("button", { name: "Sign in" }).click();

  for (const route of authenticatedRoutes) {
    await page.getByRole("button", { name: route }).click();
    await expect(page.getByRole("heading", { level: 1, name: route })).toBeVisible();
    await expectNoAxeViolations(page, route);
  }
});

test("manager completes install, rollback, and approval using only the keyboard", async ({
  page
}) => {
  await page.goto("/");
  const token = page.getByLabel("Token");
  await tabTo(page, token);
  await page.keyboard.type("manager-token");
  await activate(page, page.getByRole("button", { name: "Sign in" }));
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

  await activate(page, page.getByRole("button", { name: "Versions" }));
  await activate(page, page.getByRole("button", { name: "Install large-invoice-notify 1.2.2" }));
  const channel = page.getByLabel("notifyChannel (required)");
  await tabTo(page, channel);
  await page.keyboard.type("C123");
  await toggle(page, page.getByLabel("Confirm slack.send"));
  await toggle(page, page.getByLabel("Enable immediately"));
  await activate(page, page.getByRole("button", { name: "Review installation" }));

  const installDialog = page.getByRole("dialog", { name: "Confirm plugin installation" });
  const confirmInstall = installDialog.getByRole("button", { name: "Confirm installation" });
  await expect(confirmInstall).toBeFocused();
  await expectNoAxeViolations(page, "install confirmation dialog");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Install plugin")).toHaveCount(0);

  const rollback = page
    .getByRole("button", {
      name: "Rollback large-invoice-notify from 1.3.0 to 1.2.2"
    })
    .first();
  await activate(page, rollback);
  const rollbackDialog = page.getByRole("dialog", { name: "Confirm plugin rollback" });
  const confirmRollback = rollbackDialog.getByRole("button", { name: "Confirm rollback" });
  await expect(confirmRollback).toBeFocused();
  await expectNoAxeViolations(page, "rollback confirmation dialog");
  await page.keyboard.press("Shift+Tab");
  await expect(rollbackDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(rollback).toBeFocused();

  await activate(page, rollback);
  await expect(confirmRollback).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Rollback completed" })).toBeVisible();

  await activate(page, page.getByRole("button", { name: "Approval queue" }));
  await activate(page, page.getByRole("button", { name: "Approve" }));
  const approvalDialog = page.getByRole("dialog", { name: "Confirm approval decision" });
  const reason = approvalDialog.getByLabel("Decision reason");
  await expect(reason).toBeFocused();
  await expectNoAxeViolations(page, "approval confirmation dialog");
  await page.keyboard.type("keyboard reviewed");
  await activate(page, approvalDialog.getByRole("button", { name: "Confirm approval" }));
  await expect(page.getByRole("heading", { name: "Approval approved" })).toBeVisible();
});

async function expectNoAxeViolations(page: Page, state: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations, `${state}: ${formatViolations(results.violations)}`).toEqual([]);
}

function formatViolations(
  violations: readonly { id: string; nodes: readonly { target: unknown }[] }[]
): string {
  return violations
    .map(
      (violation) =>
        `${violation.id} (${violation.nodes.map((node) => JSON.stringify(node.target)).join(", ")})`
    )
    .join("; ");
}

async function tabTo(page: Page, target: ReturnType<Page["locator"]>): Promise<void> {
  for (let index = 0; index < 60; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Keyboard focus did not reach the expected control within 60 Tab presses");
}

async function activate(page: Page, target: ReturnType<Page["locator"]>): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press("Enter");
}

async function toggle(page: Page, target: ReturnType<Page["locator"]>): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press("Space");
}
