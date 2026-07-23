#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { stagePluginAuthoringJudgeImageContext } from "./plugin-authoring-judge-image-context.mjs";
import { validatePluginAuthoringJudgeImageReviewRecord } from "./plugin-authoring-judge-image-review-record.mjs";

const repositoryRoot = resolve(process.argv[2] ?? process.cwd());
const recordsRoot = join(repositoryRoot, "docs", "security", "judge-image-reviews");
const evidenceRoot = join(recordsRoot, "evidence");

try {
  assertSafeDirectory(recordsRoot);
  assertSafeDirectory(evidenceRoot);
  const recordFiles = readdirSync(recordsRoot)
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert(recordFiles.length >= 1 && recordFiles.length <= 32);
  const expectedEvidenceFiles = new Set(
    recordFiles.flatMap((recordFile) => [
      recordFile,
      recordFile.replace(/\.json$/u, ".artifact.json")
    ])
  );
  assert.deepEqual(new Set(readdirSync(evidenceRoot)), expectedEvidenceFiles);
  const sourceDigests = calculateSourceDigests();

  for (const recordFile of recordFiles) {
    assert(/^TS-JUDGE-IMAGE-REVIEW-\d{4}-\d{3}\.json$/u.test(recordFile));
    const recordPath = join(recordsRoot, recordFile);
    const evidencePath = join(evidenceRoot, recordFile);
    const artifactMetadataPath = join(
      evidenceRoot,
      recordFile.replace(/\.json$/u, ".artifact.json")
    );
    const recordBytes = readBoundedRegularFile(recordPath, 64 * 1024);
    const evidenceBytes = readBoundedRegularFile(evidencePath, 64 * 1024);
    const artifactMetadataBytes = readBoundedRegularFile(artifactMetadataPath, 64 * 1024);
    const record = JSON.parse(recordBytes);
    const evidence = JSON.parse(evidenceBytes);
    const artifactMetadata = JSON.parse(artifactMetadataBytes);
    validatePluginAuthoringJudgeImageReviewRecord(record, {
      artifactMetadata,
      evidence,
      evidenceBytes
    });
    assert(recordFile === `${record.id}.json`);
    assert(evidence.inputs.dockerfileSha256 === sourceDigests.dockerfileSha256);
    assert(evidence.inputs.lockfileSha256 === sourceDigests.lockfileSha256);
    assert(evidence.inputs.contextSha256 === sourceDigests.contextSha256);
  }

  process.stdout.write(
    `Judge image review record check passed (${String(recordFiles.length)} record${recordFiles.length === 1 ? "" : "s"}).\n`
  );
} catch {
  process.stderr.write("Judge image review records are invalid.\n");
  process.exitCode = 1;
}

function calculateSourceDigests() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "tenantscript-judge-review-context-"));
  try {
    const contextRoot = join(temporaryRoot, "context");
    const staged = stagePluginAuthoringJudgeImageContext({
      repositoryRoot,
      outputRoot: contextRoot
    });
    // Rebuild the canonical framed digest independently so a future builder change cannot make an
    // older review record appear current without updating both the evidence and this verifier.
    const contextHash = createHash("sha256");
    for (const path of staged.paths) {
      const bytes = readFileSync(join(contextRoot, path));
      contextHash.update(`${String(Buffer.byteLength(path))}:`);
      contextHash.update(path);
      contextHash.update(`${String(bytes.length)}:`);
      contextHash.update(bytes);
    }
    return {
      contextSha256: contextHash.digest("hex"),
      dockerfileSha256: digestFile(
        join(repositoryRoot, "deploy/plugin-authoring-judge/Dockerfile")
      ),
      lockfileSha256: digestFile(join(repositoryRoot, "pnpm-lock.yaml"))
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function digestFile(path) {
  return createHash("sha256")
    .update(readBoundedRegularFile(path, 16 * 1024 * 1024))
    .digest("hex");
}

function readBoundedRegularFile(path, maximumBytes) {
  const metadata = lstatSync(path);
  assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1);
  assert(metadata.size >= 1 && metadata.size <= maximumBytes);
  const bytes = readFileSync(path);
  assert(bytes.length === metadata.size);
  return bytes;
}

function assertSafeDirectory(path) {
  const metadata = lstatSync(path);
  assert(metadata.isDirectory() && !metadata.isSymbolicLink());
}
