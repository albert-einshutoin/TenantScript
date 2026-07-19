import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "check-security-review-campaigns.mjs"
);
const requiredFocus = [
  "loader-isolation",
  "capability-broker",
  "egress-proxy",
  "identity-rbac",
  "storage-isolation",
  "admin-ui"
];

function withRepo(run) {
  const repoRoot = mkdtempSync(join(tmpdir(), "security-review-"));
  try {
    mkdirSync(join(repoRoot, "docs", "security", "reviews"), { recursive: true });
    mkdirSync(join(repoRoot, "evidence"), { recursive: true });
    mkdirSync(join(repoRoot, "packages", "loader"), { recursive: true });
    mkdirSync(join(repoRoot, "packages", "capabilities"), { recursive: true });
    writeFileSync(join(repoRoot, "evidence", "review.txt"), "sanitized review evidence\n");
    writeFileSync(join(repoRoot, "packages", "loader", "index.ts"), "export {};\n");
    writeFileSync(join(repoRoot, "packages", "capabilities", "index.ts"), "export {};\n");
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "review-test@example.invalid"], {
      cwd: repoRoot
    });
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

test("accepts a prepared campaign pinned to an existing commit", () => {
  withRepo((repoRoot, baselineCommit) => {
    writeCampaign(repoRoot, preparedCampaign(baselineCommit));

    const result = runChecker(repoRoot);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Security review campaign check passed \(1 campaign\)/);
  });
});

test("rejects a mutable or missing review baseline", () => {
  withRepo((repoRoot, baselineCommit) => {
    writeCampaign(repoRoot, { ...preparedCampaign(baselineCommit), baselineCommit: "main" });

    const result = runChecker(repoRoot);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /baselineCommit must be a full 40-character commit SHA/);
  });
});

test("rejects review scope outside the repository or absent from the baseline", () => {
  withRepo((repoRoot, baselineCommit) => {
    writeCampaign(repoRoot, {
      ...preparedCampaign(baselineCommit),
      scope: ["../private-review", "packages/missing"]
    });

    const result = runChecker(repoRoot);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /scope must stay inside the repository: \.\.\/private-review/);
    assert.match(result.stderr, /scope does not exist: packages\/missing/);
  });
});

test("rejects completed status without independent coverage and with open high findings", () => {
  withRepo((repoRoot, baselineCommit) => {
    const campaign = completedCampaign(baselineCommit);
    campaign.reviewers = [];
    campaign.independenceStatement = null;
    campaign.coverage = campaign.coverage.slice(1);
    campaign.findings = [
      {
        id: "TS-FINDING-001",
        severity: "high",
        status: "open",
        evidence: "evidence/review.txt"
      }
    ];
    writeCampaign(repoRoot, campaign);

    const result = runChecker(repoRoot);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /completed campaign requires at least one reviewer/);
    assert.match(result.stderr, /completed campaign requires an independenceStatement/);
    assert.match(result.stderr, /missing required focus loader-isolation/);
    assert.match(result.stderr, /critical or high finding TS-FINDING-001 is not resolved/);
  });
});

test("accepts completed evidence only after every focus and high finding is resolved", () => {
  withRepo((repoRoot, baselineCommit) => {
    const campaign = completedCampaign(baselineCommit);
    campaign.findings = [
      {
        id: "TS-FINDING-001",
        severity: "high",
        status: "resolved",
        evidence: "evidence/review.txt",
        regressionTest: "evidence/review.txt"
      }
    ];
    writeCampaign(repoRoot, campaign);

    const result = runChecker(repoRoot);

    assert.equal(result.status, 0, result.stderr);
  });
});

function writeCampaign(repoRoot, campaign) {
  writeFileSync(
    join(repoRoot, "docs", "security", "reviews", "campaign.json"),
    `${JSON.stringify(campaign, null, 2)}\n`
  );
}

function preparedCampaign(baselineCommit) {
  return {
    schemaVersion: 1,
    id: "TS-REVIEW-2026-001",
    status: "prepared",
    baselineCommit,
    scope: ["packages/loader", "packages/capabilities"],
    requiredFocus,
    reviewers: [],
    independenceStatement: null,
    startedAt: null,
    completedAt: null,
    coverage: [],
    findings: [],
    attestationEvidence: null,
    remainingLimitations: ["No independent reviewer has started this prepared campaign."]
  };
}

function completedCampaign(baselineCommit) {
  return {
    ...preparedCampaign(baselineCommit),
    status: "completed",
    reviewers: ["independent-reviewer"],
    independenceStatement:
      "The reviewer did not author the reviewed implementation and reports no conflicting interest.",
    startedAt: "2026-07-20T01:00:00.000Z",
    completedAt: "2026-07-20T02:00:00.000Z",
    coverage: requiredFocus.map((focus) => ({
      focus,
      status: "reviewed",
      evidence: "evidence/review.txt"
    })),
    attestationEvidence: "evidence/review.txt"
  };
}
