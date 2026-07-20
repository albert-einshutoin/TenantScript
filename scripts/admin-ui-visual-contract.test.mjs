import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const viewports = [320, 768, 1024, 1440];
const surfaces = [
  "login",
  "overview",
  "installations",
  "versions",
  "approval-queue",
  "executions",
  "connections",
  "audit-log"
];
const states = ["empty", "loading", "error", "large-dataset", "confirmation-dialog"];

test("wires the deterministic visual suite into the Admin UI, root gate, and Tier 1", async () => {
  const adminPackage = await readJson("apps/admin-ui/package.json");
  assert.equal(adminPackage.devDependencies["@playwright/test"], "1.61.1");
  assert.match(adminPackage.scripts.test, /--grep-invert @visual/u);
  assert.equal(adminPackage.scripts["test:visual"], "playwright test test/e2e/visual.spec.ts");
  assert.equal(
    adminPackage.scripts["test:visual:update:linux"],
    "node ../../scripts/run-admin-ui-visual-linux.mjs --update"
  );
  assert.equal(
    adminPackage.scripts["test:visual:linux"],
    "node ../../scripts/run-admin-ui-visual-linux.mjs"
  );
  const updater = await readText("scripts/run-admin-ui-visual-linux.mjs");
  assert.match(updater, /mcr\.microsoft\.com\/playwright:v1\.61\.1-noble/u);
  assert.match(updater, /--update-snapshots/u);
  assert.match(updater, /excludedCredentialFiles/u);
  assert.doesNotMatch(updater, /process\.platform/u);

  const rootPackage = await readJson("package.json");
  assert.equal(
    rootPackage.scripts["test:admin-ui-visual"],
    "node --test scripts/admin-ui-visual-contract.test.mjs && pnpm --filter @tenantscript/admin-ui test:visual:linux"
  );
  assert.match(rootPackage.scripts.test, /pnpm test:admin-ui-visual/u);

  const tier1 = await readText(".github/workflows/tier1.yml");
  assert.match(tier1, /run: pnpm test:admin-ui-visual/u);
  assert.match(tier1, /if: failure\(\)/u);
  assert.match(tier1, /name: admin-ui-visual-failure-/u);
  assert.match(tier1, /apps\/admin-ui\/test-results/u);
  assert.match(tier1, /retention-days: 14/u);
});

test("fixes the viewport, route, state, and pixel comparison contracts", async () => {
  const spec = await readText("apps/admin-ui/test/e2e/visual.spec.ts");
  for (const required of [...viewports.map(String), ...surfaces, ...states]) {
    assert.ok(spec.includes(required), `visual E2E must include ${required}`);
  }
  assert.match(spec, /toHaveScreenshot/u);
  assert.match(spec, /tag: "@visual"/u);
  assert.match(spec, /scrollWidth/u);
  assert.match(spec, /clientWidth/u);
  assert.match(spec, /reducedMotion: "reduce"/u);
  assert.doesNotMatch(spec, /mask\s*:/u);

  const config = await readText("apps/admin-ui/playwright.config.ts");
  for (const required of [
    'locale: "en-US"',
    'timezoneId: "UTC"',
    'colorScheme: "light"',
    "deviceScaleFactor: 1",
    "maxDiffPixels: 0",
    "threshold: 0",
    'animations: "disabled"',
    'caret: "hide"'
  ]) {
    assert.ok(config.includes(required), `Playwright visual config must include ${required}`);
  }
  assert.match(config, /snapshotPathTemplate/u);
  assert.match(config, /trace: "retain-on-failure"/u);
});

test("commits one Linux baseline for every required visual", async () => {
  const baselineDirectory = join(repositoryRoot, "apps/admin-ui/test/e2e/visual.spec.ts-snapshots");
  const files = (await readdir(baselineDirectory, { recursive: true }))
    .filter((entry) => entry.endsWith(".png"))
    .map((entry) => entry.replaceAll("\\", "/"));

  const expected = [
    ...viewports.flatMap((width) => surfaces.map((surface) => `${surface}-${String(width)}.png`)),
    ...states.map((state) => `${state}-1024.png`)
  ];
  assert.deepEqual(files.toSorted(), expected.toSorted());
});

test("publishes the Linux baseline approval and evidence boundary", async () => {
  const guide = await readText("docs/reference/admin-ui-visual-regression.md");
  for (const required of [
    "pnpm test:admin-ui-visual",
    "pnpm --filter @tenantscript/admin-ui test:visual:update:linux",
    "mcr.microsoft.com/playwright:v1.61.1-noble",
    "expected",
    "actual",
    "diff",
    "synthetic",
    "secret",
    "baseline-only",
    "320",
    "1440"
  ]) {
    assert.ok(guide.includes(required), `visual guide must include ${required}`);
  }
  assert.match(await readText("docs/README.md"), /reference\/admin-ui-visual-regression\.md/u);
  assert.match(await readText("apps/admin-ui/README.md"), /admin-ui-visual-regression\.md/u);
  assert.match(await readText("tasks/Phase3.md"), /\[x\] \*\*P3-T03\*\*/u);
});

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

async function readText(relativePath) {
  return await readFile(join(repositoryRoot, relativePath), "utf8");
}
