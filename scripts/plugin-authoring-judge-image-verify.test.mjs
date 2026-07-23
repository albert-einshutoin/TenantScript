import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { createPluginAuthoringJudgeImagePublicationReceipt } from "./plugin-authoring-judge-image-publish.mjs";
import { verifyPluginAuthoringJudgeImagePublication } from "./plugin-authoring-judge-image-verify.mjs";

const repository = "albert-einshutoin/TenantScript";
const signerWorkflow = `${repository}/.github/workflows/publish-judge-image.yml`;
const imageName = "ghcr.io/albert-einshutoin/tenantscript-plugin-authoring-judge";
const sourceRevision = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const imageReference = `${imageName}@${imageDigest}`;

function receiptFixture() {
  return createPluginAuthoringJudgeImagePublicationReceipt({
    sourceRevision,
    workflowRunId: "123456789",
    imageDigest,
    attestationId: "987654321",
    attestationUrl: `https://github.com/${repository}/attestations/987654321`
  });
}

function attestationOutput(digest = imageDigest.slice("sha256:".length)) {
  return JSON.stringify([
    {
      verificationResult: {
        statement: {
          subject: [{ name: imageName, digest: { sha256: digest } }]
        }
      }
    }
  ]);
}

function successfulHarness(overrides = {}) {
  const calls = [];
  let cleaned = 0;
  const responses = [
    { status: 0, stdout: "pulled\n", stderr: "" },
    { status: 0, stdout: JSON.stringify([imageReference]), stderr: "" },
    { status: 0, stdout: attestationOutput(), stderr: "" }
  ];
  return {
    calls,
    cleanupCount: () => cleaned,
    options: {
      createCredentialDirectories: () => ({
        dockerConfig: "/tmp/verify/docker",
        ghConfig: "/tmp/verify/gh",
        cleanup: () => {
          cleaned += 1;
        }
      }),
      runCommand: (command, args, options) => {
        calls.push({ command, args, options });
        const response = responses[calls.length - 1];
        return overrides[calls.length - 1]?.({ command, args, options, response }) ?? response;
      }
    }
  };
}

test("verifies unauthenticated pull, exact RepoDigest, and source-bound provenance in fixed order", () => {
  const harness = successfulHarness();
  const result = verifyPluginAuthoringJudgeImagePublication(receiptFixture(), harness.options);

  assert.deepEqual(result, {
    schemaVersion: 1,
    kind: "plugin-authoring-judge-image-publication-verification",
    sourceRevision,
    imageReference,
    attestationUrl: `https://github.com/${repository}/attestations/987654321`,
    decision: {
      status: "verified-publication-candidate",
      blockers: ["independent-review"]
    }
  });
  assert.deepEqual(
    harness.calls.map(({ command, args }) => [command, args]),
    [
      ["docker", ["pull", imageReference]],
      ["docker", ["image", "inspect", imageReference, "--format", "{{json .RepoDigests}}"]],
      [
        "gh",
        [
          "attestation",
          "verify",
          `oci://${imageReference}`,
          "--repo",
          repository,
          "--signer-workflow",
          signerWorkflow,
          "--source-digest",
          sourceRevision,
          "--bundle-from-oci",
          "--deny-self-hosted-runners",
          "--format",
          "json"
        ]
      ]
    ]
  );
  for (const call of harness.calls) {
    assert.equal(call.options.shell, false);
    assert.equal(call.options.env.DOCKER_CONFIG, "/tmp/verify/docker");
    assert.equal(call.options.env.GH_CONFIG_DIR, "/tmp/verify/gh");
    for (const prohibited of ["GH_TOKEN", "GITHUB_TOKEN", "DOCKER_AUTH_CONFIG", "HOME"]) {
      assert.equal(Object.hasOwn(call.options.env, prohibited), false);
    }
    assert.ok(call.options.timeoutMs >= 1 && call.options.timeoutMs <= 300_000);
    assert.ok(call.options.maxOutputBytes >= 1 && call.options.maxOutputBytes <= 1024 * 1024);
  }
  assert.equal(harness.cleanupCount(), 1);
});

test("fails closed and cleans credentials for every process or observation failure", () => {
  const cases = [
    [0, () => ({ status: 1, stdout: "", stderr: "registry detail" })],
    [1, () => ({ status: 0, stdout: "not json", stderr: "" })],
    [
      1,
      () => ({
        status: 0,
        stdout: JSON.stringify([`${imageName}@sha256:${"c".repeat(64)}`]),
        stderr: ""
      })
    ],
    [2, () => ({ status: 1, stdout: "", stderr: "attestation detail" })],
    [2, () => ({ status: 0, stdout: "[]", stderr: "" })],
    [2, () => ({ status: 0, stdout: attestationOutput("c".repeat(64)), stderr: "" })],
    [2, () => ({ status: 0, stdout: "{".repeat(1024 * 1024 + 1), stderr: "" })]
  ];

  for (const [index, response] of cases) {
    const harness = successfulHarness({ [index]: response });
    assert.throws(
      () => verifyPluginAuthoringJudgeImagePublication(receiptFixture(), harness.options),
      /judge image publication verification failed/u
    );
    assert.equal(harness.calls.length, index + 1);
    assert.equal(harness.cleanupCount(), 1);
  }
});

test("rejects widened publication receipts before invoking external tools", () => {
  const receipt = receiptFixture();
  receipt.decision.blockers = [];
  const harness = successfulHarness();

  assert.throws(
    () => verifyPluginAuthoringJudgeImagePublication(receipt, harness.options),
    /judge image publication verification failed/u
  );
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.cleanupCount(), 0);
});

test("fails closed when temporary credential cleanup cannot be confirmed", () => {
  const harness = successfulHarness();
  harness.options.createCredentialDirectories = () => ({
    dockerConfig: "/tmp/verify/docker",
    ghConfig: "/tmp/verify/gh",
    cleanup: () => {
      throw new Error("cleanup detail");
    }
  });

  assert.throws(
    () => verifyPluginAuthoringJudgeImagePublication(receiptFixture(), harness.options),
    /judge image publication verification failed/u
  );
});

test("CLI has a closed invocation and repository wiring contract", () => {
  const cli = spawnSync(
    process.execPath,
    [new URL("./plugin-authoring-judge-image-verify.mjs", import.meta.url).pathname],
    { encoding: "utf8" }
  );
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, "");
  assert.equal(cli.stderr, "Judge image publication verification failed.\n");

  const tier1 = readFileSync(new URL("../.github/workflows/tier1.yml", import.meta.url), "utf8");
  const guide = readFileSync(
    new URL("../docs/operations/plugin-authoring-judge-image-publication.md", import.meta.url),
    "utf8"
  );
  assert.match(tier1, /node --test scripts\/plugin-authoring-judge-image-verify\.test\.mjs/u);
  assert.match(guide, /plugin-authoring-judge-image-verify\.mjs/u);
  assert.match(guide, /未認証/u);
  assert.match(guide, /independent-review/u);
});

test("CLI completes with fake tools while stripping ambient credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "tenantscript-judge-verify-cli-"));
  try {
    const binRoot = join(root, "bin");
    const receiptPath = join(root, "receipt.json");
    const callLog = join(root, "calls.jsonl");
    mkdirSync(binRoot);
    writeFileSync(receiptPath, `${JSON.stringify(receiptFixture())}\n`);
    const fakeTool = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "DOCKER_AUTH_CONFIG", "HOME"]) {
  if (Object.hasOwn(process.env, key)) process.exit(9);
}
if (!process.env.DOCKER_CONFIG || !process.env.GH_CONFIG_DIR) process.exit(8);
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ command, args }) + "\\n");
if (command === "docker" && args[0] === "pull") process.exit(0);
if (command === "docker" && args[0] === "image") {
  process.stdout.write(${JSON.stringify(JSON.stringify([imageReference]))});
  process.exit(0);
}
if (command === "gh") {
  process.stdout.write(${JSON.stringify(attestationOutput())});
  process.exit(0);
}
process.exit(7);
`;
    for (const command of ["docker", "gh"]) {
      const path = join(binRoot, command);
      writeFileSync(path, fakeTool);
      chmodSync(path, 0o755);
    }

    const cli = spawnSync(
      process.execPath,
      [new URL("./plugin-authoring-judge-image-verify.mjs", import.meta.url).pathname, receiptPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binRoot}${delimiter}${process.env.PATH ?? ""}`,
          HOME: "/sensitive/home",
          GH_TOKEN: "sensitive-gh-token",
          GITHUB_TOKEN: "sensitive-github-token",
          DOCKER_AUTH_CONFIG: "sensitive-docker-auth"
        }
      }
    );

    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stderr, "");
    assert.deepEqual(JSON.parse(cli.stdout), {
      schemaVersion: 1,
      kind: "plugin-authoring-judge-image-publication-verification",
      sourceRevision,
      imageReference,
      attestationUrl: `https://github.com/${repository}/attestations/987654321`,
      decision: {
        status: "verified-publication-candidate",
        blockers: ["independent-review"]
      }
    });
    const calls = readFileSync(callLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      calls.map(({ command, args }) => [command, args[0]]),
      [
        ["docker", "pull"],
        ["docker", "image"],
        ["gh", "attestation"]
      ]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
