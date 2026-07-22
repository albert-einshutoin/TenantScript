import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute, relative, resolve, sep } from "node:path";

const repoRoot = resolve(process.argv[2] ?? process.cwd());
const submissionsRoot = resolve(repoRoot, "templates", "submissions");
const canonicalRepositoryIdentity = "github.com/albert-einshutoin/tenantscript";
const maximumSubmissionBytes = 256 * 1024;
const maximumEvidenceBytes = 1024 * 1024;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hookNamePattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const exactSemverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const caretRangePattern = /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaPattern = /^(?!0{40}$)[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const capabilityPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const configKeyPattern = /^[A-Za-z][A-Za-z0-9]*$/;
const hostPattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const urlLikePattern = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/giu;
const requiredSourceSuffixes = [
  "package.json",
  "src/index.ts",
  "src/manifest.ts",
  "test/plugin.test.ts"
];
const unsafePackageManagerControlNames = new Set([
  ".npmrc",
  ".pnpmfile.cjs",
  ".pnpmfile.mjs",
  "pnpm-workspace.yaml",
  "pnpm-workspace.yml"
]);
const installLifecycleScripts = new Set(["preinstall", "install", "postinstall", "prepare"]);
const topLevelFields = [
  "schemaVersion",
  "kind",
  "slug",
  "displayName",
  "summary",
  "license",
  "source",
  "sdk",
  "hook",
  "capabilities",
  "egress",
  "configKeys",
  "verification",
  "reviewRecord",
  "securityNote",
  "nonGuarantees"
];
const expectedCommands = {
  build: "pnpm build",
  test: "pnpm test",
  audit: "ext audit --manifest ./manifest.json --package ./package.json --bundle ./dist/plugin.cjs"
};
const secretLikePatterns = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
  /\b(?:cloudflare[_ -]?)?account[_-]?id\s*[:=]\s*["']?[0-9a-f]{32}\b/i,
  /\b[0-9a-f]{32}\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:tenant|customer)_[A-Za-z0-9_-]{4,}\b/i,
  /dash\.cloudflare\.com\/[0-9a-f]{16,}/i,
  // File URLs and Markdown punctuation can prefix absolute paths and must not bypass redaction.
  /(?:file:\/\/(?:localhost)?\/|(?:^|[^A-Za-z0-9])\/)(?:Users|Volumes|home|workspace|root|tmp)\/|[A-Za-z]:\\Users\\/i
];
const sensitiveFieldPattern = /(?:token|secret|credential|password|account.?id)/i;
const prohibitedGuaranteePattern =
  /\b(?:certified|certification|vulnerability[- ]free|guaranteed safe)\b/i;
const errors = [];
const seenSlugs = new Set();
let submissionCount = 0;

if (!existsSync(submissionsRoot)) {
  errors.push("templates/submissions: directory is missing");
} else {
  const entries = readdirSync(submissionsRoot, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  for (const entry of entries) {
    if (!entry.isDirectory() || !slugPattern.test(entry.name)) {
      errors.push("templates/submissions: directory name is invalid");
      continue;
    }
    validateSubmission(entry.name);
  }
  if (submissionCount === 0) {
    errors.push("templates/submissions: at least one submission is required");
  }
}

if (errors.length > 0) {
  process.stderr.write(`${[...new Set(errors)].sort().join("\n")}\n`);
  process.exitCode = 1;
} else {
  const noun = submissionCount === 1 ? "submission" : "submissions";
  process.stdout.write(`Template submission check passed (${String(submissionCount)} ${noun}).\n`);
}

function validateSubmission(directoryName) {
  submissionCount += 1;
  const displayPath = `templates/submissions/${directoryName}/submission.json`;
  const absolutePath = resolve(submissionsRoot, directoryName, "submission.json");
  let submission;
  try {
    const metadata = lstatSync(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("invalid file");
    if (metadata.size > maximumSubmissionBytes) {
      errors.push(`${displayPath}: JSON exceeds the 256 KiB limit`);
      return;
    }
    submission = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch {
    errors.push(`${displayPath}: invalid or missing JSON`);
    return;
  }
  if (!isRecord(submission)) {
    errors.push(`${displayPath}: submission must be a JSON object`);
    return;
  }

  validateAllowedFields(submission, topLevelFields, displayPath);
  for (const field of topLevelFields) {
    if (!(field in submission)) errors.push(`${displayPath}: missing field ${field}`);
  }
  if (containsSensitiveContent(submission)) {
    errors.push(`${displayPath}: sensitive or private content is not allowed`);
  }
  if (
    (typeof submission.displayName === "string" &&
      prohibitedGuaranteePattern.test(submission.displayName)) ||
    (typeof submission.summary === "string" && prohibitedGuaranteePattern.test(submission.summary))
  ) {
    errors.push(`${displayPath}: prohibited guarantee language is not allowed`);
  }

  if (submission.schemaVersion !== 1) {
    errors.push(`${displayPath}: schemaVersion must be 1`);
  }
  if (submission.kind !== "community" && submission.kind !== "simulation") {
    errors.push(`${displayPath}: kind is invalid`);
  }
  if (typeof submission.slug !== "string" || !slugPattern.test(submission.slug)) {
    errors.push(`${displayPath}: slug is invalid`);
  } else {
    if (submission.slug !== directoryName) {
      errors.push(`${displayPath}: slug must match its directory`);
    }
    if (seenSlugs.has(submission.slug)) {
      errors.push("templates/submissions: duplicate slug");
    }
    seenSlugs.add(submission.slug);
  }
  validateBoundedString(submission.displayName, 80, "displayName", displayPath);
  validateBoundedString(submission.summary, 240, "summary", displayPath);
  validateBoundedString(submission.license, 80, "license", displayPath);
  validateSource(submission.source, submission.sdk, submission.license, directoryName, displayPath);
  validateSdk(submission.sdk, displayPath);
  validateHook(submission.hook, displayPath);
  validateSortedStrings(submission.capabilities, "capabilities", displayPath, capabilityPattern);
  validateEgress(submission.egress, displayPath);
  validateSortedStrings(submission.configKeys, "configKeys", displayPath, configKeyPattern);
  validateVerification(submission.verification, displayPath);
  validateReviewRecord(submission.reviewRecord, submission.source, displayPath);
  validateSafeReference(submission.securityNote, "securityNote", displayPath);
  validateNonGuarantees(submission.nonGuarantees, displayPath);
}

function validateSource(value, sdk, license, directoryName, displayPath) {
  if (!isRecord(value)) {
    errors.push(`${displayPath}: source must be an object`);
    return;
  }
  validateAllowedFields(value, ["repository", "revision", "directory", "files"], displayPath, {
    prefix: "source."
  });
  if (!isPublicRepositoryUrl(value.repository)) {
    errors.push(`${displayPath}: source.repository must be a public HTTPS repository URL`);
  }
  const revisionIsValid = typeof value.revision === "string" && shaPattern.test(value.revision);
  if (!revisionIsValid) {
    errors.push(`${displayPath}: source.revision must be a full commit SHA`);
  }
  const expectedDirectory = `templates/submissions/${directoryName}/plugin`;
  if (
    typeof value.directory !== "string" ||
    !isRepositoryPath(value.directory) ||
    value.directory !== expectedDirectory
  ) {
    errors.push(`${displayPath}: source.directory must stay inside the repository`);
  }
  if (!isRecord(value.files) || Object.keys(value.files).length === 0) {
    errors.push(`${displayPath}: source.files must be a non-empty digest map`);
    return;
  }
  const filePaths = Object.keys(value.files);
  if (!isSortedUnique(filePaths)) {
    errors.push(`${displayPath}: source.files must be sorted and unique`);
  }
  const copiedSourcePaths =
    value.directory === expectedDirectory ? listRegularSourceFiles(value.directory) : undefined;
  if (copiedSourcePaths === undefined) {
    errors.push(`${displayPath}: source.directory must contain only bounded regular files`);
  } else if (!sameStringArray(filePaths, copiedSourcePaths)) {
    errors.push(`${displayPath}: source.files must cover every regular file in source.directory`);
  }
  if (
    copiedSourcePaths?.some((path) =>
      unsafePackageManagerControlNames.has(path.split("/").at(-1) ?? "")
    )
  ) {
    // Install-time package-manager hooks execute before the audited manifest and bundle are read,
    // so digest-binding them is insufficient; submissions must not carry this control surface.
    errors.push(`${displayPath}: source.directory contains a package-manager control file`);
  }
  for (const suffix of requiredSourceSuffixes) {
    const requiredPath =
      typeof value.directory === "string" ? `${value.directory}/${suffix}` : suffix;
    if (!(requiredPath in value.files)) {
      errors.push(`${displayPath}: source.files is missing a required plugin file`);
    }
  }
  for (const path of filePaths) {
    const digest = value.files[path];
    if (
      typeof value.directory !== "string" ||
      !path.startsWith(`${value.directory}/`) ||
      !isRepositoryPath(path)
    ) {
      errors.push(`${displayPath}: source file path must stay inside source.directory`);
      continue;
    }
    if (typeof digest !== "string" || !digestPattern.test(digest)) {
      errors.push(`${displayPath}: source file digest must be lowercase SHA-256`);
      continue;
    }
    const current = readRegularRepositoryFile(path);
    if (current === undefined || sha256(current) !== digest) {
      errors.push(`${displayPath}: source file digest does not match`);
      continue;
    }
    if (containsSensitiveFileContent(current)) {
      errors.push(`${displayPath}: source file contains sensitive or private content`);
      continue;
    }
    const revisionMatch =
      revisionIsValid && repositoryIdentity(value.repository) === canonicalRepositoryIdentity
        ? matchesGitRevision(value.revision, path, digest)
        : undefined;
    if (revisionMatch === false) {
      errors.push(`${displayPath}: source revision does not contain the reviewed file digest`);
    }
  }
  if (typeof value.directory === "string" && typeof license === "string") {
    const packageContent = readRegularRepositoryFile(`${value.directory}/package.json`);
    if (packageContent !== undefined) {
      try {
        const packageJson = JSON.parse(packageContent.toString("utf8"));
        if (!isRecord(packageJson) || packageJson.license !== license) {
          errors.push(`${displayPath}: license must match source package metadata`);
        }
        if (
          isRecord(packageJson) &&
          isRecord(packageJson.scripts) &&
          Object.keys(packageJson.scripts).some((name) => installLifecycleScripts.has(name))
        ) {
          // These hooks run on downstream installation while CI intentionally disables them, so an
          // accepted template must not contain behavior that the audited path never exercises.
          errors.push(`${displayPath}: source package must not define install lifecycle scripts`);
        }
        if (isRecord(packageJson) && packageJson.pnpm !== undefined) {
          // The E2E adds its own local-tarball overrides after validation. Submitted pnpm settings
          // would otherwise be overwritten and escape the exact dependency graph being audited.
          errors.push(`${displayPath}: source package must not define package-manager settings`);
        }
        const dependencies = isRecord(packageJson) ? packageJson.dependencies : undefined;
        const testedVersion = isRecord(sdk) ? sdk.lastTestedVersion : undefined;
        if (
          typeof testedVersion !== "string" ||
          !isRecord(dependencies) ||
          dependencies["@tenantscript/manifest"] !== testedVersion ||
          dependencies["@tenantscript/plugin-sdk"] !== testedVersion
        ) {
          errors.push(
            `${displayPath}: source package SDK dependencies must match sdk.lastTestedVersion`
          );
        }
      } catch {
        errors.push(`${displayPath}: source package metadata is invalid`);
      }
    }
  }
}

function validateSdk(value, displayPath) {
  if (!isRecord(value)) {
    errors.push(`${displayPath}: sdk must be an object`);
    return;
  }
  validateAllowedFields(value, ["range", "lastTestedVersion"], displayPath, { prefix: "sdk." });
  const rangeMatch = typeof value.range === "string" ? value.range.match(caretRangePattern) : null;
  if (rangeMatch === null) {
    errors.push(`${displayPath}: sdk.range must be a pinned caret range`);
  }
  const versionMatch =
    typeof value.lastTestedVersion === "string"
      ? value.lastTestedVersion.match(exactSemverPattern)
      : null;
  if (versionMatch === null) {
    errors.push(`${displayPath}: sdk.lastTestedVersion must be exact semver`);
  }
  const safeComponents =
    rangeMatch !== null &&
    versionMatch !== null &&
    [...rangeMatch.slice(1), ...versionMatch.slice(1)].every((part) =>
      Number.isSafeInteger(Number(part))
    );
  if (rangeMatch !== null && versionMatch !== null && !safeComponents) {
    errors.push(`${displayPath}: sdk versions must use safe integer components`);
  } else if (
    rangeMatch !== null &&
    versionMatch !== null &&
    !satisfiesCaret(rangeMatch, versionMatch)
  ) {
    errors.push(`${displayPath}: sdk.lastTestedVersion must satisfy sdk.range`);
  }
}

function validateHook(value, displayPath) {
  if (!isRecord(value)) {
    errors.push(`${displayPath}: hook must be an object`);
    return;
  }
  validateAllowedFields(value, ["name", "type"], displayPath, { prefix: "hook." });
  if (typeof value.name !== "string" || !hookNamePattern.test(value.name)) {
    errors.push(`${displayPath}: hook.name is invalid`);
  }
  if (!new Set(["event", "transform", "policy"]).has(value.type)) {
    errors.push(`${displayPath}: hook.type is invalid`);
  }
}

function validateEgress(value, displayPath) {
  if (!isRecord(value)) {
    errors.push(`${displayPath}: egress must be an object`);
    return;
  }
  validateAllowedFields(value, ["mode", "allowHosts"], displayPath, { prefix: "egress." });
  if (value.mode !== "deny" && value.mode !== "allowlist") {
    errors.push(`${displayPath}: egress.mode is invalid`);
  }
  validateSortedStrings(value.allowHosts, "egress.allowHosts", displayPath, hostPattern);
  if (
    Array.isArray(value.allowHosts) &&
    value.allowHosts.some(
      (host) => typeof host === "string" && !isPublicHostname(host.toLowerCase())
    )
  ) {
    // Egress allowlists are runtime SSRF boundaries, so they use the same fail-closed public-host
    // policy as immutable source provenance rather than accepting syntactically valid local names.
    errors.push(`${displayPath}: egress.allowHosts must contain only public DNS hosts`);
  }
  if (value.mode === "deny" && Array.isArray(value.allowHosts) && value.allowHosts.length > 0) {
    errors.push(`${displayPath}: deny egress requires an empty allowHosts`);
  }
  if (
    value.mode === "allowlist" &&
    Array.isArray(value.allowHosts) &&
    value.allowHosts.length === 0
  ) {
    errors.push(`${displayPath}: allowlist egress requires at least one host`);
  }
}

function validateVerification(value, displayPath) {
  if (!isRecord(value)) {
    errors.push(`${displayPath}: verification must be an object`);
    return;
  }
  validateAllowedFields(value, ["commands", "evidence"], displayPath, {
    prefix: "verification."
  });
  if (!isRecord(value.commands)) {
    errors.push(`${displayPath}: verification.commands must be an object`);
  } else {
    validateAllowedFields(value.commands, Object.keys(expectedCommands), displayPath, {
      prefix: "verification.commands."
    });
    for (const [name, command] of Object.entries(expectedCommands)) {
      if (value.commands[name] !== command) {
        errors.push(`${displayPath}: verification.commands.${name} must use the canonical command`);
      }
    }
  }
  validateSortedStrings(value.evidence, "verification.evidence", displayPath);
  if (Array.isArray(value.evidence) && value.evidence.length === 0) {
    errors.push(`${displayPath}: verification.evidence must not be empty`);
  }
  if (Array.isArray(value.evidence)) {
    for (const evidence of value.evidence) {
      if (typeof evidence !== "string" || !isRepositoryPath(evidence)) {
        errors.push(`${displayPath}: verification.evidence must stay inside the repository`);
      } else {
        const content = readRegularRepositoryFile(evidence);
        if (content === undefined) {
          errors.push(`${displayPath}: verification.evidence must reference a regular file`);
        } else if (containsSensitiveFileContent(content)) {
          errors.push(
            `${displayPath}: verification.evidence contains sensitive or private content`
          );
        }
      }
    }
  }
}

function validateReviewRecord(value, source, displayPath) {
  if (
    typeof value !== "string" ||
    !/^docs\/security\/plugin-reviews\/TS-PLUGIN-REVIEW-\d{4}-\d{3}\.json$/u.test(value)
  ) {
    errors.push(`${displayPath}: reviewRecord must use the canonical review directory`);
  }
  const content = validateRegularReference(value, "reviewRecord", displayPath);
  if (content === undefined) return;
  try {
    const record = JSON.parse(content.toString("utf8"));
    if (!isRecord(record) || record.decision !== "approve") {
      errors.push(`${displayPath}: reviewRecord must contain an approve decision`);
      return;
    }
    if (
      !isRecord(source) ||
      !isRecord(source.files) ||
      !isRecord(record.target) ||
      !sameStringArray(record.target.scope, Object.keys(source.files)) ||
      !sameDigestMap(record.target.sourceDigests, source.files)
    ) {
      errors.push(
        `${displayPath}: reviewRecord source scope and digests must match submission.source`
      );
    }
  } catch {
    errors.push(`${displayPath}: reviewRecord must contain valid JSON`);
  }
}

function validateRegularReference(value, field, displayPath) {
  if (typeof value !== "string" || !isRepositoryPath(value)) {
    errors.push(`${displayPath}: ${field} must stay inside the repository`);
    return undefined;
  }
  const content = readRegularRepositoryFile(value);
  if (content === undefined) {
    errors.push(`${displayPath}: ${field} must reference a regular file`);
  }
  return content;
}

function validateSafeReference(value, field, displayPath) {
  const content = validateRegularReference(value, field, displayPath);
  if (content !== undefined && containsSensitiveFileContent(content)) {
    errors.push(`${displayPath}: ${field} contains sensitive or private content`);
  }
  return content;
}

function validateNonGuarantees(value, displayPath) {
  validateSortedStrings(value, "nonGuarantees", displayPath);
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${displayPath}: nonGuarantees must not be empty`);
    return;
  }
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "" || item.length > 240) {
      errors.push(`${displayPath}: nonGuarantees entries must be bounded strings`);
    }
  }
}

function validateAllowedFields(value, allowed, displayPath, options = {}) {
  const prefix = options.prefix ?? "";
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) {
      const fieldPath = `${prefix}${field}`;
      const safeField = /^[A-Za-z][A-Za-z0-9.]{0,80}$/.test(fieldPath) ? ` ${fieldPath}` : "";
      errors.push(`${displayPath}: unknown field${safeField}`);
    }
  }
  for (const field of allowed) {
    if (!(field in value)) errors.push(`${displayPath}: missing field ${prefix}${field}`);
  }
}

function validateBoundedString(value, maximum, field, displayPath) {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    errors.push(`${displayPath}: ${field} must be a bounded non-empty string`);
  }
}

function validateSortedStrings(value, field, displayPath, pattern) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    errors.push(`${displayPath}: ${field} must be an array of strings`);
    return;
  }
  if (!isSortedUnique(value)) {
    errors.push(`${displayPath}: ${field} must be sorted and unique`);
  }
  if (pattern !== undefined && value.some((item) => !pattern.test(item))) {
    errors.push(`${displayPath}: ${field} contains an invalid value`);
  }
}

function isSortedUnique(value) {
  return value.every((item, index) => index === 0 || value[index - 1] < item);
}

function sameStringArray(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameDigestMap(left, right) {
  if (!isRecord(left) || !isRecord(right)) return false;
  const paths = Object.keys(right);
  return (
    Object.keys(left).length === paths.length && paths.every((path) => left[path] === right[path])
  );
}

function isPublicRepositoryUrl(value) {
  return repositoryIdentity(value) !== undefined;
}

function repositoryIdentity(value) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname.includes("%") ||
      !isPublicHostname(hostname)
    ) {
      return undefined;
    }
    const pathname = url.pathname.replace(/\/+$/u, "").replace(/\.git$/iu, "");
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length < 2) return undefined;
    // GitHub adds tree/blob segments for browser pages; accepting them would change repository
    // identity and skip the stronger revision-to-digest check for repository-owned submissions.
    if (hostname === "github.com" && segments.length !== 2) return undefined;
    return `${hostname}/${segments.map((segment) => segment.toLowerCase()).join("/")}`;
  } catch {
    return undefined;
  }
}

function isPublicHostname(hostname) {
  const ipVersion = isIP(hostname);
  if (ipVersion !== 0) {
    // Public repository provenance should use a stable DNS identity. Rejecting every IP literal also
    // avoids loopback, private, link-local, documentation, and IPv6-mapped address edge cases.
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

function isRepositoryPath(value) {
  if (
    typeof value !== "string" ||
    value === "" ||
    isAbsolute(value) ||
    /[\\:\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }
  const absolute = resolve(repoRoot, value);
  const pathFromRoot = relative(repoRoot, absolute);
  return pathFromRoot !== "" && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`);
}

function readRegularRepositoryFile(path) {
  if (!isRepositoryPath(path) || hasSymlinkedParent(path)) return undefined;
  try {
    const absolute = resolve(repoRoot, path);
    const metadata = lstatSync(absolute);
    if (!metadata.isFile() || metadata.size > maximumEvidenceBytes) return undefined;
    return readFileSync(absolute);
  } catch {
    return undefined;
  }
}

function listRegularSourceFiles(directory) {
  if (!isRepositoryPath(directory) || hasSymlinkedParent(directory)) return undefined;
  const pending = [directory];
  const files = [];
  let entryCount = 0;
  try {
    if (!lstatSync(resolve(repoRoot, directory)).isDirectory()) return undefined;
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      const entries = readdirSync(resolve(repoRoot, current), { withFileTypes: true }).sort(
        (left, right) => left.name.localeCompare(right.name)
      );
      for (const entry of entries) {
        entryCount += 1;
        if (entryCount > 256) return undefined;
        const path = `${current}/${entry.name}`;
        const metadata = lstatSync(resolve(repoRoot, path));
        if (metadata.isSymbolicLink()) return undefined;
        if (metadata.isDirectory()) pending.push(path);
        else if (metadata.isFile()) files.push(path);
        else return undefined;
      }
    }
  } catch {
    return undefined;
  }
  return files.sort();
}

function hasSymlinkedParent(path) {
  const segments = path.split("/");
  let current = repoRoot;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function matchesGitRevision(revision, path, digest) {
  const commitCheck = runGit(["cat-file", "-e", `${revision}^{commit}`]);
  // A squash merge intentionally removes PR-local commits from the public ancestry. The digest map
  // remains the enforceable provenance boundary, while an available object receives an extra check.
  if (commitCheck.status !== 0) return undefined;
  const result = runGit(["show", `${revision}:${path}`], { encoding: "buffer" });
  return result.status === 0 && sha256(result.stdout) === digest;
}

function runGit(args, options = {}) {
  return spawnSync("git", args, {
    cwd: repoRoot,
    encoding: options.encoding === "buffer" ? null : "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function satisfiesCaret(rangeMatch, versionMatch) {
  const base = rangeMatch.slice(1).map(Number);
  const version = versionMatch.slice(1).map(Number);
  const [major, minor, patch] = base;
  const [versionMajor, versionMinor, versionPatch] = version;
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    versionMajor === undefined ||
    versionMinor === undefined ||
    versionPatch === undefined
  ) {
    return false;
  }
  const atLeastBase = compareSemver(version, base) >= 0;
  if (!atLeastBase) return false;
  if (major > 0) return versionMajor === major;
  if (minor > 0) return versionMajor === 0 && versionMinor === minor;
  return versionMajor === 0 && versionMinor === 0 && versionPatch === patch;
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function containsSensitiveContent(value) {
  // Iteration keeps an adversarially deep JSON object from exhausting the Node.js call stack.
  const pending = [{ field: "", parentField: "", skipFieldCheck: false, value }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (!current.skipFieldCheck && sensitiveFieldPattern.test(current.field)) return true;
    if (typeof current.value === "string") {
      if (
        secretLikePatterns.some((pattern) => pattern.test(current.value)) ||
        containsPrivateUrl(current.value)
      ) {
        return true;
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        pending.push({
          field: "",
          parentField: current.field,
          skipFieldCheck: false,
          value: child
        });
      }
      continue;
    }
    if (isRecord(current.value)) {
      // source.files keys are repository paths, not user-defined JSON field names. Their referenced
      // contents are scanned separately after digest verification, so only the path-key heuristic is
      // skipped here while every digest value and nested field remains subject to content checks.
      const childrenAreDigestMapPaths =
        current.parentField === "source" && current.field === "files";
      for (const [field, child] of Object.entries(current.value)) {
        pending.push({
          field,
          parentField: current.field,
          skipFieldCheck: childrenAreDigestMapPaths,
          value: child
        });
      }
    }
  }
  return false;
}

function containsSensitiveFileContent(content) {
  const text = content.toString("utf8");
  return secretLikePatterns.some((pattern) => pattern.test(text)) || containsPrivateUrl(text);
}

function containsPrivateUrl(text) {
  for (const match of text.matchAll(urlLikePattern)) {
    try {
      const url = new URL(match[0]);
      const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
      // Evidence must use durable public hosts. Credentials, local DNS, and IP literals are private
      // provenance even when embedded in otherwise harmless Markdown prose.
      if (url.username !== "" || url.password !== "" || !isPublicHostname(hostname)) return true;
    } catch {
      // Invalid URL-like text is handled by the surrounding field/path validation where applicable.
    }
  }
  return false;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
