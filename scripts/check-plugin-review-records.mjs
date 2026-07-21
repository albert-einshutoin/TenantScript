import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const repoRoot = resolve(process.argv[2] ?? process.cwd());
const recordsDirectory = join(repoRoot, "docs", "security", "plugin-reviews");
const requiredDomains = ["security", "compatibility", "operations", "documentation", "license"];
const decisions = new Set(["approve", "request-changes", "reject"]);
const domainStatuses = new Set(["pass", "fail"]);
const sensitiveFieldPattern = /(?:token|secret|credential|password|account.?id)/i;
const secretLikePatterns = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
];
const accountIdentifierPatterns = [/dash\.cloudflare\.com\/[0-9a-f]{16,}/i];
const machinePathPattern =
  /(?:\/Users\/|\/Volumes\/|(?:^|\s)\/(?:home|workspace|root|tmp)\/|[A-Za-z]:\\Users\\)/;
const errors = [];

if (!existsSync(recordsDirectory)) {
  errors.push("docs/security/plugin-reviews: directory is missing");
} else {
  const recordFiles = readdirSync(recordsDirectory)
    .filter((file) => file.endsWith(".json"))
    .sort();

  if (recordFiles.length === 0) {
    errors.push("docs/security/plugin-reviews: at least one JSON record is required");
  }

  for (const file of recordFiles) {
    validateRecord(join("docs", "security", "plugin-reviews", file));
  }

  if (errors.length === 0) {
    const noun = recordFiles.length === 1 ? "record" : "records";
    process.stdout.write(
      `Plugin review record check passed (${String(recordFiles.length)} ${noun}).\n`
    );
  }
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
}

function validateRecord(relativePath) {
  let record;
  try {
    record = JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));
  } catch (error) {
    errors.push(
      `${relativePath}: invalid JSON: ${error instanceof Error ? error.message : "error"}`
    );
    return;
  }

  if (!isRecord(record)) {
    errors.push(`${relativePath}: record must be a JSON object`);
    return;
  }

  validateAllowedFields(
    record,
    [
      "schemaVersion",
      "id",
      "baselineCommit",
      "target",
      "reviewer",
      "reviewedAt",
      "domains",
      "evidenceDigests",
      "decision",
      "blockingFindings",
      "unverified",
      "limitations",
      "nonGuarantees"
    ],
    relativePath
  );
  findSensitiveContent(record, relativePath);

  if (record.schemaVersion !== 1) {
    errors.push(`${relativePath}: schemaVersion must be 1`);
  }
  if (typeof record.id !== "string" || !/^TS-PLUGIN-REVIEW-\d{4}-\d{3}$/.test(record.id)) {
    errors.push(`${relativePath}: id must match TS-PLUGIN-REVIEW-YYYY-NNN`);
  }

  validateBaseline(record.baselineCommit, relativePath);
  validateTarget(record.target, relativePath);
  validateReviewer(record.reviewer, relativePath);
  validateTimestamp(record.reviewedAt, `${relativePath}: reviewedAt`);
  const domainResults = validateDomains(record.domains, relativePath);
  validateEvidenceDigests(record.evidenceDigests, domainResults.evidencePaths, relativePath);

  if (typeof record.decision !== "string" || !decisions.has(record.decision)) {
    errors.push(`${relativePath}: decision must be approve, request-changes, or reject`);
  }
  validateStringArray(record.blockingFindings, "blockingFindings", relativePath);
  const requiredUnverified = validateUnverified(record.unverified, relativePath);
  validateStringArray(record.limitations, "limitations", relativePath, { requireNonEmpty: true });
  validateStringArray(record.nonGuarantees, "nonGuarantees", relativePath, {
    requireNonEmpty: true
  });

  if (record.decision === "approve") {
    if (!domainResults.everyPassed) {
      errors.push(`${relativePath}: approve decision requires every domain to pass`);
    }
    if (Array.isArray(record.blockingFindings) && record.blockingFindings.length > 0) {
      errors.push(`${relativePath}: approve decision requires no blockingFindings`);
    }
    if (requiredUnverified) {
      errors.push(
        `${relativePath}: approve decision cannot leave required verification incomplete`
      );
    }
  }
}

function validateBaseline(value, relativePath) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    errors.push(`${relativePath}: baselineCommit must be a full 40-character commit SHA`);
    return false;
  }
  const result = runGit(["cat-file", "-e", `${value}^{commit}`]);
  if (result.status !== 0) {
    errors.push(`${relativePath}: baselineCommit does not exist in this repository: ${value}`);
    return false;
  }
  return true;
}

function validateTarget(value, relativePath) {
  if (!isRecord(value)) {
    errors.push(`${relativePath}: target must be an object`);
    return;
  }
  validateAllowedFields(value, ["name", "scope", "sourceDigests"], `${relativePath}: target`);
  requireNonEmptyString(value.name, "target.name", relativePath);
  validateStringArray(value.scope, "target.scope", relativePath, { requireNonEmpty: true });
  if (!Array.isArray(value.scope)) {
    return;
  }

  const validPaths = new Set();
  for (const path of value.scope) {
    if (typeof path !== "string" || path.trim() === "") {
      continue;
    }
    if (!isRepositoryPath(path)) {
      errors.push(`${relativePath}: target.scope must stay inside the repository: ${path}`);
      continue;
    }
    validPaths.add(path);
  }
  validateTargetSourceDigests(value.sourceDigests, validPaths, relativePath);
}

function validateTargetSourceDigests(value, targetPaths, relativePath) {
  // Source hashes bind the reviewed tree itself, so a squash merge cannot discard the only commit
  // that made an approval verifiable. The baseline remains a reachable repository-context anchor.
  if (!isRecord(value)) {
    errors.push(`${relativePath}: target.sourceDigests must be an object`);
    return;
  }
  for (const path of targetPaths) {
    if (!(path in value)) errors.push(`${relativePath}: missing digest for target source: ${path}`);
  }
  for (const path of Object.keys(value)) {
    if (!targetPaths.has(path)) {
      errors.push(`${relativePath}: target source digest has no matching path: ${path}`);
    }
  }
  for (const path of targetPaths) {
    const digest = value[path];
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      errors.push(`${relativePath}: target source digest must be lowercase SHA-256: ${path}`);
      continue;
    }
    try {
      if (hasSymlinkedParent(path) || !lstatSync(join(repoRoot, path)).isFile()) {
        errors.push(`${relativePath}: target source must be a repository regular file: ${path}`);
        continue;
      }
      const actual = createHash("sha256")
        .update(readFileSync(join(repoRoot, path)))
        .digest("hex");
      if (actual !== digest) {
        errors.push(`${relativePath}: target source digest does not match: ${path}`);
      }
    } catch {
      errors.push(`${relativePath}: target source digest could not be verified: ${path}`);
    }
  }
}

function validateReviewer(value, relativePath) {
  if (!isRecord(value)) {
    errors.push(`${relativePath}: reviewer must be an object`);
    return;
  }
  validateAllowedFields(value, ["identity", "relationship"], `${relativePath}: reviewer`);
  requireNonEmptyString(value.identity, "reviewer.identity", relativePath);
  requireNonEmptyString(value.relationship, "reviewer.relationship", relativePath);
}

function validateDomains(value, relativePath) {
  if (!Array.isArray(value)) {
    errors.push(`${relativePath}: domains must be an array`);
    return { everyPassed: false, evidencePaths: new Set() };
  }
  const seen = new Set();
  const evidencePaths = new Set();
  let everyPassed = value.length === requiredDomains.length;
  for (const [index, domain] of value.entries()) {
    const path = `${relativePath}: domains.${String(index)}`;
    if (!isRecord(domain)) {
      errors.push(`${path} must be an object`);
      everyPassed = false;
      continue;
    }
    validateAllowedFields(domain, ["name", "status", "evidence", "notes"], path);
    if (typeof domain.name !== "string" || !requiredDomains.includes(domain.name)) {
      errors.push(`${path}.name is unknown`);
      everyPassed = false;
    } else if (seen.has(domain.name)) {
      errors.push(`${relativePath}: domain ${domain.name} must not be duplicated`);
      everyPassed = false;
    } else {
      seen.add(domain.name);
    }
    if (typeof domain.status !== "string" || !domainStatuses.has(domain.status)) {
      errors.push(`${path}.status must be pass or fail`);
      everyPassed = false;
    } else if (domain.status !== "pass") {
      everyPassed = false;
    }
    validateEvidence(domain.evidence, `${path}.evidence`);
    if (Array.isArray(domain.evidence)) {
      for (const evidence of domain.evidence) {
        if (typeof evidence === "string" && evidence.trim() !== "" && isRepositoryPath(evidence)) {
          evidencePaths.add(evidence);
        }
      }
    }
    requireNonEmptyString(domain.notes, "notes", path);
  }
  for (const domain of requiredDomains) {
    if (!seen.has(domain)) {
      errors.push(`${relativePath}: missing required domain ${domain}`);
      everyPassed = false;
    }
  }
  return { everyPassed, evidencePaths };
}

function validateEvidenceDigests(value, evidencePaths, relativePath) {
  if (!isRecord(value)) {
    errors.push(`${relativePath}: evidenceDigests must be an object`);
    return;
  }

  for (const evidence of evidencePaths) {
    if (!(evidence in value)) {
      errors.push(`${relativePath}: missing digest for evidence ${evidence}`);
    }
  }
  for (const evidence of Object.keys(value)) {
    if (!evidencePaths.has(evidence)) {
      errors.push(`${relativePath}: digest has no matching domain evidence: ${evidence}`);
    }
  }

  for (const evidence of evidencePaths) {
    const digest = value[evidence];
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      errors.push(`${relativePath}: evidence digest must be lowercase SHA-256: ${evidence}`);
      continue;
    }
    try {
      if (hasSymlinkedParent(evidence)) {
        errors.push(`${relativePath}: evidence path must not contain symlinks: ${evidence}`);
        continue;
      }
      // Evidence may be newer than the reviewed source baseline, so its content hash—not branch
      // reachability—binds the exact proof while remaining valid after a squash merge.
      if (!lstatSync(join(repoRoot, evidence)).isFile()) {
        errors.push(`${relativePath}: evidence must be a regular file: ${evidence}`);
        continue;
      }
      const actual = createHash("sha256")
        .update(readFileSync(join(repoRoot, evidence)))
        .digest("hex");
      if (actual !== digest) {
        errors.push(`${relativePath}: evidence digest does not match: ${evidence}`);
      }
    } catch {
      // validateEvidence already reports missing paths; keep digest verification fail-closed too.
      errors.push(`${relativePath}: evidence digest could not be verified: ${evidence}`);
    }
  }
}

function validateEvidence(value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path} must be a non-empty array`);
    return;
  }
  for (const evidence of value) {
    if (typeof evidence !== "string" || evidence.trim() === "") {
      errors.push(`${path} must contain non-empty strings`);
    } else if (!isRepositoryPath(evidence)) {
      errors.push(`${path}: evidence must stay inside the repository: ${evidence}`);
    } else if (!existsSync(join(repoRoot, evidence))) {
      errors.push(`${path}: evidence does not exist: ${evidence}`);
    }
  }
}

function validateUnverified(value, relativePath) {
  if (!Array.isArray(value)) {
    errors.push(`${relativePath}: unverified must be an array`);
    return true;
  }
  let hasRequired = false;
  for (const [index, item] of value.entries()) {
    const path = `${relativePath}: unverified.${String(index)}`;
    if (!isRecord(item)) {
      errors.push(`${path} must be an object`);
      hasRequired = true;
      continue;
    }
    validateAllowedFields(item, ["item", "required", "reason"], path);
    requireNonEmptyString(item.item, "item", path);
    requireNonEmptyString(item.reason, "reason", path);
    if (typeof item.required !== "boolean") {
      errors.push(`${path}.required must be a boolean`);
    } else if (item.required) {
      hasRequired = true;
    }
  }
  return hasRequired;
}

function validateAllowedFields(value, allowed, path) {
  const allowedSet = new Set(allowed);
  for (const field of Object.keys(value)) {
    if (!allowedSet.has(field)) {
      errors.push(`${path}: unknown field ${field}`);
    }
  }
}

function validateStringArray(value, field, relativePath, options = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${relativePath}: ${field} must be an array`);
    return;
  }
  if (options.requireNonEmpty && value.length === 0) {
    errors.push(`${relativePath}: ${field} must not be empty`);
  }
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      errors.push(`${relativePath}: ${field} must contain non-empty strings`);
    }
  }
}

function requireNonEmptyString(value, field, relativePath) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${relativePath}: ${field} must be a non-empty string`);
  }
}

function validateTimestamp(value, path) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    errors.push(`${path} must be an ISO 8601 UTC timestamp`);
    return;
  }
  if (Number.isNaN(Date.parse(value))) {
    errors.push(`${path} is not a valid timestamp`);
  }
}

function findSensitiveContent(value, path) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      findSensitiveContent(item, `${path}.${String(index)}`);
    }
    return;
  }
  if (isRecord(value)) {
    for (const [field, item] of Object.entries(value)) {
      const fieldPath = path.endsWith(".json") ? field : `${path}.${field}`;
      if (
        ((path.endsWith(".json") && field === "evidenceDigests") ||
          ((path === "target" || path.endsWith(".target")) && field === "sourceDigests")) &&
        isRecord(item)
      ) {
        // Digest keys are validated repository paths, not schema field names. Security-related
        // evidence may legitimately include words such as secret, token, or credential.
        for (const [evidence, digest] of Object.entries(item)) {
          findSensitiveContent(digest, `${fieldPath}.${evidence}`);
        }
        continue;
      }
      if (sensitiveFieldPattern.test(field)) {
        errors.push(`${path}: sensitive field ${fieldPath} is forbidden`);
      }
      findSensitiveContent(item, fieldPath);
    }
    return;
  }
  if (typeof value === "string") {
    if (machinePathPattern.test(value)) {
      errors.push(`${path}: machine-local path is forbidden`);
    }
    if (secretLikePatterns.some((pattern) => pattern.test(value))) {
      errors.push(`${path}: secret-like value is forbidden`);
    }
    if (accountIdentifierPatterns.some((pattern) => pattern.test(value))) {
      errors.push(`${path}: account identifier is forbidden`);
    }
  }
}

function isRepositoryPath(path) {
  return !(
    isAbsolute(path) ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.split(/[\\/]/).includes("..") ||
    path.startsWith("file:")
  );
}

function hasSymlinkedParent(relativePath) {
  const segments = relativePath.split(/[\\/]/).filter((segment) => segment !== "");
  let current = repoRoot;
  // Checking each parent with lstat prevents an apparently repository-local evidence path from
  // following a directory symlink to generated or machine-local proof outside the checkout.
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function runGit(args) {
  return spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
