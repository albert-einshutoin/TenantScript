import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { validatePluginAuthoringJudgeImageReviewRecord } from "./plugin-authoring-judge-image-review-record.mjs";

const headSha = "a".repeat(40);
const mergeSha = "b".repeat(40);

test("binds a candidate review to distinct PR head, workflow merge, and artifact evidence", () => {
  const evidence = validEvidence();
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  const result = validatePluginAuthoringJudgeImageReviewRecord(validRecord(evidenceBytes), {
    artifactMetadata: validArtifactMetadata(),
    evidence,
    evidenceBytes
  });

  assert.deepEqual(result, {
    id: "TS-JUDGE-IMAGE-REVIEW-2026-001",
    decision: "candidate",
    headSha,
    workflowMergeSha: mergeSha
  });
  assert.equal(Object.isFrozen(result), true);
});

test("rejects widening, identity drift, false success, and approval claims", () => {
  const mutations = [
    ["unknown field", (record) => (record.registryDigest = `sha256:${"f".repeat(64)}`)],
    ["head drift", (record) => (record.source.headSha = "c".repeat(40))],
    ["workflow failure", (record) => (record.workflow.conclusion = "failure")],
    ["merge drift", (record) => (record.workflow.mergeSha = "d".repeat(40))],
    ["artifact digest drift", (record) => (record.artifact.digest = `sha256:${"e".repeat(64)}`)],
    ["evidence digest drift", (record) => (record.artifact.evidenceSha256 = "e".repeat(64))],
    ["review drift", (record) => (record.review.reviewedCommit = "f".repeat(40))],
    ["review widening", (record) => (record.review.outcome = "approved")],
    ["approval claim", (record) => (record.decision.status = "approved")],
    ["missing blocker", (record) => record.decision.blockers.pop()],
    ["prototype record", (record) => Object.setPrototypeOf(record.workflow, { inherited: true })],
    ["query URL", (record) => (record.workflow.url += "?token=redacted")]
  ];

  for (const [name, mutate] of mutations) {
    const evidence = validEvidence();
    const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    const record = validRecord(evidenceBytes);
    mutate(record);
    assert.throws(
      () =>
        validatePluginAuthoringJudgeImageReviewRecord(record, {
          artifactMetadata: validArtifactMetadata(),
          evidence,
          evidenceBytes
        }),
      /judge image review record is invalid/u,
      name
    );
  }
});

test("rejects evidence and chronology drift without reflecting attacker values", () => {
  const cases = [
    ["source revision", (evidence) => (evidence.sourceRevision = "c".repeat(40))],
    ["SBOM digest", (evidence) => (evidence.sbom.sha256 = "d".repeat(64))],
    ["image decision", (evidence) => (evidence.decision.status = "approved")],
    [
      "artifact expiry",
      (_evidence, record) => (record.artifact.expiresAt = record.artifact.createdAt)
    ]
  ];

  for (const [name, mutate] of cases) {
    const evidence = validEvidence();
    let evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    const record = validRecord(evidenceBytes);
    mutate(evidence, record);
    evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    if (name !== "artifact expiry") {
      record.artifact.evidenceSha256 = createHash("sha256").update(evidenceBytes).digest("hex");
    }
    assert.throws(
      () =>
        validatePluginAuthoringJudgeImageReviewRecord(record, {
          artifactMetadata: validArtifactMetadata(),
          evidence,
          evidenceBytes
        }),
      /judge image review record is invalid/u,
      name
    );
  }
});

function validRecord(evidenceBytes) {
  return {
    schemaVersion: 1,
    kind: "plugin-authoring-judge-image-review",
    id: "TS-JUDGE-IMAGE-REVIEW-2026-001",
    source: {
      repository: "albert-einshutoin/TenantScript",
      pullRequest: 337,
      headSha
    },
    workflow: {
      event: "pull_request",
      runId: 29_971_113_794,
      jobId: 89_093_143_431,
      mergeSha,
      conclusion: "success",
      completedAt: "2026-07-23T01:21:07.000Z",
      url: "https://github.com/albert-einshutoin/TenantScript/actions/runs/29971113794"
    },
    artifact: {
      id: 8_549_777_257,
      name: `plugin-authoring-judge-image-evidence-${mergeSha}`,
      digest: `sha256:${"1".repeat(64)}`,
      sizeBytes: 307_742,
      createdAt: "2026-07-23T01:15:34.000Z",
      expiresAt: "2026-08-06T01:15:33.000Z",
      evidenceSha256: createHash("sha256").update(evidenceBytes).digest("hex"),
      sbomSha256: "2".repeat(64)
    },
    review: {
      provider: "codex",
      reviewedCommit: headSha,
      outcome: "no-major-issues",
      url: "https://github.com/albert-einshutoin/TenantScript/pull/337#issuecomment-5053261370"
    },
    decision: {
      status: "candidate",
      blockers: ["attestation", "independent-review", "registry-digest"]
    }
  };
}

function validArtifactMetadata() {
  return {
    schemaVersion: 1,
    kind: "github-actions-artifact-observation",
    repository: "albert-einshutoin/TenantScript",
    artifact: {
      id: 8_549_777_257,
      name: `plugin-authoring-judge-image-evidence-${mergeSha}`,
      digest: `sha256:${"1".repeat(64)}`,
      sizeBytes: 307_742,
      createdAt: "2026-07-23T01:15:34.000Z",
      expiresAt: "2026-08-06T01:15:33.000Z"
    },
    workflowRun: {
      id: 29_971_113_794,
      headSha
    }
  };
}

function validEvidence() {
  return {
    schemaVersion: 1,
    kind: "plugin-authoring-judge-image-candidate",
    platform: "linux/amd64",
    sourceRevision: mergeSha,
    inputs: {
      baseImage: "node@sha256:1a6a7b2e2e2c80a6973f57aa8b0c6ad67a961ddbc5ef326c448e133f93564ff9",
      dockerfileFrontend:
        "docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e",
      dockerfileSha256: "5".repeat(64),
      lockfileSha256: "6".repeat(64),
      contextSha256: "7".repeat(64)
    },
    image: {
      reference: "tenantscript/plugin-authoring-judge:evidence",
      id: `sha256:${"8".repeat(64)}`,
      archiveSha256: "9".repeat(64),
      archiveBytes: 277_344_256
    },
    sbom: {
      format: "CycloneDX",
      specVersion: "1.7",
      sha256: "2".repeat(64),
      bytes: 1_398_931,
      components: 3_536,
      dependencies: 81,
      scanner: {
        name: "syft",
        version: "1.49.0",
        image:
          "anchore/syft@sha256:9a9f85314017f1ea798fb012edfa7fe9259923910f82c8d4bc983ab5c765e60b"
      }
    },
    decision: {
      status: "candidate",
      blockers: ["attestation", "independent-review", "registry-digest"]
    }
  };
}
