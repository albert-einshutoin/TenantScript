import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test("wires the axe and keyboard journey into the Admin UI, root gate, and Tier 1", async () => {
  const adminPackage = await readJson("apps/admin-ui/package.json");
  assert.equal(adminPackage.devDependencies["@axe-core/playwright"], "4.12.1");
  assert.equal(
    adminPackage.scripts["test:accessibility"],
    "playwright test test/e2e/accessibility.spec.ts"
  );

  const rootPackage = await readJson("package.json");
  assert.equal(
    rootPackage.scripts["test:admin-ui-accessibility"],
    "node --test scripts/admin-ui-accessibility-contract.test.mjs && pnpm --filter @tenantscript/admin-ui test:accessibility"
  );
  assert.match(rootPackage.scripts.test, /pnpm test:admin-ui-accessibility/u);

  const tier1 = await readText(".github/workflows/tier1.yml");
  assert.match(tier1, /run: pnpm test:admin-ui-accessibility/u);
});

test("keeps axe unfiltered and covers every primary route plus privileged keyboard flows", async () => {
  const spec = await readText("apps/admin-ui/test/e2e/accessibility.spec.ts");
  for (const required of [
    "Overview",
    "Installations",
    "Versions",
    "Approval queue",
    "Executions",
    "Connections",
    "Audit log",
    "new AxeBuilder",
    "Confirm plugin installation",
    "Confirm plugin rollback",
    "Confirm approval decision",
    'keyboard.press("Tab")'
  ]) {
    assert.ok(spec.includes(required), `accessibility E2E must include ${required}`);
  }
  assert.doesNotMatch(spec, /\.disableRules\s*\(/u);
  assert.doesNotMatch(spec, /\.exclude\s*\(/u);
  assert.match(await readText("apps/admin-ui/src/styles.css"), /\.table-wrap:focus-visible/u);
});

test("publishes the accessibility guarantee and local command", async () => {
  const guide = await readText("docs/reference/admin-ui-accessibility.md");
  for (const required of [
    "axe",
    "zero violations",
    "keyboard only",
    "focus",
    "pnpm test:admin-ui-accessibility",
    "disableRules"
  ]) {
    assert.ok(guide.includes(required), `accessibility guide must include ${required}`);
  }
  assert.match(await readText("docs/README.md"), /reference\/admin-ui-accessibility\.md/u);
  assert.match(await readText("apps/admin-ui/README.md"), /admin-ui-accessibility\.md/u);
});

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

async function readText(relativePath) {
  return await readFile(join(repositoryRoot, relativePath), "utf8");
}
