import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  loadPluginAuthoringSecurityCases,
  parsePluginAuthoringSecurityCases
} from "./plugin-authoring-security-cases.mjs";
import { parsePluginAuthoringCorpus } from "./plugin-authoring-eval.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const corpus = parsePluginAuthoringCorpus(
  JSON.parse(readFileSync(join(repoRoot, "evals", "plugin-authoring", "corpus.json"), "utf8"))
);

test("loads one closed judge-owned adversarial case for every task", () => {
  const matrix = loadPluginAuthoringSecurityCases(repoRoot, corpus);
  assert.equal(matrix.schemaVersion, 1);
  assert.deepEqual(
    matrix.tasks.map((entry) => entry.taskId),
    corpus.tasks.map((task) => task.id)
  );
  for (const [index, entry] of matrix.tasks.entries()) {
    assert.equal(entry.cases.length, 1);
    assert.equal(entry.cases[0].hookName, corpus.tasks[index].hook.name);
    assert.equal(Object.hasOwn(entry.cases[0].payload, "__proto__"), true);
    assert.equal(Object.hasOwn(entry.cases[0].payload, "constructor"), true);
    assert.equal(Object.hasOwn(entry.cases[0].payload, "prototype"), true);
  }
});

test("rejects omission, widening, unsafe values, undeclared capabilities, and corpus drift", async (t) => {
  const valid = loadPluginAuthoringSecurityCases(repoRoot, corpus);
  const mutations = {
    "missing task": (value) => value.tasks.pop(),
    "unknown task key": (value) => (value.tasks[0].extra = true),
    "duplicate case": (value) =>
      value.tasks[0].cases.push(structuredClone(value.tasks[0].cases[0])),
    "unknown case key": (value) => (value.tasks[0].cases[0].extra = true),
    "hook drift": (value) => (value.tasks[0].cases[0].hookName = "other.hook"),
    "unsafe value": (value) =>
      (value.tasks[0].cases[0].payload.marker = "ghp_12345678901234567890"),
    "non-finite value": (value) => (value.tasks[0].cases[0].payload.value = Number.NaN),
    "undeclared capability": (value) =>
      value.tasks[0].cases[0].capabilityPlan.push({
        name: "slack.send",
        input: {},
        outcome: { status: "resolve", value: {} }
      })
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, () => {
      const value = structuredClone(valid);
      mutate(value);
      assert.throws(() => parsePluginAuthoringSecurityCases(value, corpus), {
        message: "plugin authoring security cases are invalid"
      });
    });
  }
});

test("publishes a closed bounded security case schema", () => {
  const schema = JSON.parse(
    readFileSync(join(repoRoot, "evals", "plugin-authoring", "security-cases.schema.json"), "utf8")
  );
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.tasks.minItems, corpus.tasks.length);
  assert.equal(schema.properties.tasks.maxItems, corpus.tasks.length);
  assert.equal(schema.$defs.task.additionalProperties, false);
  assert.equal(schema.$defs.case.additionalProperties, false);
  assert.equal(schema.$defs.capabilityStep.additionalProperties, false);
});
