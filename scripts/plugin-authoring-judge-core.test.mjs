import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  PLUGIN_AUTHORING_FAILURE_BY_JUDGE,
  PLUGIN_AUTHORING_REQUIRED_JUDGES
} from "./plugin-authoring-eval.mjs";
import { runPluginAuthoringJudgeCore } from "./plugin-authoring-judge-core.mjs";
import { parseJudgeOutput } from "./plugin-authoring-isolated-runner.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(
  await readFile(join(repoRoot, "evals", "plugin-authoring", "corpus.json"), "utf8")
);

test("judge core emits the fixed task and judge order without extra output fields", async () => {
  const calls = [];
  const output = await runPluginAuthoringJudgeCore({
    corpus,
    runJudge: async ({ task, judge }) => {
      calls.push(`${task.id}:${judge}`);
      return true;
    },
    now: steppedClock(5)
  });

  assert.deepEqual(
    calls,
    corpus.tasks.flatMap((task) =>
      PLUGIN_AUTHORING_REQUIRED_JUDGES.map((judge) => `${task.id}:${judge}`)
    )
  );
  assert.deepEqual(Object.keys(output), ["schemaVersion", "taskResults"]);
  assert.equal(output.schemaVersion, 1);
  assert.deepEqual(
    output.taskResults.map((entry) => entry.taskId),
    corpus.tasks.map((task) => task.id)
  );
  for (const taskResult of output.taskResults) {
    assert.deepEqual(
      taskResult.judges.map((entry) => entry.name),
      PLUGIN_AUTHORING_REQUIRED_JUDGES
    );
    for (const judge of taskResult.judges) {
      assert.deepEqual(Object.keys(judge), ["name", "status", "durationMs", "failureCode"]);
      assert.deepEqual(judge, {
        name: judge.name,
        status: "pass",
        durationMs: 5,
        failureCode: null
      });
    }
  }
  assert.deepEqual(parseJudgeOutput(JSON.stringify(output), corpus), output.taskResults);
});

test("false, invalid results, and exceptions fail closed without reflecting adapter data", async () => {
  const secret = "candidate-secret-must-not-appear";
  const outcomes = new Map([
    ["manifest", false],
    ["build", { passed: true }],
    ["unit-test", undefined],
    ["security-test", "pass"],
    ["audit", 1]
  ]);
  const output = await runPluginAuthoringJudgeCore({
    corpus,
    runJudge: async ({ judge }) => {
      if (judge === "least-privilege") throw new Error(secret);
      return outcomes.get(judge);
    },
    now: steppedClock(1)
  });

  for (const taskResult of output.taskResults) {
    assert.deepEqual(
      taskResult.judges.map((entry) => ({
        name: entry.name,
        status: entry.status,
        failureCode: entry.failureCode
      })),
      PLUGIN_AUTHORING_REQUIRED_JUDGES.map((name) => ({
        name,
        status: "fail",
        failureCode: PLUGIN_AUTHORING_FAILURE_BY_JUDGE[name]
      }))
    );
  }
  assert.equal(JSON.stringify(output).includes(secret), false);
});

test("a failed judge does not skip later judges or later tasks", async () => {
  const calls = [];
  const output = await runPluginAuthoringJudgeCore({
    corpus,
    runJudge: async ({ task, judge }) => {
      calls.push(`${task.id}:${judge}`);
      if (task.id === corpus.tasks[0].id && judge === "manifest") {
        throw new Error("first judge failed");
      }
      return true;
    },
    now: steppedClock(0)
  });

  assert.equal(calls.length, corpus.tasks.length * PLUGIN_AUTHORING_REQUIRED_JUDGES.length);
  assert.equal(output.taskResults[0].judges[0].status, "fail");
  assert.ok(output.taskResults.slice(1).every((task) => task.judges.every(isPassingJudge)));
});

test("duration is clamped to the public schema boundary", async () => {
  const readings = [100, 99, 0, Number.POSITIVE_INFINITY];
  let fallback = 7_200_001;
  const output = await runPluginAuthoringJudgeCore({
    corpus,
    runJudge: async () => true,
    now: () => readings.shift() ?? (fallback += 7_200_001)
  });

  assert.equal(output.taskResults[0].judges[0].durationMs, 0);
  assert.equal(output.taskResults[0].judges[1].durationMs, 0);
  assert.ok(
    output.taskResults
      .flatMap((task) => task.judges)
      .every(
        (judge) =>
          Number.isInteger(judge.durationMs) &&
          judge.durationMs >= 0 &&
          judge.durationMs <= 3_600_000
      )
  );
  assert.ok(
    output.taskResults
      .flatMap((task) => task.judges)
      .some((judge) => judge.durationMs === 3_600_000)
  );
});

test("judge core rejects corpus task drift without reflecting task metadata", async () => {
  const driftedCorpus = structuredClone(corpus);
  driftedCorpus.tasks[0].id = "approval-invoice-threshold-secret";

  await assert.rejects(
    runPluginAuthoringJudgeCore({
      corpus: driftedCorpus,
      runJudge: async () => true
    }),
    new Error("plugin authoring judge core configuration is invalid")
  );
});

function steppedClock(step) {
  let value = 0;
  return () => {
    const current = value;
    value += step;
    return current;
  };
}

function isPassingJudge(judge) {
  return judge.status === "pass" && judge.failureCode === null;
}
