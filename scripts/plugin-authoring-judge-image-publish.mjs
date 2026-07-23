#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repository = "albert-einshutoin/TenantScript";
const imageName = "ghcr.io/albert-einshutoin/tenantscript-plugin-authoring-judge";
const blockers = Object.freeze(["independent-review"]);
const revisionPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

export function createPluginAuthoringJudgeImagePublicationReceipt({
  sourceRevision,
  workflowRunId,
  imageDigest,
  attestationId,
  attestationUrl
}) {
  const runId = parsePositiveId(workflowRunId);
  const parsedAttestationId = parsePositiveId(attestationId);
  return validatePluginAuthoringJudgeImagePublicationReceipt(
    {
      schemaVersion: 1,
      kind: "plugin-authoring-judge-image-publication",
      source: { repository, revision: sourceRevision },
      workflow: {
        event: "workflow_dispatch",
        runId,
        url: `https://github.com/${repository}/actions/runs/${String(runId)}`
      },
      image: {
        name: imageName,
        digest: imageDigest,
        reference: `${imageName}@${imageDigest}`,
        platform: "linux/amd64"
      },
      attestation: { id: parsedAttestationId, url: attestationUrl },
      decision: { status: "published-candidate", blockers }
    },
    { returnReceipt: true }
  );
}

export function validatePluginAuthoringJudgeImagePublicationReceipt(
  receipt,
  { returnReceipt = false } = {}
) {
  try {
    assertPlainRecord(receipt);
    assertExactKeys(receipt, [
      "attestation",
      "decision",
      "image",
      "kind",
      "schemaVersion",
      "source",
      "workflow"
    ]);
    assert(receipt.schemaVersion === 1);
    assert(receipt.kind === "plugin-authoring-judge-image-publication");

    assertPlainRecord(receipt.source);
    assertExactKeys(receipt.source, ["repository", "revision"]);
    assert(receipt.source.repository === repository);
    assert(revisionPattern.test(receipt.source.revision));

    assertPlainRecord(receipt.workflow);
    assertExactKeys(receipt.workflow, ["event", "runId", "url"]);
    assert(receipt.workflow.event === "workflow_dispatch");
    assertPositiveId(receipt.workflow.runId);
    assertExactGithubUrl(
      receipt.workflow.url,
      `/${repository}/actions/runs/${String(receipt.workflow.runId)}`
    );

    assertPlainRecord(receipt.image);
    assertExactKeys(receipt.image, ["digest", "name", "platform", "reference"]);
    assert(receipt.image.name === imageName);
    assert(digestPattern.test(receipt.image.digest));
    assert(receipt.image.reference === `${imageName}@${receipt.image.digest}`);
    assert(receipt.image.platform === "linux/amd64");

    assertPlainRecord(receipt.attestation);
    assertExactKeys(receipt.attestation, ["id", "url"]);
    assertPositiveId(receipt.attestation.id);
    assertExactGithubUrl(
      receipt.attestation.url,
      `/${repository}/attestations/${String(receipt.attestation.id)}`
    );

    assertPlainRecord(receipt.decision);
    assertExactKeys(receipt.decision, ["blockers", "status"]);
    assert(receipt.decision.status === "published-candidate");
    assert.deepEqual(receipt.decision.blockers, blockers);

    const validated = structuredClone(receipt);
    return returnReceipt
      ? validated
      : Object.freeze({
          revision: receipt.source.revision,
          imageReference: receipt.image.reference,
          attestationUrl: receipt.attestation.url,
          status: receipt.decision.status
        });
  } catch {
    throw new Error("judge image publication receipt is invalid");
  }
}

export function writePluginAuthoringJudgeImagePublicationReceipt(pathInput, input) {
  try {
    const outputPath = resolve(pathInput);
    const parent = dirname(outputPath);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o755 });
    const parentMetadata = lstatSync(parent);
    assert(parentMetadata.isDirectory() && !parentMetadata.isSymbolicLink());
    assert(!existsSync(outputPath));
    const receipt = createPluginAuthoringJudgeImagePublicationReceipt(input);
    writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o644,
      flag: "wx"
    });
    return receipt;
  } catch {
    throw new Error("judge image publication receipt could not be written");
  }
}

export function readPluginAuthoringJudgeImagePublicationReceipt(pathInput) {
  try {
    const path = resolve(pathInput);
    const metadata = lstatSync(path);
    assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1);
    assert(metadata.size >= 1 && metadata.size <= 32 * 1024);
    return validatePluginAuthoringJudgeImagePublicationReceipt(
      JSON.parse(readFileSync(path, "utf8")),
      { returnReceipt: true }
    );
  } catch {
    throw new Error("judge image publication receipt is invalid");
  }
}

function parsePositiveId(value) {
  assert(typeof value === "string" && /^[1-9][0-9]{0,15}$/u.test(value));
  const parsed = Number(value);
  assertPositiveId(parsed);
  return parsed;
}

function assertPositiveId(value) {
  assert(Number.isSafeInteger(value) && value >= 1);
}

function assertExactGithubUrl(value, expectedPath) {
  assert(typeof value === "string" && value.length <= 300);
  const url = new URL(value);
  assert(url.protocol === "https:" && url.hostname === "github.com");
  assert(url.username === "" && url.password === "" && url.port === "");
  assert(url.pathname === expectedPath && url.search === "" && url.hash === "");
}

function assertPlainRecord(value) {
  assert(
    typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactKeys(value, expected) {
  assert.deepEqual(Object.keys(value).sort(compareText), [...expected].sort(compareText));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    assert(process.argv.length === 4 && process.argv[2] === "write");
    writePluginAuthoringJudgeImagePublicationReceipt(process.argv[3], {
      sourceRevision: process.env.SOURCE_REVISION,
      workflowRunId: process.env.GITHUB_RUN_ID,
      imageDigest: process.env.IMAGE_DIGEST,
      attestationId: process.env.ATTESTATION_ID,
      attestationUrl: process.env.ATTESTATION_URL
    });
    process.stdout.write("Judge image publication receipt written.\n");
  } catch {
    process.stderr.write("Judge image publication receipt could not be written.\n");
    process.exitCode = 1;
  }
}
