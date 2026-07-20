import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { evaluateAdminUiBundleBudget } from "./admin-ui-bundle-budget.mjs";

const tempDirectories = [];
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

after(async () => {
  await Promise.all(tempDirectories.map((directory) => rm(directory, { recursive: true })));
});

test("measures the initial graph and all JavaScript/CSS with deterministic gzip", async () => {
  const fixture = await createFixture({
    manifest: {
      "index.html": {
        file: "assets/index.js",
        isEntry: true,
        imports: ["_shared.js"],
        css: ["assets/index.css"],
        assets: ["assets/logo.svg"]
      },
      "_shared.js": { file: "assets/shared.js" },
      "src/lazy.tsx": { file: "assets/lazy.js", isDynamicEntry: true }
    },
    files: {
      "index.html": "<main>TenantScript</main>",
      "assets/index.js": "export const app = 'admin';",
      "assets/shared.js": "export const shared = true;",
      "assets/lazy.js": "export const lazy = true;",
      "assets/index.css": "body{color:#17202a}",
      "assets/logo.svg": "<svg></svg>"
    },
    budget: {
      version: 1,
      maxInitialPageGzipBytes: 10_000,
      maxTotalJavaScriptAndCssGzipBytes: 10_000
    }
  });

  const report = await evaluateAdminUiBundleBudget(fixture.dist, fixture.budgetPath);

  assert.deepEqual(report.initialAssets, [
    "assets/index.css",
    "assets/index.js",
    "assets/logo.svg",
    "assets/shared.js",
    "index.html"
  ]);
  assert.deepEqual(report.javaScriptAndCssAssets, [
    "assets/index.css",
    "assets/index.js",
    "assets/lazy.js",
    "assets/shared.js"
  ]);
  assert.equal(
    report.initialPageGzipBytes,
    gzipSize("<main>TenantScript</main>") +
      gzipSize("export const app = 'admin';") +
      gzipSize("export const shared = true;") +
      gzipSize("body{color:#17202a}") +
      gzipSize("<svg></svg>")
  );
  assert.equal(
    report.totalJavaScriptAndCssGzipBytes,
    gzipSize("export const app = 'admin';") +
      gzipSize("export const shared = true;") +
      gzipSize("export const lazy = true;") +
      gzipSize("body{color:#17202a}")
  );
});

test("rejects an initial page over its gzip budget", async () => {
  const fixture = await createFixture({
    manifest: { "index.html": { file: "assets/index.js", isEntry: true } },
    files: { "index.html": "<main></main>", "assets/index.js": "export default 1;" },
    budget: {
      version: 1,
      maxInitialPageGzipBytes: 1,
      maxTotalJavaScriptAndCssGzipBytes: 10_000
    }
  });

  await assert.rejects(
    evaluateAdminUiBundleBudget(fixture.dist, fixture.budgetPath),
    /Admin UI bundle budget exceeded: initial page gzip \d+ > 1 bytes/u
  );
});

test("rejects lazy chunk splitting that exceeds the total JavaScript/CSS budget", async () => {
  const fixture = await createFixture({
    manifest: {
      "index.html": { file: "assets/index.js", isEntry: true },
      "src/lazy.tsx": { file: "assets/lazy.js", isDynamicEntry: true }
    },
    files: {
      "index.html": "<main></main>",
      "assets/index.js": "export default 1;",
      "assets/lazy.js": "export default 'large lazy route';"
    },
    budget: {
      version: 1,
      maxInitialPageGzipBytes: 10_000,
      maxTotalJavaScriptAndCssGzipBytes: 1
    }
  });

  await assert.rejects(
    evaluateAdminUiBundleBudget(fixture.dist, fixture.budgetPath),
    /Admin UI bundle budget exceeded: total JavaScript\/CSS gzip \d+ > 1 bytes/u
  );
});

test("fails closed for missing entries, path escape, and symlinked assets", async () => {
  const missingEntry = await createFixture({
    manifest: { "src/lazy.tsx": { file: "assets/lazy.js", isDynamicEntry: true } },
    files: { "index.html": "<main></main>", "assets/lazy.js": "export default 1;" },
    budget: validBudget()
  });
  await assert.rejects(
    evaluateAdminUiBundleBudget(missingEntry.dist, missingEntry.budgetPath),
    /Admin UI bundle manifest is invalid: expected exactly one entry/u
  );

  const pathEscape = await createFixture({
    manifest: { "index.html": { file: "../outside.js", isEntry: true } },
    files: { "index.html": "<main></main>" },
    budget: validBudget()
  });
  await assert.rejects(
    evaluateAdminUiBundleBudget(pathEscape.dist, pathEscape.budgetPath),
    /Admin UI bundle manifest is invalid: unsafe asset path/u
  );

  const symlinked = await createFixture({
    manifest: { "index.html": { file: "assets/index.js", isEntry: true } },
    files: { "index.html": "<main></main>" },
    budget: validBudget()
  });
  await mkdir(join(symlinked.dist, "assets"), { recursive: true });
  await symlink(join(symlinked.root, "outside.js"), join(symlinked.dist, "assets/index.js"));
  await writeFile(join(symlinked.root, "outside.js"), "export default 1;");
  await assert.rejects(
    evaluateAdminUiBundleBudget(symlinked.dist, symlinked.budgetPath),
    /Admin UI bundle output is invalid: symbolic links are forbidden/u
  );
});

test("rejects manifest records that alias the same emitted JavaScript", async () => {
  const fixture = await createFixture({
    manifest: {
      "index.html": {
        file: "assets/index.js",
        isEntry: true,
        imports: ["_duplicate.js"]
      },
      "_duplicate.js": { file: "assets/index.js" }
    },
    files: { "index.html": "<main></main>", "assets/index.js": "export default 1;" },
    budget: validBudget()
  });

  await assert.rejects(
    evaluateAdminUiBundleBudget(fixture.dist, fixture.budgetPath),
    /Admin UI bundle manifest is invalid: duplicate emitted file/u
  );
});

test("accepts safe top-level CSS and static asset manifest records", async () => {
  const fixture = await createFixture({
    manifest: {
      "index.html": {
        file: "assets/index.js",
        isEntry: true,
        css: ["assets/index.css"],
        assets: ["assets/inter.woff2"]
      },
      "src/styles.css": {
        file: "assets/index.css",
        src: "src/styles.css",
        isEntry: true
      },
      "src/inter.woff2": {
        file: "assets/inter.woff2",
        src: "src/inter.woff2"
      }
    },
    files: {
      "index.html": "<main></main>",
      "assets/index.js": "export default 1;",
      "assets/index.css": "body{font-family:Inter}",
      "assets/inter.woff2": "fixture-font"
    },
    budget: validBudget()
  });

  const report = await evaluateAdminUiBundleBudget(fixture.dist, fixture.budgetPath);

  assert.deepEqual(report.initialAssets, [
    "assets/index.css",
    "assets/index.js",
    "assets/inter.woff2",
    "index.html"
  ]);
});

test("wires the production budget into the Admin UI, root gate, and Tier 1", async () => {
  const budget = JSON.parse(
    await readFile(join(repositoryRoot, "apps/admin-ui/bundle-budget.json"), "utf8")
  );
  assert.deepEqual(budget, validBudget());

  const adminPackage = JSON.parse(
    await readFile(join(repositoryRoot, "apps/admin-ui/package.json"), "utf8")
  );
  assert.equal(
    adminPackage.scripts["test:bundle-budget"],
    "node ../../scripts/admin-ui-bundle-budget.test.mjs && vite build && node ../../scripts/admin-ui-bundle-budget.mjs dist bundle-budget.json"
  );

  const rootPackage = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(
    rootPackage.scripts["test:admin-ui-bundle-budget"],
    "pnpm --filter @tenantscript/admin-ui test:bundle-budget"
  );
  assert.match(rootPackage.scripts.test, /pnpm test:admin-ui-bundle-budget/u);

  const viteConfig = await readFile(join(repositoryRoot, "apps/admin-ui/vite.config.ts"), "utf8");
  assert.match(viteConfig, /build:\s*\{\s*manifest:\s*true\s*\}/u);

  const tier1 = await readFile(join(repositoryRoot, ".github/workflows/tier1.yml"), "utf8");
  assert.match(tier1, /run: pnpm test:admin-ui-bundle-budget/u);
});

test("publishes the budget, update policy, and verification boundary", async () => {
  const guide = await readFile(
    join(repositoryRoot, "docs/reference/admin-ui-performance-budget.md"),
    "utf8"
  );
  for (const required of [
    "307,200 bytes",
    "460,800 bytes",
    "90,960 bytes",
    "pnpm test:admin-ui-bundle-budget",
    "synchronous imports",
    "dynamic chunks",
    "Repository verified",
    "not runtime performance evidence",
    "before/after"
  ]) {
    assert.ok(guide.includes(required), `performance budget guide must include ${required}`);
  }

  const docsIndex = await readFile(join(repositoryRoot, "docs/README.md"), "utf8");
  assert.match(docsIndex, /\(reference\/admin-ui-performance-budget\.md\)/u);
  const adminReadme = await readFile(join(repositoryRoot, "apps/admin-ui/README.md"), "utf8");
  assert.match(adminReadme, /admin-ui-performance-budget\.md/u);
});

async function createFixture({ manifest, files, budget }) {
  const root = await mkdtemp(join(tmpdir(), "tenantscript-admin-bundle-"));
  tempDirectories.push(root);
  const dist = join(root, "dist");
  const budgetPath = join(root, "budget.json");
  await mkdir(join(dist, ".vite"), { recursive: true });
  await writeFile(join(dist, ".vite/manifest.json"), JSON.stringify(manifest));
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(dist, path, ".."), { recursive: true });
    await writeFile(join(dist, path), contents);
  }
  await writeFile(budgetPath, JSON.stringify(budget));
  return { root, dist, budgetPath };
}

function validBudget() {
  return {
    version: 1,
    maxInitialPageGzipBytes: 307_200,
    maxTotalJavaScriptAndCssGzipBytes: 460_800
  };
}

function gzipSize(value) {
  return gzipSync(Buffer.from(value), { level: 9 }).byteLength;
}
