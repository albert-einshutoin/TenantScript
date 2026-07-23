import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_EVIDENCE_ITEMS = 50;
const MAX_COUNT = 10_000;
const expectedRootKeys = [
  "decision",
  "gates",
  "kind",
  "repository",
  "schemaVersion",
  "targetVersion"
];
const expectedGateKeys = [
  "advisoryResponses",
  "externalContributors",
  "externalSecurityReview",
  "productionAdopters",
  "releaseBlockers",
  "releaseMaterials",
  "selfHostValidators"
];
const secretLike =
  /(?:bearer\s+|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:token|password|secret|api[_-]?key)\s*[=:])/iu;

function assertPlainObject(value) {
  assert(
    typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactKeys(value, expected) {
  assertPlainObject(value);
  assert.deepEqual(Object.keys(value).sort(), expected);
}

function assertSafeCount(value) {
  assert(Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT);
}

function isPublicHostname(rawHostname) {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/gu, "");
  // Durable release evidence should have a stable DNS identity. Denying every IP literal also
  // closes loopback, private, link-local, documentation, and IPv6-mapped edge cases.
  if (isIP(hostname) !== 0) return false;
  try {
    // WHATWG canonicalization exposes legacy numeric IPv4 spellings such as 127.1.
    if (new URL(`https://${hostname}/`).hostname.toLowerCase() !== hostname) return false;
  } catch {
    return false;
  }
  if (
    !hostname.includes(".") ||
    hostname.endsWith(".") ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/u.test(hostname)
  ) {
    return false;
  }
  return hostname
    .split(".")
    .every((label) => /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/u.test(label));
}

function assertSafeEvidenceReference(reference) {
  assert(typeof reference === "string" && reference.length > 0 && reference.length <= 500);
  assert(!secretLike.test(reference));

  if (reference.startsWith("https://")) {
    const url = new URL(reference);
    assert.equal(url.protocol, "https:");
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert.equal(url.port, "");
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
    assert(isPublicHostname(url.hostname));
    return;
  }

  assert(!/[\\:\u0000-\u001f\u007f]/u.test(reference));
  assert(!isAbsolute(reference));
  assert(!/^(?:[A-Za-z]:|file:|\/|~)/u.test(reference));
  const segments = reference.split("/");
  assert(
    segments.length > 0 &&
      segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function assertEvidence(value) {
  assert(Array.isArray(value) && value.length <= MAX_EVIDENCE_ITEMS);
  assert.equal(new Set(value).size, value.length);
  for (const reference of value) assertSafeEvidenceReference(reference);
}

function validateCountedGate(value, required) {
  assertExactKeys(value, ["evidence", "required", "verified"]);
  assert.equal(value.required, required);
  assertSafeCount(value.verified);
  assertEvidence(value.evidence);
  if (value.verified > 0) assert(value.evidence.length > 0);
}

function validateExternalSecurityReview(value) {
  assertExactKeys(value, ["completed", "criticalOpen", "evidence", "highOpen"]);
  assert.equal(typeof value.completed, "boolean");
  assertEvidence(value.evidence);
  if (value.completed) {
    assertSafeCount(value.criticalOpen);
    assertSafeCount(value.highOpen);
    assert(value.evidence.length > 0);
  } else {
    assert.equal(value.criticalOpen, null);
    assert.equal(value.highOpen, null);
  }
}

function validateReleaseBlockers(value) {
  assertExactKeys(value, ["evidence", "openIssues"]);
  assertEvidence(value.evidence);
  assert(Array.isArray(value.openIssues));
  let previous = 0;
  for (const issue of value.openIssues) {
    assert(Number.isSafeInteger(issue) && issue > previous && issue <= 1_000_000);
    previous = issue;
  }
}

function validateReleaseMaterials(value) {
  assertExactKeys(value, ["announcement", "changelog", "evidence"]);
  assert.equal(typeof value.changelog, "boolean");
  assert.equal(typeof value.announcement, "boolean");
  assertEvidence(value.evidence);
  if (value.changelog || value.announcement) assert(value.evidence.length > 0);
}

function deriveBlockers(gates) {
  // The fixed order makes review diffs and automated failure messages deterministic.
  const blockers = [];
  if (gates.productionAdopters.verified < gates.productionAdopters.required) {
    blockers.push("production-adopters");
  }
  if (gates.externalContributors.verified < gates.externalContributors.required) {
    blockers.push("external-contributors");
  }
  if (gates.advisoryResponses.verified < gates.advisoryResponses.required) {
    blockers.push("advisory-response");
  }
  if (
    !gates.externalSecurityReview.completed ||
    gates.externalSecurityReview.criticalOpen !== 0 ||
    gates.externalSecurityReview.highOpen !== 0
  ) {
    blockers.push("external-security-review");
  }
  if (gates.selfHostValidators.verified < gates.selfHostValidators.required) {
    blockers.push("independent-self-host");
  }
  if (gates.releaseBlockers.openIssues.length > 0) blockers.push("v1-blocker-issues");
  if (!gates.releaseMaterials.changelog || !gates.releaseMaterials.announcement) {
    blockers.push("release-materials");
  }
  return blockers;
}

function validateRecord(record) {
  assertExactKeys(record, expectedRootKeys);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.kind, "tenantscript-v1-launch-readiness");
  assert.equal(record.repository, "albert-einshutoin/TenantScript");
  assert.equal(record.targetVersion, "1.0.0");

  assertExactKeys(record.gates, expectedGateKeys);
  validateCountedGate(record.gates.productionAdopters, 5);
  validateCountedGate(record.gates.externalContributors, 10);
  validateCountedGate(record.gates.advisoryResponses, 1);
  validateExternalSecurityReview(record.gates.externalSecurityReview);
  validateCountedGate(record.gates.selfHostValidators, 2);
  validateReleaseBlockers(record.gates.releaseBlockers);
  validateReleaseMaterials(record.gates.releaseMaterials);

  assertExactKeys(record.decision, ["blockers", "status"]);
  const blockers = deriveBlockers(record.gates);
  assert.deepEqual(record.decision.blockers, blockers);
  assert.equal(record.decision.status, blockers.length === 0 ? "approved" : "blocked");
}

export function validateV1LaunchReadiness(record, { requireApproved = false } = {}) {
  try {
    assert.equal(typeof requireApproved, "boolean");
    validateRecord(record);
  } catch {
    throw new Error("v1 launch readiness record is invalid");
  }
  if (requireApproved && record.decision.status !== "approved") {
    throw new Error("v1 launch readiness is not approved");
  }
  return structuredClone(record);
}

function toPath(value) {
  return value instanceof URL ? fileURLToPath(value) : resolve(value);
}

function assertBoundedRegularFile(path) {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  assert(stat.size > 0 && stat.size <= MAX_RECORD_BYTES);
}

function assertRepositoryFile(root, path) {
  const rootStat = lstatSync(root);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink());
  const fromRoot = relative(root, path);
  assert(
    fromRoot !== "" &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot)
  );
  const segments = fromRoot.split(sep);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    const stat = lstatSync(current);
    assert(!stat.isSymbolicLink());
    if (index === segments.length - 1) {
      assertBoundedRegularFile(current);
    } else {
      assert(stat.isDirectory());
    }
  }
}

function allEvidence(record) {
  return Object.values(record.gates).flatMap((gate) => gate.evidence);
}

export function readV1LaunchReadiness(pathInput, { repositoryRoot, requireApproved = false } = {}) {
  try {
    assert(repositoryRoot !== undefined);
    const recordPath = toPath(pathInput);
    const root = toPath(repositoryRoot);
    assertRepositoryFile(root, recordPath);
    const record = validateV1LaunchReadiness(JSON.parse(readFileSync(recordPath, "utf8")), {
      requireApproved
    });
    for (const reference of allEvidence(record)) {
      if (reference.startsWith("https://")) continue;
      const evidencePath = resolve(root, reference);
      assertRepositoryFile(root, evidencePath);
    }
    return record;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "v1 launch readiness is not approved" ||
        error.message === "v1 launch readiness record is invalid")
    ) {
      throw error;
    }
    throw new Error("v1 launch readiness record is invalid");
  }
}

function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "check") {
    throw new Error("invalid command");
  }
  const record = readV1LaunchReadiness(process.argv[3], {
    repositoryRoot: process.cwd()
  });
  console.log(
    JSON.stringify({
      targetVersion: record.targetVersion,
      status: record.decision.status,
      blockers: record.decision.blockers
    })
  );
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch {
    console.error("v1 launch readiness check failed");
    process.exitCode = 1;
  }
}
