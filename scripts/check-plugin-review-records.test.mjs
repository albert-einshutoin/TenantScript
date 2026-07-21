import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "check-plugin-review-records.mjs");
const requiredDomains = ["security", "compatibility", "operations", "documentation", "license"];

function withRepo(run) {
  const repoRoot = mkdtempSync(join(tmpdir(), "plugin-review-"));
  try {
    mkdirSync(join(repoRoot, "docs", "security", "plugin-reviews"), { recursive: true });
    mkdirSync(join(repoRoot, "packages", "cli", "src"), { recursive: true });
    mkdirSync(join(repoRoot, "evidence"), { recursive: true });
    writeFileSync(join(repoRoot, "packages", "cli", "src", "plugin-scaffold.ts"), "export {};\n");
    writeFileSync(join(repoRoot, "evidence", "review.txt"), "sanitized evidence\n");
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "review-test@example.invalid"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Review Test"], { cwd: repoRoot });
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "test baseline"], { cwd: repoRoot });
    const baselineCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8"
    }).trim();
    run(repoRoot, baselineCommit);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function runChecker(repoRoot) {
  return spawnSync(process.execPath, [scriptPath, repoRoot], { encoding: "utf8" });
}

test("accepts an approved review pinned to unchanged source", () => {
  withRepo((repoRoot, baselineCommit) => {
    writeRecord(repoRoot, validRecord(baselineCommit));

    const result = runChecker(repoRoot);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Plugin review record check passed \(1 record\)/);
  });
});

test("rejects mutable, missing, or drifted baselines", () => {
  withRepo((repoRoot, baselineCommit) => {
    writeRecord(repoRoot, { ...validRecord(baselineCommit), baselineCommit: "main" });
    let result = runChecker(repoRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /baselineCommit must be a full 40-character commit SHA/);

    writeRecord(repoRoot, { ...validRecord(baselineCommit), baselineCommit: "f".repeat(40) });
    result = runChecker(repoRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /baselineCommit does not exist/);

    writeRecord(repoRoot, validRecord(baselineCommit));
    writeFileSync(
      join(repoRoot, "packages", "cli", "src", "plugin-scaffold.ts"),
      "export const drift = true;\n"
    );
    result = runChecker(repoRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reviewed scope has changed since baselineCommit/);
  });
});

test("rejects incomplete domains and approval with blockers", () => {
  withRepo((repoRoot, baselineCommit) => {
    const record = validRecord(baselineCommit);
    record.domains = record.domains.slice(1);
    record.blockingFindings = ["Generated package does not build."];
    record.unverified = [
      { item: "registry install", required: true, reason: "No registry release." }
    ];
    writeRecord(repoRoot, record);

    const result = runChecker(repoRoot);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing required domain security/);
    assert.match(result.stderr, /approve decision requires no blockingFindings/);
    assert.match(result.stderr, /approve decision cannot leave required verification incomplete/);
  });
});

test("rejects failed domains, path escapes, missing evidence, and unknown fields", () => {
  withRepo((repoRoot, baselineCommit) => {
    const record = validRecord(baselineCommit);
    record.domains[0].status = "fail";
    record.domains[0].evidence = ["../private.txt", "evidence/missing.txt"];
    record.unexpected = true;
    writeRecord(repoRoot, record);

    const result = runChecker(repoRoot);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /approve decision requires every domain to pass/);
    assert.match(result.stderr, /evidence must stay inside the repository/);
    assert.match(result.stderr, /evidence does not exist/);
    assert.match(result.stderr, /unknown field unexpected/);
  });
});

test("rejects sensitive fields, secret-like values, and machine-local paths", () => {
  withRepo((repoRoot, baselineCommit) => {
    const record = validRecord(baselineCommit);
    record.reviewer.token = "redacted";
    record.limitations = ["Reviewed at /Users/example/private checkout"];
    record.nonGuarantees = ["Credential ghp_abcdefghijklmnopqrstuvwxyz123456 was not exercised."];
    writeRecord(repoRoot, record);

    const result = runChecker(repoRoot);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sensitive field reviewer\.token is forbidden/);
    assert.match(result.stderr, /machine-local path is forbidden/);
    assert.match(result.stderr, /secret-like value is forbidden/);
  });
});

function writeRecord(repoRoot, record) {
  writeFileSync(
    join(repoRoot, "docs", "security", "plugin-reviews", "review.json"),
    `${JSON.stringify(record, null, 2)}\n`
  );
}

function validRecord(baselineCommit) {
  return {
    schemaVersion: 1,
    id: "TS-PLUGIN-REVIEW-2026-001",
    baselineCommit,
    target: {
      name: "Built-in plugin scaffold",
      scope: ["packages/cli/src/plugin-scaffold.ts"]
    },
    reviewer: {
      identity: "TenantScript maintainers",
      relationship: "First-party self-review"
    },
    reviewedAt: "2026-07-21T00:00:00.000Z",
    domains: requiredDomains.map((name) => ({
      name,
      status: "pass",
      evidence: ["evidence/review.txt"],
      notes: `Reviewed ${name}.`
    })),
    decision: "approve",
    blockingFindings: [],
    unverified: [],
    limitations: ["This is a first-party review, not an independent audit."],
    nonGuarantees: ["Approval does not certify third-party plugins."]
  };
}
