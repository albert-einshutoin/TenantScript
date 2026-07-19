import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(repoRoot, path), "utf8");

test("published threat model maps every trust boundary to permanent tests", () => {
  const threatModelPath = join(repoRoot, "docs", "security", "threat-model.md");
  assert.ok(existsSync(threatModelPath), "missing docs/security/threat-model.md");
  const threatModel = read("docs/security/threat-model.md");

  for (const boundary of [
    "Host application",
    "Plugin code",
    "Loader isolate",
    "Capability broker",
    "Secret store",
    "D1 / R2 / Durable Objects",
    "Admin UI",
    "External SaaS"
  ]) {
    assert.ok(threatModel.includes(boundary), `threat model must cover ${boundary}`);
  }

  for (const testPath of [
    "packages/loader/test/security-suite.test.ts",
    "packages/capabilities/test/security-suite.test.ts",
    "packages/control-plane/test/security-suite.test.ts",
    "packages/control-plane/test/security-suite.workers.test.ts",
    "packages/proxy/test/security-suite.test.ts",
    "apps/admin-ui/src/security-suite.test.tsx",
    "packages/manifest/test/fuzz.test.ts",
    "packages/host-sdk/test/fuzz.test.ts"
  ]) {
    assert.ok(threatModel.includes(testPath), `threat model must link ${testPath}`);
  }

  assert.match(threatModel, /unverified/i);
  assert.match(threatModel, /out of scope/i);
});

test("nightly fuzz workflow runs the canonical seeded parser fuzz gate", () => {
  const workflowPath = join(repoRoot, ".github", "workflows", "security-fuzz.yml");
  assert.ok(existsSync(workflowPath), "missing nightly security fuzz workflow");
  const workflow = read(".github/workflows/security-fuzz.yml");
  const packageJson = JSON.parse(read("package.json"));

  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /pnpm test:fuzz/);
  assert.match(workflow, /FUZZ_RUNS:/);
  assert.match(workflow, /FUZZ_SEED:/);
  assert.equal(typeof packageJson.scripts?.["test:fuzz"], "string");
});
