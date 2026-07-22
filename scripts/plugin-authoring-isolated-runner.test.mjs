import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";

import {
  buildIsolatedJudgeDockerInvocation,
  createGitWorkspaceAdapter,
  executeIsolatedJudgeRun,
  inspectIsolatedCandidateBundle,
  parseIsolatedRunnerRequest
} from "./plugin-authoring-isolated-runner.mjs";
import {
  computePluginAuthoringCorpusDigest,
  parsePluginAuthoringCorpus,
  parsePluginAuthoringResult
} from "./plugin-authoring-eval.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const runnerPath = join(repoRoot, "scripts", "plugin-authoring-isolated-runner.mjs");
const corpus = parsePluginAuthoringCorpus(
  JSON.parse(readFileSync(join(repoRoot, "evals", "plugin-authoring", "corpus.json"), "utf8"))
);

function requestFixture() {
  return {
    schemaVersion: 1,
    repositoryRevision: corpus.baselineRevision,
    corpusDigest: computePluginAuthoringCorpusDigest(corpus),
    run: {
      id: "isolated-agent-001",
      agent: "fixture-agent",
      model: "fixture-model-v1",
      costUsd: null
    },
    sandbox: {
      image: "ghcr.io/albert-einshutoin/tenantscript-plugin-judge@sha256:" + "a".repeat(64),
      timeoutMs: 300_000,
      memoryMb: 512,
      cpuCount: 1,
      pidsLimit: 64,
      tmpfsMb: 64
    }
  };
}

async function withCandidateBundle(run) {
  const root = mkdtempSync(join(tmpdir(), "tenantscript-isolated-candidate-"));
  try {
    for (const task of corpus.tasks) {
      const taskRoot = join(root, task.id, "src");
      mkdirSync(taskRoot, { recursive: true });
      writeFileSync(join(taskRoot, "index.ts"), `export const task = "${task.id}";\n`);
    }
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function passingTaskResults() {
  return corpus.tasks.map((task) => ({
    taskId: task.id,
    judges: corpus.requiredJudges.map((name) => ({
      name,
      status: "pass",
      durationMs: 10,
      failureCode: null
    }))
  }));
}

test("accepts a closed pinned runner request and rejects mutable or drifted inputs", () => {
  assert.deepEqual(parseIsolatedRunnerRequest(requestFixture(), corpus), requestFixture());

  const cases = [];
  const mutableImage = structuredClone(requestFixture());
  mutableImage.sandbox.image = "ghcr.io/example/judge:latest";
  cases.push(mutableImage);

  const driftedRevision = structuredClone(requestFixture());
  driftedRevision.repositoryRevision = "b".repeat(40);
  cases.push(driftedRevision);

  const driftedCorpus = structuredClone(requestFixture());
  driftedCorpus.corpusDigest = "b".repeat(64);
  cases.push(driftedCorpus);

  const widened = structuredClone(requestFixture());
  widened.sandbox.extraArgument = "--privileged";
  cases.push(widened);

  const credentialId = structuredClone(requestFixture());
  credentialId.run.id = `sk-${"c".repeat(24)}`;
  cases.push(credentialId);

  for (const input of cases) {
    assert.throws(
      () => parseIsolatedRunnerRequest(input, corpus),
      /isolated runner request is invalid/
    );
  }
});

test("accepts exactly one bounded regular-file candidate tree per corpus task", async () => {
  await withCandidateBundle((root) => {
    const inspected = inspectIsolatedCandidateBundle(root, corpus);
    assert.equal(inspected.tasks, corpus.tasks.length);
    assert.equal(inspected.files, corpus.tasks.length);
    assert.match(inspected.digest, /^[0-9a-f]{64}$/);
    assert.ok(inspected.totalBytes > 0);
  });
});

test("builds a fixed least-authority Docker invocation", () => {
  const invocation = buildIsolatedJudgeDockerInvocation({
    request: parseIsolatedRunnerRequest(requestFixture(), corpus),
    containerName: "tenantscript-agent-eval-0123456789abcdef",
    baselineRoot: "/tmp/baseline",
    candidateRoot: "/tmp/candidate",
    requestPath: "/tmp/request.json"
  });

  assert.equal(invocation.command, "docker");
  for (const required of [
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--pids-limit=64",
    "--memory=512m",
    "--memory-swap=512m",
    "--cpus=1",
    "--user=65532:65532",
    "--ipc=none",
    "--init",
    "--tmpfs=/work:rw,nosuid,nodev,size=64m",
    "--workdir=/work",
    "--entrypoint=/opt/tenantscript/bin/plugin-authoring-judge"
  ]) {
    assert.ok(invocation.args.includes(required), `missing ${required}`);
  }
  assert.ok(invocation.args.includes(requestFixture().sandbox.image));
  assert.ok(
    invocation.args.includes("--mount=type=bind,src=/tmp/candidate,dst=/candidate,readonly")
  );
  assert.ok(invocation.args.includes("--workspace=/work"));
  assert.equal(
    invocation.args.some((argument) => argument.includes("docker.sock")),
    false
  );
  assert.deepEqual(invocation.environmentKeys, ["PATH"]);
});

test("wraps closed judge output in digest-bound isolated evidence and always cleans up", async () => {
  await withCandidateBundle(async (candidateRoot) => {
    const tempRoot = mkdtempSync(join(tmpdir(), "tenantscript-isolated-run-"));
    const calls = [];
    const backend = {
      probe: async (image) => calls.push(["probe", image]),
      run: async (invocation) => {
        calls.push(["run", invocation.containerName]);
        return JSON.stringify({ schemaVersion: 1, taskResults: passingTaskResults() });
      },
      remove: async (containerName) => {
        calls.push(["remove", containerName]);
        return true;
      }
    };
    const workspace = {
      prepare: ({ destination, revision }) => {
        calls.push(["prepare", revision]);
        mkdirSync(destination, { recursive: true });
        writeFileSync(join(destination, "BASELINE"), `${revision}\n`);
      }
    };
    const times = [new Date("2026-07-22T00:00:00.000Z"), new Date("2026-07-22T00:01:00.000Z")];

    const output = await executeIsolatedJudgeRun({
      repositoryRoot: repoRoot,
      candidateRoot,
      request: requestFixture(),
      corpus,
      backend,
      workspace,
      temporaryRootFactory: () => tempRoot,
      now: () => times.shift()
    });

    assert.equal(output.status, "success");
    assert.equal(output.summary, "10 of 10 plugin authoring tasks passed all deterministic judges");
    assert.deepEqual(output.nextActions, []);
    assert.deepEqual(output.artifacts, ["evidence.json", "result.json"]);
    assert.equal(output.result.run.provenance, "isolated-agent-run");
    assert.equal(output.result.run.evidenceBundleDigest, output.evidence.digest);
    assert.equal(output.evidence.sandbox.network, "none");
    assert.equal(output.evidence.sandbox.workspace, "bounded-tmpfs");
    assert.equal(output.evidence.sandbox.cleanup, "confirmed");
    assert.doesNotThrow(() => parsePluginAuthoringResult(output.result, corpus));
    assert.deepEqual(
      calls.map(([name]) => name),
      ["prepare", "probe", "run", "remove"]
    );
    assert.equal(existsSync(tempRoot), false);
  });
});

test("keeps the read-only request mount readable by the unprivileged judge under a restrictive umask", async () => {
  await withCandidateBundle(async (candidateRoot) => {
    const previousUmask = process.umask(0o077);
    try {
      const backend = {
        probe: async () => {},
        run: async (invocation) => {
          const requestMount = invocation.args.find((argument) =>
            argument.endsWith(",dst=/input/request.json,readonly")
          );
          assert.ok(requestMount);
          const requestPath = requestMount.slice("--mount=type=bind,src=".length).split(",dst=")[0];
          assert.equal(statSync(requestPath).mode & 0o444, 0o444);
          return JSON.stringify({ schemaVersion: 1, taskResults: passingTaskResults() });
        },
        remove: async () => true
      };
      const workspace = {
        prepare: ({ destination }) => mkdirSync(destination, { recursive: true })
      };
      const times = [new Date("2026-07-22T00:00:00.000Z"), new Date("2026-07-22T00:00:01.000Z")];

      const output = await executeIsolatedJudgeRun({
        repositoryRoot: repoRoot,
        candidateRoot,
        request: requestFixture(),
        corpus,
        backend,
        workspace,
        now: () => times.shift()
      });

      assert.equal(output.status, "success");
    } finally {
      process.umask(previousUmask);
    }
  });
});

test("returns actionable warning metrics for a deterministic judge failure", async () => {
  await withCandidateBundle(async (candidateRoot) => {
    const taskResults = passingTaskResults();
    taskResults[0].judges[3] = {
      name: "security-test",
      status: "fail",
      durationMs: 15,
      failureCode: "security-test-failed"
    };
    const backend = {
      probe: async () => {},
      run: async () => JSON.stringify({ schemaVersion: 1, taskResults }),
      remove: async () => true
    };
    const workspace = {
      prepare: ({ destination }) => mkdirSync(destination, { recursive: true })
    };
    const times = [new Date("2026-07-22T00:00:00.000Z"), new Date("2026-07-22T00:00:01.000Z")];
    const output = await executeIsolatedJudgeRun({
      repositoryRoot: repoRoot,
      candidateRoot,
      request: requestFixture(),
      corpus,
      backend,
      workspace,
      now: () => times.shift()
    });

    assert.equal(output.status, "warning");
    assert.deepEqual(output.nextActions, [
      "Inspect security-test-failed evidence and improve generated security tests or guidance."
    ]);
  });
});

test("publishes closed and bounded request, judge output, and evidence schemas", () => {
  const schemaRoot = join(repoRoot, "evals", "plugin-authoring");
  const requestSchema = JSON.parse(
    readFileSync(join(schemaRoot, "runner-request.schema.json"), "utf8")
  );
  const judgeOutputSchema = JSON.parse(
    readFileSync(join(schemaRoot, "judge-output.schema.json"), "utf8")
  );
  const evidenceSchema = JSON.parse(
    readFileSync(join(schemaRoot, "isolated-evidence.schema.json"), "utf8")
  );

  assert.equal(requestSchema.additionalProperties, false);
  assert.equal(requestSchema.properties.run.additionalProperties, false);
  assert.equal(requestSchema.properties.sandbox.additionalProperties, false);
  assert.match(requestSchema.properties.sandbox.properties.image.pattern, /sha256/);
  assert.ok(requestSchema.properties.sandbox.properties.timeoutMs.maximum <= 600_000);
  assert.ok(requestSchema.properties.sandbox.properties.memoryMb.maximum <= 2_048);
  assert.equal(judgeOutputSchema.additionalProperties, false);
  assert.equal(
    judgeOutputSchema.properties.taskResults.$ref,
    "https://tenantscript.dev/schemas/plugin-authoring-eval-result.schema.json#/properties/taskResults"
  );
  assert.equal(evidenceSchema.additionalProperties, false);
  assert.equal(evidenceSchema.properties.candidate.additionalProperties, false);
  assert.equal(evidenceSchema.properties.sandbox.additionalProperties, false);
  assert.equal(evidenceSchema.properties.sandbox.properties.network.const, "none");
  assert.equal(evidenceSchema.properties.sandbox.properties.workspace.const, "bounded-tmpfs");
  assert.equal(evidenceSchema.properties.sandbox.properties.cleanup.const, "confirmed");
  assert.equal(
    evidenceSchema.properties.taskResults.$ref,
    "https://tenantscript.dev/schemas/plugin-authoring-eval-result.schema.json#/properties/taskResults"
  );
});

test("materializes the exact baseline without repository metadata or user-owned files", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "tenantscript-isolated-worktree-"));
  const destination = join(temporaryRoot, "baseline");
  try {
    createGitWorkspaceAdapter().prepare({
      repositoryRoot: repoRoot,
      revision: corpus.baselineRevision,
      destination,
      temporaryRoot
    });

    assert.equal(existsSync(join(destination, ".git")), false);
    assert.equal(existsSync(join(destination, ".devloop", "ledger.jsonl")), false);
    assert.equal(
      JSON.parse(readFileSync(join(destination, "package.json"), "utf8")).name,
      "tenantscript"
    );
    const listed = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8"
    }).stdout;
    assert.equal(listed.includes(temporaryRoot), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("CLI completes the pinned workspace, sandbox, evidence, and result workflow", async () => {
  await withCandidateBundle((candidateRoot) => {
    const root = mkdtempSync(join(tmpdir(), "tenantscript-isolated-cli-"));
    try {
      const binRoot = join(root, "bin");
      const requestPath = join(root, "request.json");
      const outputRoot = join(root, "output");
      const callLog = join(root, "docker-calls.jsonl");
      const dockerPath = join(binRoot, "docker");
      mkdirSync(binRoot);
      writeFileSync(requestPath, `${JSON.stringify(requestFixture())}\n`);
      const judgeOutput = JSON.stringify({ schemaVersion: 1, taskResults: passingTaskResults() });
      writeFileSync(
        dockerPath,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "image" && args[1] === "inspect") {
  process.stdout.write(JSON.stringify([${JSON.stringify(requestFixture().sandbox.image)}]) + "\\n");
  process.exit(0);
}
if (args[0] === "run") {
  process.stdout.write(${JSON.stringify(judgeOutput)});
  process.exit(0);
}
if (args[0] === "rm" && args[1] === "--force") process.exit(0);
process.exit(2);
`
      );
      chmodSync(dockerPath, 0o755);

      const result = spawnSync(
        process.execPath,
        [runnerPath, requestPath, candidateRoot, outputRoot],
        {
          encoding: "utf8",
          env: { PATH: `${binRoot}${delimiter}${process.env.PATH ?? ""}` },
          maxBuffer: 1024 * 1024
        }
      );

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        status: "success",
        summary: "10 of 10 plugin authoring tasks passed all deterministic judges",
        nextActions: [],
        artifacts: ["evidence.json", "result.json"]
      });
      const isolatedResult = JSON.parse(readFileSync(join(outputRoot, "result.json"), "utf8"));
      assert.doesNotThrow(() => parsePluginAuthoringResult(isolatedResult, corpus));
      const evidence = JSON.parse(readFileSync(join(outputRoot, "evidence.json"), "utf8"));
      assert.equal(evidence.digest, isolatedResult.run.evidenceBundleDigest);
      const calls = readFileSync(callLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        calls.map((args) => args[0]),
        ["image", "run", "rm"]
      );
      assert.ok(calls[1].includes("--network=none"));
      assert.ok(calls[1].includes("--read-only"));
      assert.equal(result.stdout.includes(root), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("wires the isolated runner into repository gates and honest public documentation", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const tier1 = readFileSync(join(repoRoot, ".github", "workflows", "tier1.yml"), "utf8");
  const docsIndex = readFileSync(join(repoRoot, "docs", "README.md"), "utf8");
  const llms = readFileSync(join(repoRoot, "llms.txt"), "utf8");
  const phase = readFileSync(join(repoRoot, "tasks", "Phase4.md"), "utf8");
  const guide = readFileSync(
    join(repoRoot, "docs", "reference", "plugin-authoring-isolated-runner.md"),
    "utf8"
  );

  assert.match(packageJson.scripts["test:agent-evals"], /plugin-authoring-isolated-runner\.test/);
  assert.match(
    packageJson.scripts["test:security"],
    /plugin-authoring-isolated-runner-security\.test/
  );
  assert.match(tier1, /pnpm test:agent-evals/);
  assert.match(docsIndex, /plugin-authoring-isolated-runner\.md/);
  assert.match(llms, /plugin-authoring-isolated-runner\.md/);
  assert.match(phase, /Issue #313/);
  for (const required of [
    "--network=none",
    "--pull=never",
    "reviewed judge image",
    "provider communication",
    "does not publish real-agent metrics",
    "repository simulation",
    "evidence.json",
    "result.json"
  ]) {
    assert.ok(guide.includes(required), `isolated runner guide must include ${required}`);
  }
  assert.doesNotMatch(guide, /(?:\/Users\/|\/Volumes\/|ghp_|sk-proj-)/u);
});
