import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parsePluginAuthoringCorpus } from "./plugin-authoring-eval.mjs";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_CASES_PER_TASK = 8;
const MAX_CAPABILITY_STEPS = 4;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_NODES = 256;
const MAX_ARRAY_ITEMS = 32;
const MAX_OBJECT_KEYS = 32;
const MAX_STRING_LENGTH = 512;
const UNSAFE_TEXT_PATTERNS = [
  /(?:^|\s)\/(?:Users|home|workspace|Volumes)\//u,
  /(?:^|[^A-Za-z0-9])(?:ghp_|sk-proj-|API_TOKEN=|password=)/iu,
  /[A-Za-z]:\\Users\\/u
];

export function loadPluginAuthoringBehaviorCases(baselineRoot, corpus) {
  try {
    const path = join(baselineRoot, "evals", "plugin-authoring", "behavior-cases.json");
    const metadata = lstatSync(path);
    assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1);
    assert(metadata.size <= MAX_FILE_BYTES);
    return parsePluginAuthoringBehaviorCases(JSON.parse(readFileSync(path, "utf8")), corpus);
  } catch {
    throw new Error("plugin authoring behavior cases are invalid");
  }
}

export function loadPluginAuthoringTaskBehaviorCases(baselineRoot, task) {
  try {
    const corpusPath = join(baselineRoot, "evals", "plugin-authoring", "corpus.json");
    const metadata = lstatSync(corpusPath);
    assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1);
    assert(metadata.size <= MAX_FILE_BYTES);
    const corpus = parsePluginAuthoringCorpus(JSON.parse(readFileSync(corpusPath, "utf8")));
    const canonicalTask = corpus.tasks.find((candidate) => candidate.id === task?.id);
    assert(canonicalTask !== undefined);
    assert(canonicalJson(canonicalTask) === canonicalJson(task));
    const matrix = loadPluginAuthoringBehaviorCases(baselineRoot, corpus);
    const taskCases = matrix.tasks.find((candidate) => candidate.taskId === canonicalTask.id);
    assert(taskCases !== undefined);
    return taskCases.cases;
  } catch {
    throw new Error("plugin authoring behavior cases are invalid");
  }
}

export function parsePluginAuthoringBehaviorCases(input, corpus) {
  try {
    assert(isPlainRecord(input));
    assertExactKeys(input, ["schemaVersion", "tasks"]);
    assert(input.schemaVersion === 1);
    assert(isPlainRecord(corpus) && Array.isArray(corpus.tasks));
    assert(Array.isArray(input.tasks) && input.tasks.length === corpus.tasks.length);

    for (const [taskIndex, taskCases] of input.tasks.entries()) {
      const task = corpus.tasks[taskIndex];
      assert(isPlainRecord(task) && typeof task.id === "string");
      assert(isPlainRecord(task.hook) && typeof task.hook.name === "string");
      assert(Array.isArray(task.capabilities));
      assert(isPlainRecord(taskCases));
      assertExactKeys(taskCases, ["taskId", "cases"]);
      assert(taskCases.taskId === task.id);
      assert(
        Array.isArray(taskCases.cases) &&
          taskCases.cases.length >= 3 &&
          taskCases.cases.length <= MAX_CASES_PER_TASK
      );
      const caseNames = new Set();
      for (const behaviorCase of taskCases.cases) {
        validateBehaviorCase(behaviorCase, task);
        assert(!caseNames.has(behaviorCase.name));
        caseNames.add(behaviorCase.name);
      }
    }

    return deepFreeze(structuredClone(input));
  } catch {
    throw new Error("plugin authoring behavior cases are invalid");
  }
}

function validateBehaviorCase(behaviorCase, task) {
  assert(isPlainRecord(behaviorCase));
  assertExactKeys(behaviorCase, ["name", "hookName", "payload", "capabilityPlan", "expected"]);
  assert(
    typeof behaviorCase.name === "string" &&
      behaviorCase.name.length >= 1 &&
      behaviorCase.name.length <= 64 &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(behaviorCase.name)
  );
  assert(behaviorCase.hookName === task.hook.name);
  validateJsonValue(behaviorCase.payload);
  assert(
    Array.isArray(behaviorCase.capabilityPlan) &&
      behaviorCase.capabilityPlan.length <= MAX_CAPABILITY_STEPS
  );
  assert(isPlainRecord(behaviorCase.expected));
  assertExactKeys(behaviorCase.expected, ["result", "capabilityCalls"]);
  validateJsonValue(behaviorCase.expected.result);
  assert(Array.isArray(behaviorCase.expected.capabilityCalls));
  assert(behaviorCase.expected.capabilityCalls.length === behaviorCase.capabilityPlan.length);

  for (const [index, step] of behaviorCase.capabilityPlan.entries()) {
    assert(isPlainRecord(step));
    assertExactKeys(step, ["name", "input", "outcome"]);
    assert(task.capabilities.includes(step.name));
    validateJsonValue(step.input);
    assert(isPlainRecord(step.outcome));
    if (step.outcome.status === "resolve") {
      assertExactKeys(step.outcome, ["status", "value"]);
      validateJsonValue(step.outcome.value);
    } else {
      assert(step.outcome.status === "reject");
      assertExactKeys(step.outcome, ["status"]);
    }

    const expectedCall = behaviorCase.expected.capabilityCalls[index];
    assert(isPlainRecord(expectedCall));
    assertExactKeys(expectedCall, ["name", "input"]);
    assert(expectedCall.name === step.name);
    validateJsonValue(expectedCall.input);
    assert(canonicalJson(expectedCall.input) === canonicalJson(step.input));
  }
}

function validateJsonValue(value) {
  const state = { nodes: 0 };
  const visit = (current, depth) => {
    state.nodes += 1;
    assert(state.nodes <= MAX_JSON_NODES && depth <= MAX_JSON_DEPTH);
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "number") {
      assert(Number.isFinite(current) && !Object.is(current, -0));
      return;
    }
    if (typeof current === "string") {
      assert(current.length <= MAX_STRING_LENGTH && !/[\u0000-\u001f\u007f]/u.test(current));
      assert(!UNSAFE_TEXT_PATTERNS.some((pattern) => pattern.test(current)));
      return;
    }
    if (Array.isArray(current)) {
      assert(current.length <= MAX_ARRAY_ITEMS);
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    assert(isPlainRecord(current));
    const keys = Object.keys(current);
    assert(keys.length <= MAX_OBJECT_KEYS);
    for (const key of keys) {
      assert(
        key.length >= 1 &&
          key.length <= 80 &&
          !["__proto__", "constructor", "prototype"].includes(key)
      );
      visit(current[key], depth + 1);
    }
  };
  visit(value, 0);
}

function canonicalJson(value) {
  if (Array.isArray(value))
    return JSON.stringify(value.map((entry) => JSON.parse(canonicalJson(entry))));
  if (!isPlainRecord(value)) return JSON.stringify(value);
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, JSON.parse(canonicalJson(value[key]))])
    )
  );
}

function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function assertExactKeys(value, keys) {
  assert(
    Object.keys(value).sort(compareText).join("\0") === [...keys].sort(compareText).join("\0")
  );
}

function isPlainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assert(condition) {
  if (!condition) throw new Error("assertion failed");
}
