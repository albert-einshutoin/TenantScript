import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  loadPluginAuthoringBehaviorCases,
  parsePluginAuthoringBehaviorCases
} from "./plugin-authoring-behavior-cases.mjs";
import { parsePluginAuthoringCorpus } from "./plugin-authoring-eval.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const corpus = parsePluginAuthoringCorpus(
  JSON.parse(readFileSync(join(repoRoot, "evals", "plugin-authoring", "corpus.json"), "utf8"))
);

test("loads a closed judge-owned behavior matrix for every corpus task", () => {
  const matrix = loadPluginAuthoringBehaviorCases(repoRoot, corpus);
  assert.equal(matrix.schemaVersion, 1);
  assert.deepEqual(
    matrix.tasks.map((task) => task.taskId),
    corpus.tasks.map((task) => task.id)
  );
  assert.equal(
    matrix.tasks.every((task) => task.cases.length >= 3),
    true
  );
  assert.equal(
    matrix.tasks.every((task, index) =>
      task.cases.every((behaviorCase) => behaviorCase.hookName === corpus.tasks[index].hook.name)
    ),
    true
  );
  assert.equal(
    new Set(
      matrix.tasks.flatMap((task) => task.cases.map((entry) => `${task.taskId}:${entry.name}`))
    ).size,
    matrix.tasks.reduce((total, task) => total + task.cases.length, 0)
  );
  const fractionalRefund = matrix.tasks
    .find((task) => task.taskId === "approval-refund-review")
    ?.cases.find((behaviorCase) => behaviorCase.name === "fractional-age");
  assert.equal(fractionalRefund?.payload.purchaseAgeDays, 29.5);
  assert.deepEqual(fractionalRefund?.expected.result, {
    ok: true,
    value: { decision: "deny", reason: "approval_required" }
  });
});

test("rejects case omission, duplication, widening, unsafe values, and corpus drift", async (t) => {
  const valid = loadPluginAuthoringBehaviorCases(repoRoot, corpus);
  const marker = ["API", "_TOKEN", "=behavior-marker"].join("");
  const cases = {
    "missing task": (value) => value.tasks.pop(),
    "duplicate task": (value) => value.tasks.push(structuredClone(value.tasks[0])),
    "unknown task key": (value) => (value.tasks[0].extra = true),
    "duplicate case": (value) =>
      value.tasks[0].cases.push(structuredClone(value.tasks[0].cases[0])),
    "hook drift": (value) => (value.tasks[0].cases[0].hookName = "other.hook"),
    "unknown case key": (value) => (value.tasks[0].cases[0].extra = true),
    "unsafe string": (value) => (value.tasks[0].cases[0].payload = { marker }),
    "non-finite value": (value) => (value.tasks[0].cases[0].payload = { value: Number.NaN }),
    "prototype value": (value) =>
      (value.tasks[0].cases[0].payload = Object.assign(Object.create({ inherited: true }), {
        value: true
      })),
    "extra capability": (value) =>
      value.tasks[0].cases[0].capabilityPlan.push({
        name: "slack.send",
        input: {},
        outcome: { status: "resolve", value: {} }
      })
  };
  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, () => {
      const value = structuredClone(valid);
      mutate(value);
      assert.throws(() => parsePluginAuthoringBehaviorCases(value, corpus), {
        message: "plugin authoring behavior cases are invalid"
      });
    });
  }
});

test("returns a detached frozen matrix that cannot mutate caller or corpus state", () => {
  const input = JSON.parse(
    readFileSync(join(repoRoot, "evals", "plugin-authoring", "behavior-cases.json"), "utf8")
  );
  const before = structuredClone(input);
  const parsed = parsePluginAuthoringBehaviorCases(input, corpus);
  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.tasks[0].cases[0].payload), true);
  assert.throws(() => {
    parsed.tasks[0].cases[0].payload.injected = true;
  }, TypeError);
});

test("publishes a closed bounded JSON schema for behavior cases", () => {
  const schema = JSON.parse(
    readFileSync(join(repoRoot, "evals", "plugin-authoring", "behavior-cases.schema.json"), "utf8")
  );
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.tasks.maxItems, corpus.tasks.length);
  assert.equal(schema.properties.tasks.minItems, corpus.tasks.length);
  assert.equal(schema.$defs.task.additionalProperties, false);
  assert.equal(schema.$defs.case.additionalProperties, false);
  assert.equal(schema.$defs.capabilityStep.additionalProperties, false);
  assert.equal(schema.$defs.jsonValue.maxDepth, undefined);
});
