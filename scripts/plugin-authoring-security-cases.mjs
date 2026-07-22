import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parsePluginAuthoringCorpus } from "./plugin-authoring-eval.mjs";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_CASES_PER_TASK = 2;
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

export function loadPluginAuthoringSecurityCases(judgeRoot, corpus) {
  try {
    const path = join(judgeRoot, "evals", "plugin-authoring", "security-cases.json");
    const metadata = lstatSync(path);
    assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1);
    assert(metadata.size <= MAX_FILE_BYTES);
    return parsePluginAuthoringSecurityCases(JSON.parse(readFileSync(path, "utf8")), corpus);
  } catch {
    throw new Error("plugin authoring security cases are invalid");
  }
}

export function loadPluginAuthoringTaskSecurityCases(judgeRoot, task) {
  try {
    const corpusPath = join(judgeRoot, "evals", "plugin-authoring", "corpus.json");
    const metadata = lstatSync(corpusPath);
    assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1);
    assert(metadata.size <= MAX_FILE_BYTES);
    const corpus = parsePluginAuthoringCorpus(JSON.parse(readFileSync(corpusPath, "utf8")));
    const canonicalTask = corpus.tasks.find((candidate) => candidate.id === task?.id);
    assert(canonicalTask !== undefined);
    assert(canonicalJson(canonicalTask) === canonicalJson(task));
    const matrix = loadPluginAuthoringSecurityCases(judgeRoot, corpus);
    const taskCases = matrix.tasks.find((entry) => entry.taskId === canonicalTask.id);
    assert(taskCases !== undefined);
    return taskCases.cases;
  } catch {
    throw new Error("plugin authoring security cases are invalid");
  }
}

export function parsePluginAuthoringSecurityCases(input, corpus) {
  try {
    assert(isPlainRecord(input));
    assertExactKeys(input, ["schemaVersion", "tasks"]);
    assert(input.schemaVersion === 1);
    assert(isPlainRecord(corpus) && Array.isArray(corpus.tasks));
    assert(Array.isArray(input.tasks) && input.tasks.length === corpus.tasks.length);
    for (const [taskIndex, taskCases] of input.tasks.entries()) {
      const task = corpus.tasks[taskIndex];
      assert(isPlainRecord(taskCases));
      assertExactKeys(taskCases, ["taskId", "cases"]);
      assert(taskCases.taskId === task.id);
      assert(
        Array.isArray(taskCases.cases) &&
          taskCases.cases.length >= 1 &&
          taskCases.cases.length <= MAX_CASES_PER_TASK
      );
      const names = new Set();
      for (const securityCase of taskCases.cases) {
        validateSecurityCase(securityCase, task);
        assert(!names.has(securityCase.name));
        names.add(securityCase.name);
      }
    }
    return deepFreeze(structuredClone(input));
  } catch {
    throw new Error("plugin authoring security cases are invalid");
  }
}

function validateSecurityCase(securityCase, task) {
  assert(isPlainRecord(securityCase));
  assertExactKeys(securityCase, ["name", "hookName", "payload", "capabilityPlan"]);
  assert(
    typeof securityCase.name === "string" &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(securityCase.name) &&
      securityCase.name.length <= 64
  );
  assert(securityCase.hookName === task.hook.name);
  assert(isPlainRecord(securityCase.payload));
  for (const key of ["__proto__", "constructor", "prototype"])
    assert(Object.hasOwn(securityCase.payload, key));
  validateJsonValue(securityCase.payload);
  assert(
    Array.isArray(securityCase.capabilityPlan) &&
      securityCase.capabilityPlan.length <= MAX_CAPABILITY_STEPS
  );
  for (const step of securityCase.capabilityPlan) {
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
  }
}

function validateJsonValue(value) {
  const state = { nodes: 0 };
  const visit = (current, depth) => {
    state.nodes += 1;
    assert(state.nodes <= MAX_JSON_NODES && depth <= MAX_JSON_DEPTH);
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "number")
      return assert(Number.isFinite(current) && !Object.is(current, -0));
    if (typeof current === "string") {
      assert(current.length <= MAX_STRING_LENGTH && !/[\u0000-\u001f\u007f]/u.test(current));
      assert(!UNSAFE_TEXT_PATTERNS.some((pattern) => pattern.test(current)));
      return;
    }
    if (Array.isArray(current)) {
      assert(current.length <= MAX_ARRAY_ITEMS);
      return current.forEach((entry) => visit(entry, depth + 1));
    }
    assert(isPlainRecord(current));
    const keys = Object.keys(current);
    assert(keys.length <= MAX_OBJECT_KEYS);
    for (const key of keys) {
      assert(key.length >= 1 && key.length <= 80);
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
