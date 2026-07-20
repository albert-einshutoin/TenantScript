import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const repoRoot = resolve(process.argv[2] ?? process.cwd());
const drillsDirectory = join(repoRoot, "docs", "operations", "incident-drills");
const requiredStages = ["detect", "scope", "contain", "recover", "postmortem"];
const severities = new Set(["low", "medium", "high", "critical"]);
const outcomes = new Set(["passed", "follow-up-required"]);
const sensitiveFieldPattern = /(?:token|secret|credential|password|account.?id|customer.?id)/i;
const sensitiveValuePatterns = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:\/Users\/|\/Volumes\/)/,
  /dash\.cloudflare\.com\/[0-9a-f]{16,}/i
];
const errors = [];

if (!existsSync(drillsDirectory)) {
  errors.push("docs/operations/incident-drills: directory is missing");
} else {
  const drillFiles = readdirSync(drillsDirectory)
    .filter((file) => file.endsWith(".json"))
    .sort();

  if (drillFiles.length === 0) {
    errors.push("docs/operations/incident-drills: at least one JSON drill record is required");
  }

  for (const file of drillFiles) {
    validateDrill(join("docs", "operations", "incident-drills", file));
  }

  if (errors.length === 0) {
    const noun = drillFiles.length === 1 ? "record" : "records";
    process.stdout.write(`Incident drill check passed (${String(drillFiles.length)} ${noun}).\n`);
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
    errors.push(
      `${relativePath}: invalid JSON: ${error instanceof Error ? error.message : "error"}`
    );
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
  if (typeof drill.id !== "string" || !/^TS-INCIDENT-DRILL-\d{4}-\d{3}$/.test(drill.id)) {
    errors.push(`${relativePath}: id must match TS-INCIDENT-DRILL-YYYY-NNN`);
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

  const startedAt = parseTimestamp(drill.startedAt, `${relativePath}: invalid startedAt`);
  const completedAt = parseTimestamp(drill.completedAt, `${relativePath}: invalid completedAt`);
  if (startedAt !== undefined && completedAt !== undefined && startedAt > completedAt) {
    errors.push(`${relativePath}: completedAt must not precede startedAt`);
  }

  validateStages(drill.stages, relativePath, startedAt, completedAt);

  if (typeof drill.outcome !== "string" || !outcomes.has(drill.outcome)) {
    errors.push(`${relativePath}: outcome must be passed or follow-up-required`);
  }
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
  // Exact lifecycle coverage keeps an observation-only note from being counted as an incident drill.
  for (const requiredStage of requiredStages) {
    if (!names.includes(requiredStage)) {
      errors.push(`${relativePath}: missing required stage ${requiredStage}`);
    }
  }
  for (const name of names) {
    if (typeof name !== "string" || !requiredStages.includes(name)) {
      errors.push(`${relativePath}: unknown incident stage ${String(name)}`);
    }
  }
  if (new Set(names).size !== names.length) {
    errors.push(`${relativePath}: incident stages must not be duplicated`);
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
    try {
      const url = new URL(evidence);
      if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
        errors.push(
          `${relativePath}: HTTPS evidence must not contain query or fragment data: ${evidence}`
        );
      }
    } catch {
      errors.push(`${relativePath}: invalid HTTPS evidence URL: ${evidence}`);
    }
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

  const candidate = resolve(repoRoot, evidence);
  if (!existsSync(candidate)) {
    errors.push(`${relativePath}: evidence does not exist: ${evidence}`);
    return;
  }
  // Resolve symlinks too so committed evidence cannot silently point at machine-local files.
  const resolvedEvidence = realpathSync(candidate);
  const evidenceFromRoot = relative(realpathSync(repoRoot), resolvedEvidence);
  if (evidenceFromRoot === ".." || evidenceFromRoot.startsWith(`..${sep}`)) {
    errors.push(`${relativePath}: evidence must stay inside the repository: ${evidence}`);
  }
}

function findSensitiveFields(value, path) {
  if (typeof value === "string") {
    if (sensitiveValuePatterns.some((pattern) => pattern.test(value))) {
      errors.push(`${path}: forbidden credential-like value`);
    }
    return;
  }
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
