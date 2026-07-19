import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliManifest = JSON.parse(
  readFileSync(join(repoRoot, "packages", "cli", "package.json"), "utf8")
);
const cliSource = readFileSync(join(repoRoot, "packages", "cli", "src", "index.ts"), "utf8");
const drillGuide = readFileSync(
  join(repoRoot, "docs", "benchmarks", "phase1-rollback-drill.md"),
  "utf8"
);
const benchmarkIndex = readFileSync(join(repoRoot, "docs", "benchmarks", "README.md"), "utf8");

test("rollback drill docs distinguish the public CLI from the repository wrapper", () => {
  assert.match(cliSource, /command === "rollback-drill"/);
  assert.equal(typeof cliManifest.scripts["rollback:drill"], "string");
  assert.match(drillGuide, /`ext rollback-drill`/);
  const repositoryCommand =
    "pnpm --filter @tenantscript/cli run rollback:drill -- \\";
  assert.ok(
    drillGuide.includes(repositoryCommand),
    "drill guide must document the repository wrapper"
  );
  assert.ok(
    benchmarkIndex.includes(repositoryCommand),
    "benchmark index must include the regeneration command"
  );
});
