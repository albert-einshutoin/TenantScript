import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const repoRoot = resolve(process.argv[2] ?? process.cwd());
const drillsDirectory = join(repoRoot, "docs", "security", "advisory-drills");
const requiredStages = [
  "intake",
  "triage",
  "regression-test",
  "fix",
  "advisory-decision",
  "closeout"
];
const severities = new Set(["low", "medium", "high", "critical"]);
const advisoryDecisions = new Set(["draft-required", "not-required"]);
const sensitiveFieldPattern = /(?:token|secret|credential|password|account.?id)/i;
const errors = [];

if (!existsSync(drillsDirectory)) {
  errors.push("docs/security/advisory-drills: directory is missing");
} else {
  const drillFiles = readdirSync(drillsDirectory)
    .filter((file) => file.endsWith(".json"))
    .sort();

  if (drillFiles.length === 0) {
    errors.push("docs/security/advisory-drills: at least one JSON drill record is required");
  }

  for (const file of drillFiles) {
    validateDrill(join("docs", "security", "advisory-drills", file));
  }

  if (errors.length === 0) {
    const noun = drillFiles.length === 1 ? "record" : "records";
    process.stdout.write(`Advisory drill check passed (${String(drillFiles.length)} ${noun}).\n`);
  }
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
}

function validateDrill(relativePath) {
  let drill;
  try {
    drill = JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));
  } catch (error) {
    errors.push(`${relativePath}: invalid JSON: ${error instanceof Error ? error.message : "error"}`);
    return;
  }

  if (!isRecord(drill)) {
    errors.push(`${relativePath}: record must be a JSON object`);
    return;
  }

  findSensitiveFields(drill, relativePath);

  if (drill.schemaVersion !== 1) {
    errors.push(`${relativePath}: schemaVersion must be 1`);
  }
  if (typeof drill.id !== "string" || !/^TS-DRILL-\d{4}-\d{3}$/.test(drill.id)) {
    errors.push(`${relativePath}: id must match TS-DRILL-YYYY-NNN`);
  }
  if (drill.kind !== "tabletop") {
    errors.push(`${relativePath}: committed drill kind must be tabletop`);
  }
  if (drill.visibility !== "public-synthetic") {
    errors.push(`${relativePath}: committed drills must use public-synthetic visibility`);
  }
  requireNonEmptyString(drill, "scenario", relativePath);
  if (typeof drill.severity !== "string" || !severities.has(drill.severity)) {
    errors.push(`${relativePath}: severity must be low, medium, high, or critical`);
  }
  if (
    typeof drill.advisoryDecision !== "string" ||
    !advisoryDecisions.has(drill.advisoryDecision)
  ) {
    errors.push(`${relativePath}: advisoryDecision must be draft-required or not-required`);
  }
  requireNonEmptyString(drill, "decisionRationale", relativePath);

  const startedAt = parseTimestamp(drill.startedAt, `${relativePath}: invalid startedAt`);
  const completedAt = parseTimestamp(drill.completedAt, `${relativePath}: invalid completedAt`);
  if (startedAt !== undefined && completedAt !== undefined && startedAt > completedAt) {
    errors.push(`${relativePath}: completedAt must not precede startedAt`);
  }

  validateStages(drill.stages, relativePath, startedAt, completedAt);

  if (
    !Array.isArray(drill.remainingLimitations) ||
    drill.remainingLimitations.length === 0 ||
    drill.remainingLimitations.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    errors.push(`${relativePath}: remainingLimitations must contain at least one statement`);
  }
}

function validateStages(stages, relativePath, startedAt, completedAt) {
  if (!Array.isArray(stages)) {
    errors.push(`${relativePath}: stages must be an array`);
    return;
  }

  const names = stages.map((stage) => (isRecord(stage) ? stage.name : undefined));
  // Requiring the full lifecycle prevents a closeout-only note from being counted as a drill.
  for (const requiredStage of requiredStages) {
    if (!names.includes(requiredStage)) {
      errors.push(`${relativePath}: missing required stage ${requiredStage}`);
    }
  }
  for (const name of names) {
    if (typeof name !== "string" || !requiredStages.includes(name)) {
      errors.push(`${relativePath}: unknown advisory stage ${String(name)}`);
    }
  }
  if (new Set(names).size !== names.length) {
    errors.push(`${relativePath}: advisory stages must not be duplicated`);
  }
  if (names.join("|") !== requiredStages.join("|")) {
    errors.push(`${relativePath}: stages must follow the required lifecycle order`);
  }

  let previousAt;
  for (const [index, stage] of stages.entries()) {
    if (!isRecord(stage)) {
      errors.push(`${relativePath}: stages.${String(index)} must be an object`);
      continue;
    }
    const at = parseTimestamp(stage.at, `${relativePath}: stages.${String(index)} has invalid at`);
    if (at !== undefined) {
      if (previousAt !== undefined && at < previousAt) {
        errors.push(`${relativePath}: stages must be chronological`);
      }
      if (startedAt !== undefined && at < startedAt) {
        errors.push(`${relativePath}: stage ${String(stage.name)} precedes startedAt`);
      }
      if (completedAt !== undefined && at > completedAt) {
        errors.push(`${relativePath}: stage ${String(stage.name)} follows completedAt`);
      }
      previousAt = at;
    }
    validateEvidence(stage.evidence, relativePath, index);
  }
}

function validateEvidence(evidence, relativePath, index) {
  if (typeof evidence !== "string" || evidence.trim() === "") {
    errors.push(`${relativePath}: stages.${String(index)} evidence is required`);
    return;
  }
  if (/^https:\/\//.test(evidence)) {
    return;
  }
  if (
    isAbsolute(evidence) ||
    evidence.split(/[\\/]/).includes("..") ||
    evidence.startsWith("file:")
  ) {
    errors.push(`${relativePath}: evidence must stay inside the repository: ${evidence}`);
    return;
  }
  if (!existsSync(join(repoRoot, evidence))) {
    errors.push(`${relativePath}: evidence does not exist: ${evidence}`);
  }
}

function findSensitiveFields(value, path) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSensitiveFields(item, `${path}.${String(index)}`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (sensitiveFieldPattern.test(key)) {
      errors.push(`${path}: forbidden sensitive field ${key}`);
    }
    findSensitiveFields(nested, `${path}.${key}`);
  }
}

function requireNonEmptyString(record, key, relativePath) {
  if (typeof record[key] !== "string" || record[key].trim() === "") {
    errors.push(`${relativePath}: ${key} must be a non-empty string`);
  }
}

function parseTimestamp(value, errorMessage) {
  if (typeof value !== "string") {
    errors.push(errorMessage);
    return undefined;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    errors.push(errorMessage);
    return undefined;
  }
  return parsed;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
