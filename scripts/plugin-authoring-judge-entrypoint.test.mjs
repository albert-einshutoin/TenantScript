import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  PLUGIN_AUTHORING_JUDGE_ARGV,
  PLUGIN_AUTHORING_JUDGE_ENTRYPOINT,
  PLUGIN_AUTHORING_JUDGE_PATHS
} from "./plugin-authoring-judge-contract.mjs";
import { createPluginAuthoringBuildAdapter } from "./plugin-authoring-build-adapter.mjs";
import {
  executePluginAuthoringJudge,
  parsePluginAuthoringJudgeArgs,
  runPluginAuthoringJudgeCli
} from "./plugin-authoring-judge-entrypoint.mjs";
import {
  PLUGIN_AUTHORING_REQUIRED_JUDGES,
  computePluginAuthoringCorpusDigest,
  parsePluginAuthoringCorpus
} from "./plugin-authoring-eval.mjs";
import {
  buildIsolatedJudgeDockerInvocation,
  inspectIsolatedCandidateBundle,
  parseJudgeOutput
} from "./plugin-authoring-isolated-runner.mjs";
import { MANIFEST_SOURCE_MAX_BYTES } from "./plugin-authoring-manifest-extractor.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const corpus = parsePluginAuthoringCorpus(
  JSON.parse(readFileSync(join(repoRoot, "evals", "plugin-authoring", "corpus.json"), "utf8"))
);

async function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "tenantscript-judge-entrypoint-"));
  const baselineRoot = join(root, "baseline");
  const candidateRoot = join(root, "candidate");
  const workspaceRoot = join(root, "work");
  const requestPath = join(root, "request.json");
  mkdirSync(join(baselineRoot, "evals", "plugin-authoring"), { recursive: true });
  mkdirSync(candidateRoot);
  mkdirSync(workspaceRoot);
  writeFileSync(
    join(baselineRoot, "evals", "plugin-authoring", "corpus.json"),
    `${JSON.stringify(corpus)}\n`
  );
  writeFileSync(requestPath, `${JSON.stringify(validRequest())}\n`);
  for (const task of corpus.tasks) {
    const sourceRoot = join(candidateRoot, task.id, "src");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, "manifest.ts"), manifestSource(task));
    writeFileSync(join(sourceRoot, "index.ts"), "export const candidateMarker = 'original';\n");
    writeFileSync(join(candidateRoot, task.id, "package.json"), "{}\n");
  }

  try {
    return await run({ root, baselineRoot, candidateRoot, workspaceRoot, requestPath });
  } finally {
    makeTreeOwnerWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
}

function makeTreeOwnerWritable(root) {
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink()) return;
  chmodSync(root, metadata.isDirectory() ? 0o700 : 0o600);
  if (!metadata.isDirectory()) return;
  for (const entry of readdirSync(root)) {
    makeTreeOwnerWritable(join(root, entry));
  }
}

function validRequest() {
  return {
    schemaVersion: 1,
    repositoryRevision: corpus.baselineRevision,
    corpusDigest: computePluginAuthoringCorpusDigest(corpus),
    run: { id: "judge-entrypoint-test", agent: "fixture", model: "fixture", costUsd: null },
    sandbox: {
      image: `ghcr.io/tenantscript/plugin-authoring-judge@sha256:${"a".repeat(64)}`,
      timeoutMs: 60_000,
      memoryMb: 512,
      cpuCount: 1,
      pidsLimit: 64,
      tmpfsMb: 64
    }
  };
}

function manifestSource(task) {
  const capabilities = Object.fromEntries(task.capabilities.map((name) => [name, {}]));
  return `import type { TenantScriptManifest } from "@tenantscript/manifest";

export const manifest = ${JSON.stringify({
    name: task.id,
    version: "0.1.0",
    hooks: [
      {
        name: task.hook.name,
        type: task.hook.type,
        timeoutMs: 250,
        schemaVersionRange: "^1.0.0"
      }
    ],
    capabilities,
    configSchema: { properties: {}, required: [] },
    egress: task.egress,
    limits: { cpuMs: 50, timeoutMs: 500 }
  })} satisfies TenantScriptManifest;
`;
}

function acceptingParser(value) {
  return { ok: true, value };
}

function allPassingAdapters(calls = []) {
  return Object.fromEntries(
    ["build", "unit-test", "security-test", "audit"].map((judge) => [
      judge,
      (context) => {
        const { task, taskRoot, taskWorkspace } = context;
        assert.deepEqual(Object.keys(context).sort(), [
          "baselineRoot",
          "task",
          "taskRoot",
          "taskWorkspace"
        ]);
        calls.push(`${task.id}:${judge}`);
        assert.equal(taskWorkspace.endsWith(`/${task.id}`), true);
        assert.equal(taskRoot, join(taskWorkspace, "source"));
        return true;
      }
    ])
  );
}

function snapshotCandidate(root) {
  const snapshot = [];
  const visit = (current, relative = "") => {
    for (const name of readdirSync(current).sort()) {
      const absolute = join(current, name);
      const path = relative === "" ? name : `${relative}/${name}`;
      const metadata = lstatSync(absolute);
      if (metadata.isDirectory()) {
        snapshot.push(`d:${path}`);
        visit(absolute, path);
      } else {
        snapshot.push(`f:${path}:${readFileSync(absolute).toString("hex")}`);
      }
    }
  };
  visit(root);
  return snapshot;
}

test("runs the fixed task and judge order and preserves candidate input", async () => {
  await withFixture(async (paths) => {
    const calls = [];
    const before = snapshotCandidate(paths.candidateRoot);
    const result = await executePluginAuthoringJudge({
      ...paths,
      adapters: allPassingAdapters(calls),
      parseManifest: acceptingParser
    });

    assert.deepEqual(
      result.taskResults.map((task) => task.taskId),
      corpus.tasks.map((task) => task.id)
    );
    assert.deepEqual(
      result.taskResults.map((task) => task.judges.map((judge) => judge.name)),
      corpus.tasks.map(() => PLUGIN_AUTHORING_REQUIRED_JUDGES)
    );
    assert.equal(
      result.taskResults.every((task) => task.judges.every((judge) => judge.status === "pass")),
      true
    );
    assert.deepEqual(
      calls,
      corpus.tasks.flatMap((task) =>
        ["build", "unit-test", "security-test", "audit"].map((judge) => `${task.id}:${judge}`)
      )
    );
    assert.deepEqual(snapshotCandidate(paths.candidateRoot), before);
    assert.deepEqual(
      readdirSync(paths.workspaceRoot).sort(),
      corpus.tasks.map((task) => task.id)
    );
    assert.deepEqual(parseJudgeOutput(JSON.stringify(result), corpus), result.taskResults);
  });
});

test("feeds adapters from inspected bytes when the live candidate changes", async () => {
  await withFixture(async (paths) => {
    let inspectionCalls = 0;
    const firstTask = corpus.tasks[0];
    const liveSourcePath = join(paths.candidateRoot, firstTask.id, "src", "index.ts");
    const marker = ["API", "_TOKEN", "=swapped-after-inspection"].join("");
    const inspectCandidate = (candidateRoot, corpusInput) => {
      inspectionCalls += 1;
      const inspected = inspectIsolatedCandidateBundle(candidateRoot, corpusInput);
      writeFileSync(liveSourcePath, `export const candidateMarker = ${JSON.stringify(marker)};\n`);
      return inspected;
    };
    const adapters = allPassingAdapters();
    adapters.build = ({ task, taskRoot }) => {
      if (task.id === firstTask.id) {
        const source = readFileSync(join(taskRoot, "src", "index.ts"), "utf8");
        assert.equal(source, "export const candidateMarker = 'original';\n");
        assert.equal(source.includes(marker), false);
      }
      return true;
    };

    const result = await executePluginAuthoringJudge({
      ...paths,
      adapters,
      inspectCandidate,
      parseManifest: acceptingParser
    });

    assert.equal(inspectionCalls, 1);
    assert.equal(
      result.taskResults.every((task) => task.judges.every((judge) => judge.status === "pass")),
      true
    );
    assert.equal(JSON.stringify(result).includes(marker), false);
  });
});

test("runs the bounded build adapter against every materialized task snapshot", async () => {
  await withFixture(async (paths) => {
    const adapters = allPassingAdapters();
    adapters.build = createPluginAuthoringBuildAdapter();
    const result = await executePluginAuthoringJudge({
      ...paths,
      adapters,
      parseManifest: acceptingParser
    });
    assert.equal(
      result.taskResults.every(
        (task) => task.judges.find((judge) => judge.name === "build")?.status === "pass"
      ),
      true
    );
  });
});

test("closes missing, false, throwing, and invalid adapters without skipping work", async () => {
  await withFixture(async (paths) => {
    const marker = ["API", "_TOKEN", "=fixture-marker"].join("");
    const calls = [];
    const result = await executePluginAuthoringJudge({
      ...paths,
      adapters: {
        "unit-test": ({ task }) => {
          calls.push(`${task.id}:unit-test`);
          return false;
        },
        "security-test": ({ task }) => {
          calls.push(`${task.id}:security-test`);
          throw new Error(marker);
        },
        audit: ({ task }) => {
          calls.push(`${task.id}:audit`);
          return { passed: true };
        }
      },
      parseManifest: acceptingParser
    });

    for (const task of result.taskResults) {
      assert.deepEqual(
        task.judges.map(({ name, status }) => ({ name, status })),
        [
          { name: "manifest", status: "pass" },
          { name: "build", status: "fail" },
          { name: "unit-test", status: "fail" },
          { name: "security-test", status: "fail" },
          { name: "audit", status: "fail" },
          { name: "least-privilege", status: "pass" }
        ]
      );
    }
    assert.equal(calls.length, corpus.tasks.length * 3);
    assert.equal(JSON.stringify(result).includes(marker), false);
  });
});

test("turns canonical parser rejection into only manifest policy failures", async () => {
  await withFixture(async (paths) => {
    const marker = ["pass", "word", "=fixture-marker"].join("");
    const result = await executePluginAuthoringJudge({
      ...paths,
      adapters: allPassingAdapters(),
      parseManifest: () => ({ ok: false, errors: [{ path: marker, message: marker }] })
    });

    assert.equal(
      result.taskResults.every(
        (task) =>
          task.judges.find((judge) => judge.name === "manifest").status === "fail" &&
          task.judges.find((judge) => judge.name === "least-privilege").status === "fail" &&
          task.judges
            .filter((judge) => !["manifest", "least-privilege"].includes(judge.name))
            .every((judge) => judge.status === "pass")
      ),
      true
    );
    assert.equal(JSON.stringify(result).includes(marker), false);
  });
});

test("rejects unsafe filesystem inputs with one non-reflective error", async (t) => {
  const cases = {
    "missing task": ({ candidateRoot }) =>
      rmSync(join(candidateRoot, corpus.tasks[0].id), { recursive: true }),
    "extra task": ({ candidateRoot }) => mkdirSync(join(candidateRoot, "extra-task")),
    "missing manifest": ({ candidateRoot }) =>
      rmSync(join(candidateRoot, corpus.tasks[0].id, "src", "manifest.ts")),
    "manifest symlink": ({ root, candidateRoot }) => {
      const manifestPath = join(candidateRoot, corpus.tasks[0].id, "src", "manifest.ts");
      const outside = join(root, "outside.ts");
      writeFileSync(outside, manifestSource(corpus.tasks[0]));
      rmSync(manifestPath);
      symlinkSync(outside, manifestPath);
    },
    "unrelated source symlink": ({ root, candidateRoot }) => {
      const outside = join(root, "outside.ts");
      const sourcePath = join(candidateRoot, corpus.tasks[0].id, "src", "index.ts");
      writeFileSync(outside, "export const marker = true;\n");
      rmSync(sourcePath);
      symlinkSync(outside, sourcePath);
    },
    "manifest directory": ({ candidateRoot }) => {
      const manifestPath = join(candidateRoot, corpus.tasks[0].id, "src", "manifest.ts");
      rmSync(manifestPath);
      mkdirSync(manifestPath);
    },
    "oversized manifest": ({ candidateRoot }) =>
      writeFileSync(
        join(candidateRoot, corpus.tasks[0].id, "src", "manifest.ts"),
        "x".repeat(MANIFEST_SOURCE_MAX_BYTES + 1)
      ),
    "dirty workspace": ({ workspaceRoot }) => writeFileSync(join(workspaceRoot, "marker"), "x"),
    "request corpus drift": ({ requestPath }) => {
      const request = validRequest();
      request.corpusDigest = "b".repeat(64);
      writeFileSync(requestPath, `${JSON.stringify(request)}\n`);
    }
  };

  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, async () => {
      await withFixture(async (paths) => {
        mutate(paths);
        await assert.rejects(
          executePluginAuthoringJudge({
            ...paths,
            adapters: allPassingAdapters(),
            parseManifest: acceptingParser
          }),
          { message: "plugin authoring judge input is invalid" }
        );
      });
    });
  }
});

test("keeps the CLI and runner on one fixed mount and argv contract", () => {
  assert.deepEqual(
    parsePluginAuthoringJudgeArgs(PLUGIN_AUTHORING_JUDGE_ARGV),
    PLUGIN_AUTHORING_JUDGE_PATHS
  );
  for (const argv of [
    [],
    [...PLUGIN_AUTHORING_JUDGE_ARGV, "--extra=value"],
    [...PLUGIN_AUTHORING_JUDGE_ARGV].reverse(),
    PLUGIN_AUTHORING_JUDGE_ARGV.map((argument) => argument.replace("/candidate", "/other"))
  ]) {
    assert.throws(() => parsePluginAuthoringJudgeArgs(argv), {
      message: "plugin authoring judge arguments are invalid"
    });
  }

  const invocation = buildIsolatedJudgeDockerInvocation({
    request: validRequest(),
    containerName: "tenantscript-agent-eval-0123456789abcdef",
    baselineRoot: "/tmp/baseline",
    candidateRoot: "/tmp/candidate",
    requestPath: "/tmp/request.json"
  });
  const entrypointIndex = invocation.args.indexOf(
    `--entrypoint=${PLUGIN_AUTHORING_JUDGE_ENTRYPOINT}`
  );
  assert.notEqual(entrypointIndex, -1);
  assert.deepEqual(
    invocation.args.slice(-PLUGIN_AUTHORING_JUDGE_ARGV.length),
    PLUGIN_AUTHORING_JUDGE_ARGV
  );
});

test("writes exactly one JSON line on success and one fixed error on failure", async () => {
  const writes = { stdout: "", stderr: "" };
  const stdout = { write: (value) => (writes.stdout += value) };
  const stderr = { write: (value) => (writes.stderr += value) };
  const expected = { schemaVersion: 1, taskResults: [] };
  const success = await runPluginAuthoringJudgeCli({
    argv: PLUGIN_AUTHORING_JUDGE_ARGV,
    stdout,
    stderr,
    loadParseManifest: async () => acceptingParser,
    execute: async ({ adapters }) => {
      assert.equal(typeof adapters.build, "function");
      assert.equal(adapters["unit-test"], undefined);
      assert.equal(adapters["security-test"], undefined);
      assert.equal(adapters.audit, undefined);
      return expected;
    }
  });
  assert.equal(success, 0);
  assert.equal(writes.stdout, `${JSON.stringify(expected)}\n`);
  assert.equal(writes.stderr, "");

  writes.stdout = "";
  const marker = ["ghp_", "A".repeat(24)].join("");
  const failure = await runPluginAuthoringJudgeCli({
    argv: PLUGIN_AUTHORING_JUDGE_ARGV,
    stdout,
    stderr,
    loadParseManifest: async () => acceptingParser,
    execute: async () => {
      throw new Error(marker);
    }
  });
  assert.equal(failure, 1);
  assert.equal(writes.stdout, "");
  assert.equal(writes.stderr, "plugin authoring judge failed\n");
  assert.equal(writes.stderr.includes(marker), false);
});

test("documents the bounded build adapter and the three unavailable execution adapters", () => {
  const guide = readFileSync(
    join(repoRoot, "docs", "reference", "plugin-authoring-isolated-runner.md"),
    "utf8"
  );
  for (const required of [
    "plugin-authoring-judge-entrypoint.mjs",
    "container内でも再検証",
    "bounded offline compile-check",
    "3 execution adapter",
    "package.json",
    "32 MiB",
    "fail closed"
  ]) {
    assert.ok(guide.includes(required), `entrypoint guide must include ${required}`);
  }
  assert.doesNotMatch(guide, /(?:\/Users\/|\/Volumes\/|ghp_|sk-proj-)/u);
});
