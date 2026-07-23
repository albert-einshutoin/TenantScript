import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  createPluginAuthoringJudgeImagePublicationReceipt,
  readPluginAuthoringJudgeImagePublicationReceipt,
  validatePluginAuthoringJudgeImagePublicationReceipt
} from "./plugin-authoring-judge-image-publish.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;

function receiptFixture() {
  return {
    schemaVersion: 1,
    kind: "plugin-authoring-judge-image-publication",
    source: {
      repository: "albert-einshutoin/TenantScript",
      revision
    },
    workflow: {
      event: "workflow_dispatch",
      runId: 123456789,
      url: "https://github.com/albert-einshutoin/TenantScript/actions/runs/123456789"
    },
    image: {
      name: "ghcr.io/albert-einshutoin/tenantscript-plugin-authoring-judge",
      digest,
      reference: "ghcr.io/albert-einshutoin/tenantscript-plugin-authoring-judge@" + digest,
      platform: "linux/amd64"
    },
    attestation: {
      id: 987654321,
      url: "https://github.com/albert-einshutoin/TenantScript/attestations/987654321"
    },
    decision: {
      status: "published-candidate",
      blockers: ["independent-review"]
    }
  };
}

test("creates and validates a digest-bound publication receipt", () => {
  const expected = receiptFixture();
  assert.deepEqual(
    createPluginAuthoringJudgeImagePublicationReceipt({
      sourceRevision: revision,
      workflowRunId: "123456789",
      imageDigest: digest,
      attestationId: "987654321",
      attestationUrl: expected.attestation.url
    }),
    expected
  );
  assert.deepEqual(validatePluginAuthoringJudgeImagePublicationReceipt(expected), {
    revision,
    imageReference: expected.image.reference,
    attestationUrl: expected.attestation.url,
    status: "published-candidate"
  });
});

test("fails closed for drift, widening, mutable references, and approval claims", () => {
  const cases = [];

  const widened = structuredClone(receiptFixture());
  widened.image.tag = "latest";
  cases.push(widened);

  const mutable = structuredClone(receiptFixture());
  mutable.image.reference = `${mutable.image.name}:latest`;
  cases.push(mutable);

  const digestDrift = structuredClone(receiptFixture());
  digestDrift.image.reference = `${digestDrift.image.name}@sha256:${"c".repeat(64)}`;
  cases.push(digestDrift);

  const workflowDrift = structuredClone(receiptFixture());
  workflowDrift.workflow.event = "pull_request";
  cases.push(workflowDrift);

  const unsafeUrl = structuredClone(receiptFixture());
  unsafeUrl.attestation.url += "?token=secret";
  cases.push(unsafeUrl);

  const approved = structuredClone(receiptFixture());
  approved.decision = { status: "reviewed", blockers: [] };
  cases.push(approved);

  for (const input of cases) {
    assert.throws(
      () => validatePluginAuthoringJudgeImagePublicationReceipt(input),
      /judge image publication receipt is invalid/u
    );
  }
});

test("CLI writes a bounded receipt once and rejects an existing destination", () => {
  const root = join(repoRoot, ".tmp", `judge-image-publication-test-${String(process.pid)}`);
  const path = join(root, "receipt.json");
  rmSync(root, { recursive: true, force: true });
  try {
    const fixture = receiptFixture();
    // Match the hosted receipt job without inheriting developer credentials or machine state.
    const environment = {
      PATH: process.env.PATH ?? "",
      SOURCE_REVISION: revision,
      GITHUB_RUN_ID: String(fixture.workflow.runId),
      IMAGE_DIGEST: digest,
      ATTESTATION_ID: String(fixture.attestation.id),
      ATTESTATION_URL: fixture.attestation.url
    };
    const first = spawnSync(
      process.execPath,
      [join(repoRoot, "scripts", "plugin-authoring-judge-image-publish.mjs"), "write", path],
      { cwd: repoRoot, encoding: "utf8", env: environment }
    );
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, "Judge image publication receipt written.\n");
    assert.deepEqual(readPluginAuthoringJudgeImagePublicationReceipt(path), fixture);

    const second = spawnSync(
      process.execPath,
      [join(repoRoot, "scripts", "plugin-authoring-judge-image-publish.mjs"), "write", path],
      { cwd: repoRoot, encoding: "utf8", env: environment }
    );
    assert.notEqual(second.status, 0);
    assert.equal(second.stderr, "Judge image publication receipt could not be written.\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stages the allowlisted build context through a one-shot CLI", () => {
  const output = join(repoRoot, ".tmp", `judge-image-context-test-${String(process.pid)}`);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(join(repoRoot, ".tmp"), { recursive: true });
  try {
    const first = spawnSync(
      process.execPath,
      [join(repoRoot, "scripts", "plugin-authoring-judge-image-context.mjs"), output],
      { cwd: repoRoot, encoding: "utf8" }
    );
    assert.equal(first.status, 0, first.stderr);
    const observation = JSON.parse(first.stdout);
    assert.equal(observation.files > 0, true);
    assert.equal(observation.totalBytes > 0, true);
    assert.equal(existsSync(join(output, "deploy", "plugin-authoring-judge", "Dockerfile")), true);
    assert.equal(existsSync(join(output, ".devloop", "ledger.jsonl")), false);
    assert.equal(
      existsSync(join(output, "scripts", "plugin-authoring-judge-image-publish.test.mjs")),
      false
    );

    const second = spawnSync(
      process.execPath,
      [join(repoRoot, "scripts", "plugin-authoring-judge-image-context.mjs"), output],
      { cwd: repoRoot, encoding: "utf8" }
    );
    assert.notEqual(second.status, 0);
    assert.equal(second.stderr, "plugin authoring judge image context is invalid\n");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("publish workflow keeps privileged publication manual and digest-bound", async () => {
  const [workflow, guide, tier1] = await Promise.all([
    readFile(new URL("../.github/workflows/publish-judge-image.yml", import.meta.url), "utf8"),
    readFile(
      new URL("../docs/operations/plugin-authoring-judge-image-publication.md", import.meta.url),
      "utf8"
    ),
    readFile(new URL("../.github/workflows/tier1.yml", import.meta.url), "utf8")
  ]);

  assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/u);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request|schedule):/mu);
  assert.match(workflow, /source_revision:/u);
  assert.match(workflow, /test "\$\{#SOURCE_REVISION\}" -eq 40/u);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /test "\$SOURCE_REVISION" = "\$GITHUB_SHA"/u);
  assert.doesNotMatch(workflow, /secrets\.[A-Za-z0-9_]+/u);
  assert.match(
    workflow,
    /permissions:\s*\n\s*contents: read\s*\n\s*packages: write\s*\n\s*id-token: write\s*\n\s*attestations: write/u
  );
  assert.match(workflow, /environment:\s*judge-image-publish/u);
  assert.match(workflow, /git merge-base --is-ancestor "\$SOURCE_REVISION" origin\/main/u);
  assert.match(workflow, /pnpm test:judge-image/u);
  assert.match(workflow, /node --test scripts\/plugin-authoring-judge-image-publish\.test\.mjs/u);
  assert.match(workflow, /pnpm test:security/u);
  assert.match(workflow, /pnpm judge-image:evidence/u);
  assert.match(workflow, /node scripts\/plugin-authoring-judge-image-context\.mjs/u);
  assert.match(workflow, /context:\s*\.tmp\/plugin-authoring-judge-publish-context/u);
  assert.match(workflow, /platforms:\s*linux\/amd64/u);
  assert.match(workflow, /push:\s*true/u);
  assert.match(
    workflow,
    /tags:\s*\$\{\{ env\.IMAGE_NAME \}\}:sha-\$\{\{ inputs\.source_revision \}\}/u
  );
  assert.doesNotMatch(workflow, /:latest/u);
  assert.match(workflow, /uses:\s*actions\/attest@v4/u);
  assert.match(workflow, /subject-name:\s*\$\{\{ env\.IMAGE_NAME \}\}/u);
  assert.match(workflow, /subject-digest:\s*\$\{\{ steps\.publish\.outputs\.digest \}\}/u);
  assert.match(workflow, /push-to-registry:\s*true/u);
  assert.match(workflow, /create-storage-record:\s*false/u);
  assert.doesNotMatch(workflow, /artifact-metadata:\s*write/u);
  assert.match(workflow, /uses:\s*actions\/upload-artifact@v6/u);
  assert.match(workflow, /node scripts\/plugin-authoring-judge-image-publish\.mjs write/u);
  assert.doesNotMatch(workflow, /--secret|ssh:/u);
  assert.equal(workflow.match(/packages: write/gu)?.length, 1);
  assert.ok(
    workflow.indexOf("node scripts/check-judge-image-review-records.mjs") <
      workflow.indexOf("docker/login-action")
  );
  const publishJob = workflow.slice(
    workflow.indexOf("\n  publish:"),
    workflow.indexOf("\n  receipt:")
  );
  assert.doesNotMatch(publishJob, /actions\/checkout/u);
  assert.doesNotMatch(publishJob, /^\s+- run:/mu);

  assert.match(tier1, /node --test scripts\/plugin-authoring-judge-image-publish\.test\.mjs/u);
  assert.match(guide, /workflow_dispatch/u);
  assert.match(guide, /gh attestation verify/u);
  assert.match(guide, /oci:\/\/<image\.reference>/u);
  assert.match(guide, /--signer-workflow/u);
  assert.match(guide, /--source-digest/u);
  assert.match(guide, /--bundle-from-oci/u);
  assert.match(guide, /published-candidate/u);
  assert.match(guide, /independent-review/u);
  assert.match(guide, /container visibility/u);
  assert.match(guide, /未認証/u);
  assert.match(guide, /@sha256:/u);
});
