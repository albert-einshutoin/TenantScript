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

test("advisory response runbook and a machine-checked drill are published", () => {
  for (const path of [
    "docs/security/advisory-response-runbook.md",
    "docs/security/advisory-drills/README.md",
    "docs/security/advisory-drills/2026-07-20-config-input-crash.json"
  ]) {
    assert.ok(existsSync(join(repoRoot, path)), `missing ${path}`);
  }

  const runbook = read("docs/security/advisory-response-runbook.md");
  for (const stage of [
    "Intake",
    "Triage",
    "Regression test",
    "Private fix",
    "Advisory decision",
    "Closeout"
  ]) {
    assert.ok(runbook.includes(stage), `advisory runbook must document ${stage}`);
  }

  assert.match(runbook, /GitHub Security Advisories/);
  assert.match(runbook, /synthetic/i);
});

test("community review packet is pinned and cannot claim completion without external evidence", () => {
  for (const path of [
    "docs/security/community-review-packet.md",
    "docs/security/reviews/README.md",
    "docs/security/reviews/TS-REVIEW-2026-001.json"
  ]) {
    assert.ok(existsSync(join(repoRoot, path)), `missing ${path}`);
  }

  const packet = read("docs/security/community-review-packet.md");
  for (const focus of [
    "Loader isolation",
    "Capability broker",
    "Egress and proxy",
    "Identity and RBAC",
    "Storage isolation",
    "Admin UI"
  ]) {
    assert.ok(packet.includes(focus), `community review packet must cover ${focus}`);
  }
  assert.match(packet, /Private Vulnerability Reporting/);
  assert.match(packet, /independent reviewer/i);

  const campaign = JSON.parse(read("docs/security/reviews/TS-REVIEW-2026-001.json"));
  assert.equal(campaign.status, "prepared");
  assert.match(campaign.baselineCommit, /^[0-9a-f]{40}$/);
  assert.deepEqual(campaign.reviewers, []);
  assert.equal(campaign.completedAt, null);
});

test("Tier 1 fetches review baseline history before validating campaigns", () => {
  const workflow = read(".github/workflows/tier1.yml");

  assert.match(workflow, /actions\/checkout@v6\n\s+with:\n\s+fetch-depth: 0/);
  assert.match(workflow, /pnpm lint:security-reviews|pnpm lint/);
});
