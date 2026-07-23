import assert from "node:assert/strict";
import test from "node:test";

import {
  PLUGIN_AUTHORING_JUDGE_IMAGE_FAILURE_SCENARIOS,
  parsePluginAuthoringJudgeImageFailureScenarios
} from "./plugin-authoring-judge-image-failure-scenarios.mjs";

test("covers the six fixed failure codes with closed ordered vectors", () => {
  assert.equal(PLUGIN_AUTHORING_JUDGE_IMAGE_FAILURE_SCENARIOS.length, 6);
  assert.deepEqual(
    PLUGIN_AUTHORING_JUDGE_IMAGE_FAILURE_SCENARIOS.map(({ id }) => id),
    [
      "manifest-invalid",
      "build-failed",
      "unit-test-failed",
      "security-test-failed",
      "audit-failed",
      "least-privilege-failed"
    ]
  );
  assert.equal(
    PLUGIN_AUTHORING_JUDGE_IMAGE_FAILURE_SCENARIOS.every(({ targetJudge, expectedFailureJudges }) =>
      expectedFailureJudges.includes(targetJudge)
    ),
    true
  );
  assert.equal(Object.isFrozen(PLUGIN_AUTHORING_JUDGE_IMAGE_FAILURE_SCENARIOS), true);
  assert.equal(Object.isFrozen(PLUGIN_AUTHORING_JUDGE_IMAGE_FAILURE_SCENARIOS[0]), true);
  assert.equal(
    Object.isFrozen(PLUGIN_AUTHORING_JUDGE_IMAGE_FAILURE_SCENARIOS[0].expectedFailureJudges),
    true
  );
});

test("rejects omission, widening, ordering drift, and unknown taxonomy", () => {
  const cases = [
    (scenarios) => scenarios.pop(),
    (scenarios) => (scenarios[0].unknown = true),
    (scenarios) => (scenarios[0].id = "unknown-failure"),
    (scenarios) => scenarios.reverse(),
    (scenarios) => scenarios[0].expectedFailureJudges.reverse(),
    (scenarios) => scenarios[0].expectedFailureJudges.push("manifest"),
    (scenarios) => (scenarios[0].taskId = "unknown-task"),
    (scenarios) => (scenarios[0].targetJudge = "unknown-judge"),
    (scenarios) => (scenarios[0].expectedFailureJudges = ["build"]),
    (scenarios) => (scenarios[1].mutation = scenarios[0].mutation),
    (scenarios) => (scenarios[1].taskId = scenarios[0].taskId)
  ];
  for (const mutate of cases) {
    const scenarios = structuredClone(PLUGIN_AUTHORING_JUDGE_IMAGE_FAILURE_SCENARIOS);
    mutate(scenarios);
    assert.throws(
      () => parsePluginAuthoringJudgeImageFailureScenarios(scenarios),
      /judge image failure scenarios are invalid/u
    );
  }
});

test("returns a detached frozen contract", () => {
  const input = structuredClone(PLUGIN_AUTHORING_JUDGE_IMAGE_FAILURE_SCENARIOS);
  const parsed = parsePluginAuthoringJudgeImageFailureScenarios(input);
  input[0].expectedFailureJudges.length = 0;
  assert.notEqual(parsed, input);
  assert.equal(parsed[0].expectedFailureJudges.length > 0, true);
  assert.equal(Object.isFrozen(parsed[0].expectedFailureJudges), true);
});
