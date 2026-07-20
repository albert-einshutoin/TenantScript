import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test("wires the 100k execution browser budget into the Admin UI, root gate, and Tier 1", async () => {
  const adminPackage = await readJson("apps/admin-ui/package.json");
  assert.equal(
    adminPackage.scripts["test:performance"],
    "playwright test test/e2e/execution-performance.spec.ts"
  );

  const rootPackage = await readJson("package.json");
  assert.equal(
    rootPackage.scripts["test:admin-ui-performance"],
    "node --test scripts/admin-ui-performance-contract.test.mjs && pnpm --filter @tenantscript/admin-ui test:performance"
  );
  assert.match(rootPackage.scripts.test, /pnpm test:admin-ui-performance/u);

  const tier1 = await readText(".github/workflows/tier1.yml");
  assert.match(
    tier1,
    /run: pnpm --filter @tenantscript\/admin-ui exec playwright install --with-deps chromium/u
  );
  assert.match(tier1, /run: pnpm test:admin-ui-performance/u);
});

test("publishes the fixed browser budgets and their evidence boundary", async () => {
  const guide = await readText("docs/reference/admin-ui-execution-performance.md");
  for (const required of [
    "100,000",
    "at most 32",
    "at most 1,000 ms",
    "aria-rowcount",
    "pnpm test:admin-ui-performance",
    "not part of the production bundle",
    "does **not** prove"
  ]) {
    assert.ok(guide.includes(required), `execution performance guide must include ${required}`);
  }

  const docsIndex = await readText("docs/README.md");
  assert.match(docsIndex, /reference\/admin-ui-execution-performance\.md/u);
  const adminReadme = await readText("apps/admin-ui/README.md");
  assert.match(adminReadme, /admin-ui-execution-performance\.md/u);
  const phasePlan = await readText("tasks/Phase3.md");
  assert.match(phasePlan, /\[x\] \*\*P3-T04\*\*/u);
});

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

async function readText(relativePath) {
  return await readFile(join(repositoryRoot, relativePath), "utf8");
}
