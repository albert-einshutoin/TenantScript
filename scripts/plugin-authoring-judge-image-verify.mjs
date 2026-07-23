#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  readPluginAuthoringJudgeImagePublicationReceipt,
  validatePluginAuthoringJudgeImagePublicationReceipt
} from "./plugin-authoring-judge-image-publish.mjs";

const repository = "albert-einshutoin/TenantScript";
const signerWorkflow = `${repository}/.github/workflows/publish-judge-image.yml`;
const verificationBlockers = Object.freeze(["independent-review"]);
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const maxInspectOutputBytes = 32 * 1024;
const maxAttestationOutputBytes = 1024 * 1024;

export function verifyPluginAuthoringJudgeImagePublication(
  receiptInput,
  {
    createCredentialDirectories = createEmptyCredentialDirectories,
    runCommand = runBoundedCommand
  } = {}
) {
  let credentials;
  let verification;
  let failed = false;
  try {
    assert(typeof createCredentialDirectories === "function");
    assert(typeof runCommand === "function");
    const receipt = validatePluginAuthoringJudgeImagePublicationReceipt(receiptInput, {
      returnReceipt: true
    });
    credentials = createCredentialDirectories();
    validateCredentialDirectories(credentials);
    const environment = createSanitizedEnvironment(credentials);

    runChecked(
      runCommand,
      "docker",
      ["pull", receipt.image.reference],
      environment,
      300_000,
      64 * 1024
    );

    const inspect = runChecked(
      runCommand,
      "docker",
      ["image", "inspect", receipt.image.reference, "--format", "{{json .RepoDigests}}"],
      environment,
      30_000,
      maxInspectOutputBytes
    );
    validateRepoDigests(inspect.stdout, receipt.image.reference);

    const attestation = runChecked(
      runCommand,
      "gh",
      [
        "attestation",
        "verify",
        `oci://${receipt.image.reference}`,
        "--repo",
        repository,
        "--signer-workflow",
        signerWorkflow,
        "--source-digest",
        receipt.source.revision,
        "--bundle-from-oci",
        "--deny-self-hosted-runners",
        "--format",
        "json"
      ],
      environment,
      120_000,
      maxAttestationOutputBytes
    );
    validateAttestationSubjects(attestation.stdout, receipt.image.name, receipt.image.digest);

    verification = {
      schemaVersion: 1,
      kind: "plugin-authoring-judge-image-publication-verification",
      sourceRevision: receipt.source.revision,
      imageReference: receipt.image.reference,
      attestationUrl: receipt.attestation.url,
      decision: {
        status: "verified-publication-candidate",
        blockers: verificationBlockers
      }
    };
  } catch {
    failed = true;
  }
  if (credentials !== undefined) {
    try {
      credentials.cleanup();
    } catch {
      // A verifier must not report success while credential cleanup remains unconfirmed.
      failed = true;
    }
  }
  if (failed || verification === undefined) {
    throw new Error("judge image publication verification failed");
  }
  return verification;
}

function createEmptyCredentialDirectories() {
  const root = mkdtempSync(join(tmpdir(), "tenantscript-judge-image-verify-"));
  try {
    const dockerConfig = join(root, "docker");
    const ghConfig = join(root, "gh");
    mkdirSync(dockerConfig, { mode: 0o700 });
    mkdirSync(ghConfig, { mode: 0o700 });
    return {
      dockerConfig,
      ghConfig,
      cleanup: () => rmSync(root, { recursive: true, force: true })
    };
  } catch (error) {
    // Do not leave a partially created credential root behind when setup fails midway.
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function validateCredentialDirectories(credentials) {
  assertPlainObject(credentials);
  assertExactKeys(credentials, ["cleanup", "dockerConfig", "ghConfig"]);
  assert(typeof credentials.cleanup === "function");
  assertSafePath(credentials.dockerConfig);
  assertSafePath(credentials.ghConfig);
  assert(credentials.dockerConfig !== credentials.ghConfig);
}

function createSanitizedEnvironment(credentials) {
  const path = process.env.PATH;
  assert(typeof path === "string" && path.length >= 1 && path.length <= 32 * 1024);
  return {
    PATH: path,
    LANG: "C",
    LC_ALL: "C",
    DOCKER_CONFIG: credentials.dockerConfig,
    GH_CONFIG_DIR: credentials.ghConfig
  };
}

function runChecked(runCommand, command, args, env, timeoutMs, maxOutputBytes) {
  const result = runCommand(command, args, {
    env,
    maxOutputBytes,
    shell: false,
    timeoutMs
  });
  assertPlainObject(result);
  assert(typeof result.stdout === "string" && typeof result.stderr === "string");
  assert(Buffer.byteLength(result.stdout) <= maxOutputBytes);
  assert(Buffer.byteLength(result.stderr) <= maxOutputBytes);
  assert(result.status === 0);
  return result;
}

function runBoundedCommand(command, args, { env, timeoutMs, maxOutputBytes, shell }) {
  assert(shell === false);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
    maxBuffer: maxOutputBytes,
    shell: false,
    timeout: timeoutMs,
    windowsHide: true
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : ""
  };
}

function validateRepoDigests(output, expectedReference) {
  assert(Buffer.byteLength(output) <= maxInspectOutputBytes);
  const repoDigests = JSON.parse(output);
  assert(Array.isArray(repoDigests) && repoDigests.length >= 1 && repoDigests.length <= 100);
  assert(
    repoDigests.every(
      (reference) =>
        typeof reference === "string" && reference.length >= 1 && reference.length <= 300
    )
  );
  assert(repoDigests.includes(expectedReference));
}

function validateAttestationSubjects(output, imageName, imageDigest) {
  assert(digestPattern.test(imageDigest));
  assert(Buffer.byteLength(output) <= maxAttestationOutputBytes);
  const attestations = JSON.parse(output);
  assert(Array.isArray(attestations) && attestations.length >= 1 && attestations.length <= 30);
  const expectedDigest = imageDigest.slice("sha256:".length);
  assert(
    attestations.some((entry) => {
      const subjects = entry?.verificationResult?.statement?.subject;
      return (
        Array.isArray(subjects) &&
        subjects.length >= 1 &&
        subjects.length <= 100 &&
        subjects.some(
          (subject) => subject?.name === imageName && subject?.digest?.sha256 === expectedDigest
        )
      );
    })
  );
}

function assertSafePath(value) {
  assert(typeof value === "string" && value.length >= 1 && value.length <= 1024);
  assert(value.includes("\0") === false);
}

function assertPlainObject(value) {
  assert(
    typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactKeys(value, expected) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    assert(process.argv.length === 3);
    const receipt = readPluginAuthoringJudgeImagePublicationReceipt(process.argv[2]);
    const result = verifyPluginAuthoringJudgeImagePublication(receipt);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("Judge image publication verification failed.\n");
    process.exitCode = 1;
  }
}
