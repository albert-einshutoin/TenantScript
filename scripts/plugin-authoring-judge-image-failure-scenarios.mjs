import assert from "node:assert/strict";

import {
  PLUGIN_AUTHORING_FAILURE_BY_JUDGE,
  PLUGIN_AUTHORING_REQUIRED_JUDGES,
  PLUGIN_AUTHORING_TASK_IDS
} from "./plugin-authoring-eval.mjs";

export const PLUGIN_AUTHORING_JUDGE_IMAGE_FAILURE_SCENARIO_IDS = Object.freeze([
  "manifest-invalid",
  "build-failed",
  "unit-test-failed",
  "security-test-failed",
  "audit-failed",
  "least-privilege-failed"
]);

export const PLUGIN_AUTHORING_JUDGE_IMAGE_FAILURE_SCENARIOS =
  parsePluginAuthoringJudgeImageFailureScenarios([
    {
      id: "manifest-invalid",
      taskId: "approval-invoice-threshold",
      targetJudge: "manifest",
      mutation: "invalid-manifest-version",
      expectedFailureJudges: ["manifest", "audit", "least-privilege"]
    },
    {
      id: "build-failed",
      taskId: "approval-refund-review",
      targetJudge: "build",
      mutation: "compile-type-error",
      expectedFailureJudges: ["build", "unit-test", "security-test", "audit"]
    },
    {
      id: "unit-test-failed",
      taskId: "error-malformed-payload",
      targetJudge: "unit-test",
      mutation: "wrong-behavior-result",
      expectedFailureJudges: ["unit-test"]
    },
    {
      id: "security-test-failed",
      taskId: "policy-data-residency",
      targetJudge: "security-test",
      mutation: "raw-egress-attempt",
      expectedFailureJudges: ["unit-test", "security-test", "audit"]
    },
    {
      id: "audit-failed",
      taskId: "webhook-currency-normalizer",
      targetJudge: "audit",
      mutation: "missing-test-script",
      expectedFailureJudges: ["audit"]
    },
    {
      id: "least-privilege-failed",
      taskId: "webhook-ticket-priority",
      targetJudge: "least-privilege",
      mutation: "unused-capability-grant",
      expectedFailureJudges: ["audit", "least-privilege"]
    }
  ]);

export function parsePluginAuthoringJudgeImageFailureScenarios(input) {
  try {
    assert(Array.isArray(input));
    assert(input.length === PLUGIN_AUTHORING_JUDGE_IMAGE_FAILURE_SCENARIO_IDS.length);
    const scenarios = input.map((scenario) => parseScenario(scenario));
    assert.deepEqual(
      scenarios.map(({ id }) => id),
      PLUGIN_AUTHORING_JUDGE_IMAGE_FAILURE_SCENARIO_IDS
    );
    assert(new Set(scenarios.map(({ mutation }) => mutation)).size === scenarios.length);
    assert(new Set(scenarios.map(({ targetJudge }) => targetJudge)).size === scenarios.length);
    assert(new Set(scenarios.map(({ taskId }) => taskId)).size === scenarios.length);
    return deepFreeze(scenarios);
  } catch {
    throw new Error("judge image failure scenarios are invalid");
  }
}

function parseScenario(scenario) {
  assert(isRecord(scenario));
  assert.deepEqual(Object.keys(scenario).sort(), [
    "expectedFailureJudges",
    "id",
    "mutation",
    "targetJudge",
    "taskId"
  ]);
  assert(
    typeof scenario.id === "string" &&
      PLUGIN_AUTHORING_JUDGE_IMAGE_FAILURE_SCENARIO_IDS.includes(scenario.id)
  );
  assert(
    typeof scenario.taskId === "string" && PLUGIN_AUTHORING_TASK_IDS.includes(scenario.taskId)
  );
  assert(
    typeof scenario.targetJudge === "string" &&
      PLUGIN_AUTHORING_REQUIRED_JUDGES.includes(scenario.targetJudge)
  );
  assert(PLUGIN_AUTHORING_FAILURE_BY_JUDGE[scenario.targetJudge] === scenario.id);
  assert(
    typeof scenario.mutation === "string" &&
      scenario.mutation.length <= 64 &&
      /^[a-z]+(?:-[a-z]+)*$/u.test(scenario.mutation)
  );
  assert(
    Array.isArray(scenario.expectedFailureJudges) &&
      scenario.expectedFailureJudges.length >= 1 &&
      scenario.expectedFailureJudges.length <= PLUGIN_AUTHORING_REQUIRED_JUDGES.length
  );
  assert(
    scenario.expectedFailureJudges.every((judge) =>
      PLUGIN_AUTHORING_REQUIRED_JUDGES.includes(judge)
    )
  );
  assert(new Set(scenario.expectedFailureJudges).size === scenario.expectedFailureJudges.length);
  assert.deepEqual(
    scenario.expectedFailureJudges,
    PLUGIN_AUTHORING_REQUIRED_JUDGES.filter((judge) =>
      scenario.expectedFailureJudges.includes(judge)
    )
  );
  assert(scenario.expectedFailureJudges.includes(scenario.targetJudge));
  return structuredClone(scenario);
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
  } else if (isRecord(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return Object.freeze(value);
}

function isRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
