import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = join(repoRoot, "docs", "reviews", "phase0-gate-evidence.md");
const read = (path) => readFileSync(join(repoRoot, path), "utf8");

test("Phase 0 evidence distinguishes completed and externally blocked gates", () => {
  assert.ok(existsSync(evidencePath), "missing Phase 0 gate evidence document");
  const evidence = read("docs/reviews/phase0-gate-evidence.md");

  for (const topic of [
    "E2E demo",
    "Runtime latency",
    "Security suite",
    "CI / fork PR",
    "npm scope",
    "Design partner"
  ]) {
    assert.ok(evidence.includes(topic), `gate evidence must cover ${topic}`);
  }

  for (const issue of [2, 3, 4]) {
    assert.ok(
      evidence.includes(`https://github.com/albert-einshutoin/TenantScript/issues/${issue}`),
      `gate evidence must link open blocker #${issue}`
    );
  }

  assert.match(evidence, /completed/i);
  assert.match(evidence, /blocked/i);
  assert.match(evidence, /private (?:system|maintainer record)/i);
});

test("public status entrypoints link the canonical Phase 0 evidence", () => {
  const readme = read("README.md");
  const phase0 = read("tasks/Phase0.md");

  assert.ok(readme.includes("(docs/reviews/phase0-gate-evidence.md)"));
  assert.ok(phase0.includes("(../docs/reviews/phase0-gate-evidence.md)"));
  assert.match(phase0, /- \[x\] E2E デモ成立/);
  assert.match(phase0, /- \[x\] adversarial security suite green/);
  assert.match(phase0, /- \[x\] 全 package カバレッジ 80%\+、CI green/);
});
