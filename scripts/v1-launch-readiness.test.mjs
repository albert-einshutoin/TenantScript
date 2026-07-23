import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { readV1LaunchReadiness, validateV1LaunchReadiness } from "./v1-launch-readiness.mjs";

const blockerIds = [
  "production-adopters",
  "external-contributors",
  "advisory-response",
  "external-security-review",
  "independent-self-host",
  "v1-blocker-issues",
  "release-materials"
];

function blockedFixture() {
  return {
    schemaVersion: 1,
    kind: "tenantscript-v1-launch-readiness",
    repository: "albert-einshutoin/TenantScript",
    targetVersion: "1.0.0",
    gates: {
      productionAdopters: {
        required: 5,
        verified: 0,
        evidence: ["ADOPTERS.md"]
      },
      externalContributors: {
        required: 10,
        verified: 0,
        evidence: []
      },
      advisoryResponses: {
        required: 1,
        verified: 0,
        evidence: []
      },
      externalSecurityReview: {
        completed: false,
        criticalOpen: null,
        highOpen: null,
        evidence: ["docs/security/community-review-packet.md"]
      },
      selfHostValidators: {
        required: 2,
        verified: 0,
        evidence: ["docs/operations/self-host-production.md"]
      },
      releaseBlockers: {
        openIssues: [2, 3, 4, 21, 23, 31, 32, 33, 34, 35],
        evidence: ["docs/reviews/phase0-gate-evidence.md"]
      },
      releaseMaterials: {
        changelog: false,
        announcement: false,
        evidence: []
      }
    },
    decision: {
      status: "blocked",
      blockers: [...blockerIds]
    }
  };
}

function approvedFixture() {
  const record = blockedFixture();
  record.gates.productionAdopters.verified = 5;
  record.gates.externalContributors.verified = 10;
  record.gates.externalContributors.evidence = ["docs/releases/v1-external-contributors.md"];
  record.gates.advisoryResponses.verified = 1;
  record.gates.advisoryResponses.evidence = ["docs/security/advisory-drills/README.md"];
  record.gates.externalSecurityReview = {
    completed: true,
    criticalOpen: 0,
    highOpen: 0,
    evidence: ["https://example.org/tenantscript-security-review"]
  };
  record.gates.selfHostValidators.verified = 2;
  record.gates.releaseBlockers.openIssues = [];
  record.gates.releaseBlockers.evidence = ["docs/releases/v1-blocker-triage.md"];
  record.gates.releaseMaterials = {
    changelog: true,
    announcement: true,
    evidence: ["CHANGELOG.md", "docs/releases/v1-announcement.md"]
  };
  record.decision = { status: "approved", blockers: [] };
  return record;
}

test("accepts the honest blocked record without treating it as release approval", () => {
  const record = validateV1LaunchReadiness(blockedFixture());
  assert.equal(record.decision.status, "blocked");
  assert.deepEqual(record.decision.blockers, blockerIds);
  assert.throws(
    () => validateV1LaunchReadiness(blockedFixture(), { requireApproved: true }),
    /v1 launch readiness is not approved/u
  );
});

test("accepts approval only when every quantitative and review gate is complete", () => {
  const record = validateV1LaunchReadiness(approvedFixture(), { requireApproved: true });
  assert.equal(record.decision.status, "approved");
  assert.deepEqual(record.decision.blockers, []);
});

test("keeps a completed external review blocked while critical or high findings remain", () => {
  const record = approvedFixture();
  record.gates.externalSecurityReview.highOpen = 1;
  record.decision = {
    status: "blocked",
    blockers: ["external-security-review"]
  };
  assert.equal(validateV1LaunchReadiness(record).decision.status, "blocked");
  assert.throws(
    () => validateV1LaunchReadiness(record, { requireApproved: true }),
    /v1 launch readiness is not approved/u
  );
});

test("derives blockers and rejects widening, false approval, and unsafe evidence", () => {
  const cases = [];
  const missingGate = blockedFixture();
  delete missingGate.gates.releaseMaterials;
  cases.push(missingGate);

  const unknownField = blockedFixture();
  unknownField.gates.productionAdopters.note = "trust me";
  cases.push(unknownField);

  const wrongRequirement = blockedFixture();
  wrongRequirement.gates.productionAdopters.required = 1;
  cases.push(wrongRequirement);

  const falseApproval = blockedFixture();
  falseApproval.decision = { status: "approved", blockers: [] };
  cases.push(falseApproval);

  const missingBlocker = blockedFixture();
  missingBlocker.decision.blockers.pop();
  cases.push(missingBlocker);

  const unsafePath = blockedFixture();
  unsafePath.gates.productionAdopters.evidence = ["../../private/adopters.md"];
  cases.push(unsafePath);

  const machinePath = blockedFixture();
  machinePath.gates.productionAdopters.evidence = ["/Users/example/review.md"];
  cases.push(machinePath);

  const credentialUrl = blockedFixture();
  credentialUrl.gates.productionAdopters.evidence = ["https://user:password@example.org/review"];
  cases.push(credentialUrl);

  const queryUrl = blockedFixture();
  queryUrl.gates.productionAdopters.evidence = ["https://example.org/review?token=redacted"];
  cases.push(queryUrl);

  const loopbackUrl = blockedFixture();
  loopbackUrl.gates.productionAdopters.evidence = ["https://[::1]/review"];
  cases.push(loopbackUrl);

  const localHostname = blockedFixture();
  localHostname.gates.productionAdopters.evidence = ["https://review.internal/report"];
  cases.push(localHostname);

  const duplicateIssues = blockedFixture();
  duplicateIssues.gates.releaseBlockers.openIssues = [2, 2];
  cases.push(duplicateIssues);

  const unsortedIssues = blockedFixture();
  unsortedIssues.gates.releaseBlockers.openIssues = [3, 2];
  cases.push(unsortedIssues);

  const incompleteReviewCounts = blockedFixture();
  incompleteReviewCounts.gates.externalSecurityReview.criticalOpen = 0;
  cases.push(incompleteReviewCounts);

  const completedReviewWithoutCounts = approvedFixture();
  completedReviewWithoutCounts.gates.externalSecurityReview.highOpen = null;
  cases.push(completedReviewWithoutCounts);

  const prototypeRecord = blockedFixture();
  Object.setPrototypeOf(prototypeRecord.gates, { inherited: true });
  cases.push(prototypeRecord);

  for (const record of cases) {
    assert.throws(
      () => validateV1LaunchReadiness(record),
      /v1 launch readiness record is invalid/u
    );
  }
});

test("reads the committed record as bounded blocked evidence", () => {
  const record = readV1LaunchReadiness(
    new URL("../docs/releases/v1-launch-readiness.json", import.meta.url),
    { repositoryRoot: new URL("..", import.meta.url) }
  );
  assert.equal(record.decision.status, "blocked");
  assert.deepEqual(record.decision.blockers, blockerIds);
});

test("rejects evidence reached through a symlinked repository directory", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tenantscript-v1-readiness-root-"));
  const outside = mkdtempSync(resolve(tmpdir(), "tenantscript-v1-readiness-outside-"));
  try {
    mkdirSync(resolve(root, "docs/releases"), { recursive: true });
    writeFileSync(resolve(outside, "report.md"), "outside evidence\n");
    symlinkSync(outside, resolve(root, "evidence"));
    const record = blockedFixture();
    record.gates.productionAdopters.evidence = ["evidence/report.md"];
    record.gates.externalSecurityReview.evidence = ["evidence/report.md"];
    record.gates.selfHostValidators.evidence = ["evidence/report.md"];
    record.gates.releaseBlockers.evidence = ["evidence/report.md"];
    const recordPath = resolve(root, "docs/releases/v1-launch-readiness.json");
    writeFileSync(recordPath, JSON.stringify(record));

    assert.throws(
      () => readV1LaunchReadiness(recordPath, { repositoryRoot: root }),
      /v1 launch readiness record is invalid/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("CLI and release workflow keep the readiness gate visible", () => {
  const cli = spawnSync(
    process.execPath,
    [new URL("./v1-launch-readiness.mjs", import.meta.url).pathname],
    { encoding: "utf8" }
  );
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, "");
  assert.equal(cli.stderr, "v1 launch readiness check failed\n");

  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8"
  );
  const tier1 = readFileSync(new URL("../.github/workflows/tier1.yml", import.meta.url), "utf8");
  const guide = readFileSync(
    new URL("../docs/reference/release-automation.md", import.meta.url),
    "utf8"
  );
  assert.match(workflow, /node scripts\/release-preflight\.mjs/u);
  assert.match(tier1, /node --test scripts\/v1-launch-readiness\.test\.mjs/u);
  assert.match(guide, /v1-launch-readiness\.json/u);
  assert.match(guide, /approved/u);
  assert.match(guide, /blocked/u);
});
