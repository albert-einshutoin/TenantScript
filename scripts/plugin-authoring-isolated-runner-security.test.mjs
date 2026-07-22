import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  executeIsolatedJudgeRun,
  inspectIsolatedCandidateBundle,
  writeIsolatedRunnerArtifacts
} from "./plugin-authoring-isolated-runner.mjs";
import {
  computePluginAuthoringCorpusDigest,
  parsePluginAuthoringCorpus
} from "./plugin-authoring-eval.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const corpus = parsePluginAuthoringCorpus(
  JSON.parse(readFileSync(join(repoRoot, "evals", "plugin-authoring", "corpus.json"), "utf8"))
);

function requestFixture() {
  return {
    schemaVersion: 1,
    repositoryRevision: corpus.baselineRevision,
    corpusDigest: computePluginAuthoringCorpusDigest(corpus),
    run: {
      id: "isolated-security-001",
      agent: "fixture-agent",
      model: "fixture-model-v1",
      costUsd: null
    },
    sandbox: {
      image: "ghcr.io/example/judge@sha256:" + "d".repeat(64),
      timeoutMs: 30_000,
      memoryMb: 256,
      cpuCount: 0.5,
      pidsLimit: 32,
      tmpfsMb: 32
    }
  };
}

async function withCandidateBundle(run) {
  const root = mkdtempSync(join(tmpdir(), "tenantscript-isolated-security-"));
  try {
    for (const task of corpus.tasks) {
      const taskRoot = join(root, task.id);
      mkdirSync(taskRoot, { recursive: true });
      writeFileSync(join(taskRoot, "index.ts"), "export default {};\n");
    }
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function workspaceFixture() {
  return {
    prepare: ({ destination }) => mkdirSync(destination, { recursive: true })
  };
}

function passingOutput() {
  return JSON.stringify({
    schemaVersion: 1,
    taskResults: corpus.tasks.map((task) => ({
      taskId: task.id,
      judges: corpus.requiredJudges.map((name) => ({
        name,
        status: "pass",
        durationMs: 1,
        failureCode: null
      }))
    }))
  });
}

test("rejects symlinks, hidden controls, missing tasks, and oversized files before execution", async () => {
  await withCandidateBundle((root) => {
    const marker = join(root, corpus.tasks[0].id, "private-marker");
    symlinkSync("/Volumes/private/credential", marker);
    assert.throws(
      () => inspectIsolatedCandidateBundle(root, corpus),
      (error) => {
        assert.equal(error.message, "isolated candidate bundle is invalid");
        assert.doesNotMatch(error.message, /Volumes|private-marker|credential/);
        return true;
      }
    );
    rmSync(marker);

    writeFileSync(join(root, corpus.tasks[0].id, ".npmrc"), "unsafe=true\n");
    assert.throws(
      () => inspectIsolatedCandidateBundle(root, corpus),
      /isolated candidate bundle is invalid/
    );
    rmSync(join(root, corpus.tasks[0].id, ".npmrc"));

    rmSync(join(root, corpus.tasks[1].id), { recursive: true });
    assert.throws(
      () => inspectIsolatedCandidateBundle(root, corpus),
      /isolated candidate bundle is invalid/
    );
  });

  await withCandidateBundle((root) => {
    writeFileSync(join(root, corpus.tasks[0].id, "large.bin"), Buffer.alloc(262_145));
    assert.throws(
      () => inspectIsolatedCandidateBundle(root, corpus),
      /isolated candidate bundle is invalid/
    );
  });
});

test("stops reading candidate bytes when the aggregate bundle cap is reached", async () => {
  await withCandidateBundle((root) => {
    const taskRoot = join(root, corpus.tasks[0].id);
    for (let index = 0; index < 65; index += 1) {
      writeFileSync(
        join(taskRoot, `chunk-${String(index).padStart(3, "0")}.bin`),
        Buffer.alloc(262_144)
      );
    }
    let reads = 0;
    let retainedBytes = 0;

    assert.throws(
      () =>
        inspectIsolatedCandidateBundle(root, corpus, {
          readFile(path) {
            const bytes = readFileSync(path);
            reads += 1;
            retainedBytes += bytes.length;
            assert.ok(retainedBytes <= 16 * 1024 * 1024);
            return bytes;
          }
        }),
      /isolated candidate bundle is invalid/
    );
    assert.ok(reads > 0);
    assert.ok(retainedBytes <= 16 * 1024 * 1024);
  });
});

test("bounds directory fan-out before sorting attacker-controlled entries", async () => {
  await withCandidateBundle((root) => {
    const taskRoot = join(root, corpus.tasks[0].id);
    for (let index = 0; index < 2_001; index += 1) {
      mkdirSync(join(taskRoot, `empty-${String(index).padStart(4, "0")}`));
    }
    assert.throws(
      () => inspectIsolatedCandidateBundle(root, corpus),
      /isolated candidate bundle is invalid/
    );
  });
});

test("does not delete a temporary root before establishing ownership", async () => {
  await withCandidateBundle(async (candidateRoot) => {
    const tempRoot = mkdtempSync(join(tmpdir(), "tenantscript-unowned-root-"));
    const sentinel = join(tempRoot, "operator-owned.txt");
    writeFileSync(sentinel, "preserve me\n");

    try {
      await assert.rejects(
        executeIsolatedJudgeRun({
          repositoryRoot: repoRoot,
          candidateRoot,
          request: requestFixture(),
          corpus,
          workspace: workspaceFixture(),
          temporaryRootFactory: () => tempRoot
        })
      );
      assert.equal(readFileSync(sentinel, "utf8"), "preserve me\n");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

test("stops before unknown execution when the sandbox probe fails", async () => {
  await withCandidateBundle(async (candidateRoot) => {
    const tempRoot = mkdtempSync(join(tmpdir(), "tenantscript-probe-failure-"));
    const calls = [];
    const backend = {
      probe: async () => {
        calls.push("probe");
        throw new Error("daemon output /Volumes/private and secret=marker");
      },
      run: async () => calls.push("run"),
      remove: async () => calls.push("remove")
    };

    await assert.rejects(
      executeIsolatedJudgeRun({
        repositoryRoot: repoRoot,
        candidateRoot,
        request: requestFixture(),
        corpus,
        backend,
        workspace: workspaceFixture(),
        temporaryRootFactory: () => tempRoot
      }),
      (error) => {
        assert.equal(error.message, "isolated judge sandbox is unavailable");
        assert.doesNotMatch(error.message, /Volumes|secret|marker|daemon/);
        return true;
      }
    );
    assert.deepEqual(calls, ["probe"]);
    assert.equal(existsSync(tempRoot), false);
  });
});

test("removes the named container after malformed output without reflecting attacker text", async () => {
  await withCandidateBundle(async (candidateRoot) => {
    const calls = [];
    const backend = {
      probe: async () => {},
      run: async ({ containerName }) => {
        calls.push(["run", containerName]);
        return '{"secret":"ghp_AAAAAAAAAAAAAAAAAAAAAAAA","path":"/Users/private"}';
      },
      remove: async (containerName) => {
        calls.push(["remove", containerName]);
        return true;
      }
    };

    await assert.rejects(
      executeIsolatedJudgeRun({
        repositoryRoot: repoRoot,
        candidateRoot,
        request: requestFixture(),
        corpus,
        backend,
        workspace: workspaceFixture()
      }),
      (error) => {
        assert.equal(error.message, "isolated judge output is invalid");
        assert.doesNotMatch(error.message, /ghp_|Users|private|secret/);
        return true;
      }
    );
    assert.deepEqual(
      calls.map(([name]) => name),
      ["run", "remove"]
    );
    assert.equal(calls[0][1], calls[1][1]);
  });
});

test("fails closed when output is oversized or container cleanup is unconfirmed", async () => {
  await withCandidateBundle(async (candidateRoot) => {
    let removals = 0;
    await assert.rejects(
      executeIsolatedJudgeRun({
        repositoryRoot: repoRoot,
        candidateRoot,
        request: requestFixture(),
        corpus,
        workspace: workspaceFixture(),
        backend: {
          probe: async () => {},
          run: async () => "x".repeat(1_048_577),
          remove: async () => {
            removals += 1;
            return true;
          }
        }
      }),
      /isolated judge output is invalid/
    );
    assert.equal(removals, 1);

    await assert.rejects(
      executeIsolatedJudgeRun({
        repositoryRoot: repoRoot,
        candidateRoot,
        request: requestFixture(),
        corpus,
        workspace: workspaceFixture(),
        backend: {
          probe: async () => {},
          run: async () => passingOutput(),
          remove: async () => false
        }
      }),
      /isolated judge cleanup was not confirmed/
    );
  });
});

test("cleans up after a bounded backend timeout without exposing backend diagnostics", async () => {
  await withCandidateBundle(async (candidateRoot) => {
    let removed = false;
    await assert.rejects(
      executeIsolatedJudgeRun({
        repositoryRoot: repoRoot,
        candidateRoot,
        request: requestFixture(),
        corpus,
        workspace: workspaceFixture(),
        backend: {
          probe: async () => {},
          run: async () => {
            throw new Error("timeout child stderr password=private-marker");
          },
          remove: async () => {
            removed = true;
            return true;
          }
        }
      }),
      (error) => {
        assert.equal(error.message, "isolated judge execution failed");
        assert.doesNotMatch(error.message, /password|private-marker|stderr/);
        return true;
      }
    );
    assert.equal(removed, true);
  });
});

test("reports unconfirmed cleanup before execution failure when both operations fail", async () => {
  await withCandidateBundle(async (candidateRoot) => {
    await assert.rejects(
      executeIsolatedJudgeRun({
        repositoryRoot: repoRoot,
        candidateRoot,
        request: requestFixture(),
        corpus,
        workspace: workspaceFixture(),
        backend: {
          probe: async () => {},
          run: async () => {
            throw new Error("timed out");
          },
          remove: async () => false
        }
      }),
      /isolated judge cleanup was not confirmed/
    );
  });
});

test("will not follow an output-directory symlink or overwrite existing evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "tenantscript-isolated-output-"));
  try {
    const outside = join(root, "outside");
    const output = join(root, "output");
    mkdirSync(outside);
    symlinkSync(outside, output, "dir");
    assert.throws(
      () => writeIsolatedRunnerArtifacts(output, { evidence: {}, result: {} }),
      /isolated runner output path is unsafe/
    );
    assert.deepEqual(readdirSync(outside), []);

    unlinkSync(output);
    mkdirSync(output);
    writeFileSync(join(output, "operator-owned.json"), "preserve\n");
    assert.throws(
      () => writeIsolatedRunnerArtifacts(output, { evidence: {}, result: {} }),
      /isolated runner output path is unsafe/
    );
    assert.equal(readFileSync(join(output, "operator-owned.json"), "utf8"), "preserve\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
