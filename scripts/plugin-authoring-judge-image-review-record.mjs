import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { PLUGIN_AUTHORING_JUDGE_IMAGE_BASE } from "./plugin-authoring-judge-image-context.mjs";
import {
  PLUGIN_AUTHORING_JUDGE_DOCKERFILE_FRONTEND,
  PLUGIN_AUTHORING_JUDGE_IMAGE_ARCHIVE_MAX_BYTES,
  PLUGIN_AUTHORING_JUDGE_SBOM_MAX_BYTES,
  PLUGIN_AUTHORING_JUDGE_SBOM_MAX_COMPONENTS,
  PLUGIN_AUTHORING_JUDGE_SBOM_MAX_DEPENDENCIES,
  PLUGIN_AUTHORING_JUDGE_SBOM_SCANNER_IMAGE,
  PLUGIN_AUTHORING_JUDGE_SBOM_SCANNER_VERSION
} from "./plugin-authoring-judge-image-sbom.mjs";

const blockers = Object.freeze(["attestation", "independent-review", "registry-digest"]);
const digestPattern = /^[0-9a-f]{64}$/u;
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/u;
const revisionPattern = /^[0-9a-f]{40}$/u;
const reviewIdPattern = /^TS-JUDGE-IMAGE-REVIEW-\d{4}-\d{3}$/u;

export function validatePluginAuthoringJudgeImageReviewRecord(
  record,
  { artifactMetadata, evidence, evidenceBytes }
) {
  try {
    assert(Buffer.isBuffer(evidenceBytes));
    assert(evidenceBytes.length >= 1 && evidenceBytes.length <= 64 * 1024);
    validateEvidence(evidence);
    validateArtifactMetadata(artifactMetadata);
    assertExactKeys(record, [
      "artifact",
      "decision",
      "id",
      "kind",
      "review",
      "schemaVersion",
      "source",
      "workflow"
    ]);
    assert(record.schemaVersion === 1);
    assert(record.kind === "plugin-authoring-judge-image-review");
    assert(typeof record.id === "string" && reviewIdPattern.test(record.id));

    assertExactKeys(record.source, ["headSha", "pullRequest", "repository"]);
    assert(record.source.repository === "albert-einshutoin/TenantScript");
    assert(Number.isSafeInteger(record.source.pullRequest) && record.source.pullRequest >= 1);
    assert(revisionPattern.test(record.source.headSha));
    assert(record.source.repository === artifactMetadata.repository);
    assert(record.source.headSha === artifactMetadata.workflowRun.headSha);

    assertExactKeys(record.workflow, [
      "completedAt",
      "conclusion",
      "event",
      "jobId",
      "mergeSha",
      "runId",
      "url"
    ]);
    assert(record.workflow.event === "pull_request");
    assert(record.workflow.conclusion === "success");
    assertPositiveId(record.workflow.runId);
    assertPositiveId(record.workflow.jobId);
    assert(revisionPattern.test(record.workflow.mergeSha));
    // pull_request runs build GitHub's temporary merge revision, while review targets the PR head.
    // Keeping them distinct prevents a self-consistent record from erasing that provenance boundary.
    assert(record.workflow.mergeSha !== record.source.headSha);
    assert(record.workflow.mergeSha === evidence.sourceRevision);
    assert(record.workflow.runId === artifactMetadata.workflowRun.id);
    const completedAt = parseTimestamp(record.workflow.completedAt);
    assertGithubUrl(
      record.workflow.url,
      `/albert-einshutoin/TenantScript/actions/runs/${String(record.workflow.runId)}`,
      { allowHash: false }
    );

    assertExactKeys(record.artifact, [
      "createdAt",
      "digest",
      "evidenceSha256",
      "expiresAt",
      "id",
      "name",
      "sbomSha256",
      "sizeBytes"
    ]);
    assertPositiveId(record.artifact.id);
    assert(
      record.artifact.name === `plugin-authoring-judge-image-evidence-${record.workflow.mergeSha}`
    );
    assert(imageDigestPattern.test(record.artifact.digest));
    assert(
      Number.isSafeInteger(record.artifact.sizeBytes) &&
        record.artifact.sizeBytes >= 1 &&
        record.artifact.sizeBytes <= 16 * 1024 * 1024
    );
    const createdAt = parseTimestamp(record.artifact.createdAt);
    const expiresAt = parseTimestamp(record.artifact.expiresAt);
    assert(createdAt <= completedAt && expiresAt > createdAt);
    assert(expiresAt - createdAt <= 15 * 24 * 60 * 60 * 1_000);
    assert(digestPattern.test(record.artifact.evidenceSha256));
    assert(
      record.artifact.evidenceSha256 === createHash("sha256").update(evidenceBytes).digest("hex")
    );
    assert(record.artifact.sbomSha256 === evidence.sbom.sha256);
    for (const field of ["createdAt", "digest", "expiresAt", "id", "name", "sizeBytes"]) {
      assert(record.artifact[field] === artifactMetadata.artifact[field]);
    }

    assertExactKeys(record.review, ["outcome", "provider", "reviewedCommit", "url"]);
    assert(record.review.provider === "codex");
    assert(record.review.outcome === "no-major-issues");
    assert(record.review.reviewedCommit === record.source.headSha);
    assertGithubUrl(
      record.review.url,
      `/albert-einshutoin/TenantScript/pull/${String(record.source.pullRequest)}`,
      { allowHash: true }
    );

    assertExactKeys(record.decision, ["blockers", "status"]);
    assert(record.decision.status === "candidate");
    assert.deepEqual(record.decision.blockers, blockers);
    assert.deepEqual(evidence.decision, record.decision);

    return Object.freeze({
      id: record.id,
      decision: record.decision.status,
      headSha: record.source.headSha,
      workflowMergeSha: record.workflow.mergeSha
    });
  } catch {
    throw new Error("judge image review record is invalid");
  }
}

function validateArtifactMetadata(metadata) {
  assertExactKeys(metadata, ["artifact", "kind", "repository", "schemaVersion", "workflowRun"]);
  assert(metadata.schemaVersion === 1);
  assert(metadata.kind === "github-actions-artifact-observation");
  assert(metadata.repository === "albert-einshutoin/TenantScript");
  assertExactKeys(metadata.artifact, [
    "createdAt",
    "digest",
    "expiresAt",
    "id",
    "name",
    "sizeBytes"
  ]);
  assertPositiveId(metadata.artifact.id);
  assert(typeof metadata.artifact.name === "string" && metadata.artifact.name.length <= 160);
  assert(imageDigestPattern.test(metadata.artifact.digest));
  assert(
    Number.isSafeInteger(metadata.artifact.sizeBytes) &&
      metadata.artifact.sizeBytes >= 1 &&
      metadata.artifact.sizeBytes <= 16 * 1024 * 1024
  );
  parseTimestamp(metadata.artifact.createdAt);
  parseTimestamp(metadata.artifact.expiresAt);
  assertExactKeys(metadata.workflowRun, ["headSha", "id"]);
  assertPositiveId(metadata.workflowRun.id);
  assert(revisionPattern.test(metadata.workflowRun.headSha));
}

function validateEvidence(evidence) {
  assertExactKeys(evidence, [
    "decision",
    "image",
    "inputs",
    "kind",
    "platform",
    "sbom",
    "schemaVersion",
    "sourceRevision"
  ]);
  assert(evidence.schemaVersion === 1);
  assert(evidence.kind === "plugin-authoring-judge-image-candidate");
  assert(evidence.platform === "linux/amd64");
  assert(revisionPattern.test(evidence.sourceRevision));

  assertExactKeys(evidence.inputs, [
    "baseImage",
    "contextSha256",
    "dockerfileFrontend",
    "dockerfileSha256",
    "lockfileSha256"
  ]);
  assert(evidence.inputs.baseImage === PLUGIN_AUTHORING_JUDGE_IMAGE_BASE);
  assert(evidence.inputs.dockerfileFrontend === PLUGIN_AUTHORING_JUDGE_DOCKERFILE_FRONTEND);
  assertDigests(evidence.inputs, ["contextSha256", "dockerfileSha256", "lockfileSha256"]);

  assertExactKeys(evidence.image, ["archiveBytes", "archiveSha256", "id", "reference"]);
  assert(evidence.image.reference === "tenantscript/plugin-authoring-judge:evidence");
  assert(imageDigestPattern.test(evidence.image.id));
  assert(digestPattern.test(evidence.image.archiveSha256));
  assert(
    Number.isSafeInteger(evidence.image.archiveBytes) &&
      evidence.image.archiveBytes >= 1 &&
      evidence.image.archiveBytes <= PLUGIN_AUTHORING_JUDGE_IMAGE_ARCHIVE_MAX_BYTES
  );

  assertExactKeys(evidence.sbom, [
    "bytes",
    "components",
    "dependencies",
    "format",
    "scanner",
    "sha256",
    "specVersion"
  ]);
  assert(evidence.sbom.format === "CycloneDX" && evidence.sbom.specVersion === "1.7");
  assert(digestPattern.test(evidence.sbom.sha256));
  assert(
    Number.isSafeInteger(evidence.sbom.bytes) &&
      evidence.sbom.bytes >= 1 &&
      evidence.sbom.bytes <= PLUGIN_AUTHORING_JUDGE_SBOM_MAX_BYTES
  );
  assert(
    Number.isSafeInteger(evidence.sbom.components) &&
      evidence.sbom.components >= 1 &&
      evidence.sbom.components <= PLUGIN_AUTHORING_JUDGE_SBOM_MAX_COMPONENTS
  );
  assert(
    Number.isSafeInteger(evidence.sbom.dependencies) &&
      evidence.sbom.dependencies >= 0 &&
      evidence.sbom.dependencies <= PLUGIN_AUTHORING_JUDGE_SBOM_MAX_DEPENDENCIES
  );
  assertExactKeys(evidence.sbom.scanner, ["image", "name", "version"]);
  assert(evidence.sbom.scanner.name === "syft");
  assert(evidence.sbom.scanner.version === PLUGIN_AUTHORING_JUDGE_SBOM_SCANNER_VERSION);
  assert(evidence.sbom.scanner.image === PLUGIN_AUTHORING_JUDGE_SBOM_SCANNER_IMAGE);

  assertExactKeys(evidence.decision, ["blockers", "status"]);
  assert(evidence.decision.status === "candidate");
  assert.deepEqual(evidence.decision.blockers, blockers);
}

function assertGithubUrl(value, expectedPath, { allowHash }) {
  assert(typeof value === "string" && value.length <= 512);
  const url = new URL(value);
  assert(url.protocol === "https:" && url.hostname === "github.com");
  assert(url.username === "" && url.password === "" && url.search === "");
  assert(url.pathname === expectedPath);
  assert(allowHash ? /^#issuecomment-[1-9][0-9]*$/u.test(url.hash) : url.hash === "");
}

function parseTimestamp(value) {
  assert(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value));
  const timestamp = Date.parse(value);
  assert(Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value);
  return timestamp;
}

function assertPositiveId(value) {
  assert(Number.isSafeInteger(value) && value >= 1);
}

function assertDigests(value, fields) {
  for (const field of fields) assert(digestPattern.test(value[field]));
}

function assertExactKeys(value, keys) {
  assert(isRecord(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

function isRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
