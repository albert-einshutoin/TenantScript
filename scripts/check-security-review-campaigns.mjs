import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const repoRoot = resolve(process.argv[2] ?? process.cwd());
const reviewsDirectory = join(repoRoot, "docs", "security", "reviews");
const requiredFocus = [
  "loader-isolation",
  "capability-broker",
  "egress-proxy",
  "identity-rbac",
  "storage-isolation",
  "admin-ui"
];
const campaignStatuses = new Set(["prepared", "in-progress", "completed"]);
const findingSeverities = new Set(["low", "medium", "high", "critical"]);
const findingStatuses = new Set(["open", "resolved", "accepted-risk"]);
const sensitiveFieldPattern = /(?:token|secret|credential|password|account.?id)/i;
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

if (!existsSync(reviewsDirectory)) {
  errors.push("docs/security/reviews: directory is missing");
} else {
  const campaignFiles = readdirSync(reviewsDirectory)
    .filter((file) => file.endsWith(".json"))
    .sort();

  if (campaignFiles.length === 0) {
    errors.push("docs/security/reviews: at least one JSON campaign is required");
  }

  for (const file of campaignFiles) {
    validateCampaign(join("docs", "security", "reviews", file));
  }

  if (errors.length === 0) {
    const noun = campaignFiles.length === 1 ? "campaign" : "campaigns";
    process.stdout.write(
      `Security review campaign check passed (${String(campaignFiles.length)} ${noun}).\n`
    );
  }
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
}

function validateCampaign(relativePath) {
  let campaign;
  try {
    campaign = JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));
  } catch (error) {
    errors.push(
      `${relativePath}: invalid JSON: ${error instanceof Error ? error.message : "error"}`
    );
    return;
  }

  if (!isRecord(campaign)) {
    errors.push(`${relativePath}: campaign must be a JSON object`);
    return;
  }

  findSensitiveFields(campaign, relativePath);
  if (campaign.schemaVersion !== 1) {
    errors.push(`${relativePath}: schemaVersion must be 1`);
  }
  if (typeof campaign.id !== "string" || !/^TS-REVIEW-\d{4}-\d{3}$/.test(campaign.id)) {
    errors.push(`${relativePath}: id must match TS-REVIEW-YYYY-NNN`);
  }
  if (typeof campaign.status !== "string" || !campaignStatuses.has(campaign.status)) {
    errors.push(`${relativePath}: status must be prepared, in-progress, or completed`);
  }
  validateBaseline(campaign.baselineCommit, relativePath);
  validateScope(campaign.scope, campaign.baselineCommit, relativePath);
  validateFocus(campaign.requiredFocus, relativePath);
  validateUniqueStrings(campaign.reviewers, "reviewers", relativePath);
  validateLimitations(campaign.remainingLimitations, relativePath);

  if (campaign.status === "prepared") {
    validatePrepared(campaign, relativePath);
  } else if (campaign.status === "in-progress") {
    validateInProgress(campaign, relativePath);
  } else if (campaign.status === "completed") {
    validateCompleted(campaign, relativePath);
  }
}

function validateBaseline(value, relativePath) {
  // A review must target immutable code so later changes cannot inherit an earlier attestation.
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    errors.push(`${relativePath}: baselineCommit must be a full 40-character commit SHA`);
    return;
  }
  const result = spawnSync("git", ["cat-file", "-e", `${value}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    errors.push(`${relativePath}: baselineCommit does not exist in this repository: ${value}`);
  }
}

function validateScope(value, baselineCommit, relativePath) {
  validateUniqueStrings(value, "scope", relativePath, { requireNonEmpty: true });
  if (!Array.isArray(value)) {
    return;
  }
  for (const path of value) {
    if (typeof path !== "string" || path.trim() === "") {
      continue;
    }
    if (
      isAbsolute(path) ||
      /^[A-Za-z]:[\\/]/.test(path) ||
      path.split(/[\\/]/).includes("..") ||
      path.startsWith("file:")
    ) {
      errors.push(`${relativePath}: scope must stay inside the repository: ${path}`);
      continue;
    }
    // Checking the pinned tree, not the current checkout, keeps the published scope reproducible.
    const result = spawnSync("git", ["cat-file", "-e", `${String(baselineCommit)}:${path}`], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    if (result.status !== 0) {
      errors.push(`${relativePath}: scope does not exist: ${path}`);
    }
  }
}

function validatePrepared(campaign, relativePath) {
  if (Array.isArray(campaign.reviewers) && campaign.reviewers.length !== 0) {
    errors.push(`${relativePath}: prepared campaign reviewers must be empty`);
  }
  requireNull(campaign, "independenceStatement", relativePath);
  requireNull(campaign, "startedAt", relativePath);
  requireNull(campaign, "completedAt", relativePath);
  requireEmptyArray(campaign, "coverage", relativePath);
  requireEmptyArray(campaign, "findings", relativePath);
  requireNull(campaign, "attestationEvidence", relativePath);
}

function validateInProgress(campaign, relativePath) {
  if (!Array.isArray(campaign.reviewers) || campaign.reviewers.length === 0) {
    errors.push(`${relativePath}: in-progress campaign requires at least one reviewer`);
  }
  requireNonEmptyString(campaign, "independenceStatement", relativePath);
  parseTimestamp(campaign.startedAt, `${relativePath}: invalid startedAt`);
  requireNull(campaign, "completedAt", relativePath);
  validateCoverage(campaign.coverage, relativePath, false);
  validateFindings(campaign.findings, relativePath, false);
  requireNull(campaign, "attestationEvidence", relativePath);
}

function validateCompleted(campaign, relativePath) {
  if (!Array.isArray(campaign.reviewers) || campaign.reviewers.length === 0) {
    errors.push(`${relativePath}: completed campaign requires at least one reviewer`);
  }
  if (
    typeof campaign.independenceStatement !== "string" ||
    campaign.independenceStatement.trim() === ""
  ) {
    errors.push(`${relativePath}: completed campaign requires an independenceStatement`);
  }
  const startedAt = parseTimestamp(campaign.startedAt, `${relativePath}: invalid startedAt`);
  const completedAt = parseTimestamp(campaign.completedAt, `${relativePath}: invalid completedAt`);
  if (startedAt !== undefined && completedAt !== undefined && startedAt > completedAt) {
    errors.push(`${relativePath}: completedAt must not precede startedAt`);
  }
  validateCoverage(campaign.coverage, relativePath, true);
  validateFindings(campaign.findings, relativePath, true);
  validateEvidence(campaign.attestationEvidence, `${relativePath}: attestationEvidence`);
}

function validateFocus(value, relativePath) {
  validateUniqueStrings(value, "requiredFocus", relativePath, { requireNonEmpty: true });
  if (!Array.isArray(value)) {
    return;
  }
  for (const focus of requiredFocus) {
    if (!value.includes(focus)) {
      errors.push(`${relativePath}: requiredFocus is missing ${focus}`);
    }
  }
  for (const focus of value) {
    if (!requiredFocus.includes(focus)) {
      errors.push(`${relativePath}: unknown required focus ${String(focus)}`);
    }
  }
}

function validateCoverage(value, relativePath, requireAll) {
  if (!Array.isArray(value)) {
    errors.push(`${relativePath}: coverage must be an array`);
    return;
  }
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      errors.push(`${relativePath}: coverage.${String(index)} must be an object`);
      continue;
    }
    if (typeof item.focus !== "string" || !requiredFocus.includes(item.focus)) {
      errors.push(`${relativePath}: coverage.${String(index)} has unknown focus`);
    } else if (seen.has(item.focus)) {
      errors.push(`${relativePath}: coverage focus ${item.focus} must not be duplicated`);
    } else {
      seen.add(item.focus);
    }
    if (item.status !== "reviewed") {
      errors.push(`${relativePath}: coverage.${String(index)} status must be reviewed`);
    }
    validateEvidence(item.evidence, `${relativePath}: coverage.${String(index)}.evidence`);
  }
  if (requireAll) {
    for (const focus of requiredFocus) {
      if (!seen.has(focus)) {
        errors.push(`${relativePath}: missing required focus ${focus}`);
      }
    }
  }
}

function validateFindings(value, relativePath, requireResolvedHigh) {
  if (!Array.isArray(value)) {
    errors.push(`${relativePath}: findings must be an array`);
    return;
  }
  const seen = new Set();
  for (const [index, finding] of value.entries()) {
    if (!isRecord(finding)) {
      errors.push(`${relativePath}: findings.${String(index)} must be an object`);
      continue;
    }
    if (typeof finding.id !== "string" || !/^TS-FINDING-\d{3}$/.test(finding.id)) {
      errors.push(`${relativePath}: findings.${String(index)} id must match TS-FINDING-NNN`);
    } else if (seen.has(finding.id)) {
      errors.push(`${relativePath}: finding id ${finding.id} must not be duplicated`);
    } else {
      seen.add(finding.id);
    }
    if (typeof finding.severity !== "string" || !findingSeverities.has(finding.severity)) {
      errors.push(`${relativePath}: findings.${String(index)} has invalid severity`);
    }
    if (typeof finding.status !== "string" || !findingStatuses.has(finding.status)) {
      errors.push(`${relativePath}: findings.${String(index)} has invalid status`);
    }
    validateEvidence(finding.evidence, `${relativePath}: findings.${String(index)}.evidence`);

    const isHighImpact = finding.severity === "critical" || finding.severity === "high";
    if (requireResolvedHigh && isHighImpact && finding.status !== "resolved") {
      errors.push(
        `${relativePath}: critical or high finding ${String(finding.id)} is not resolved`
      );
    }
    if (isHighImpact && finding.status === "resolved") {
      validateEvidence(
        finding.regressionTest,
        `${relativePath}: findings.${String(index)}.regressionTest`
      );
    }
  }
}

function validateEvidence(value, fieldPath) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${fieldPath} is required`);
    return;
  }
  if (/^https:\/\//.test(value)) {
    const url = new URL(value);
    // Query strings and fragments commonly carry access keys or private report identifiers.
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      errors.push(`${fieldPath} HTTPS URL must not contain credentials, query, or fragment data`);
    }
    return;
  }
  if (isAbsolute(value) || value.split(/[\\/]/).includes("..") || value.startsWith("file:")) {
    errors.push(`${fieldPath} must stay inside the repository`);
    return;
  }
  if (!existsSync(join(repoRoot, value))) {
    errors.push(`${fieldPath} does not exist: ${value}`);
  }
}

function validateUniqueStrings(value, key, relativePath, options = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${relativePath}: ${key} must be an array`);
    return;
  }
  if (options.requireNonEmpty === true && value.length === 0) {
    errors.push(`${relativePath}: ${key} must not be empty`);
  }
  if (value.some((item) => typeof item !== "string" || item.trim() === "")) {
    errors.push(`${relativePath}: ${key} must contain non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    errors.push(`${relativePath}: ${key} must not contain duplicates`);
  }
}

function validateLimitations(value, relativePath) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    errors.push(`${relativePath}: remainingLimitations must contain at least one statement`);
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

function requireNull(record, key, relativePath) {
  if (record[key] !== null) {
    errors.push(`${relativePath}: ${key} must be null`);
  }
}

function requireEmptyArray(record, key, relativePath) {
  if (!Array.isArray(record[key]) || record[key].length !== 0) {
    errors.push(`${relativePath}: ${key} must be an empty array`);
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
