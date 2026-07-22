import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const write = args.includes("--write");
const positional = args.filter((argument) => argument !== "--write");

if (
  positional.length > 1 ||
  args.some((argument) => argument.startsWith("--") && argument !== "--write")
) {
  fail("usage: generate-template-catalog.mjs [repository-root] [--write]");
}

const repoRoot = resolve(positional[0] ?? process.cwd());
validateRepositoryInput("check-template-submissions.mjs", "template submissions are invalid");
validateRepositoryInput("check-plugin-review-records.mjs", "plugin review records are invalid");

const submissionsRoot = join(repoRoot, "templates", "submissions");
const entries = readdirSync(submissionsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const templates = entries.map((directory) => {
  const submission = readJson(join(submissionsRoot, directory, "submission.json"));
  const review = readJson(join(repoRoot, submission.reviewRecord));
  validateApprovedReview(review);

  // Submission packets contain reviewer identity and evidence paths that gallery consumers neither
  // need nor should become coupled to. Project only the already-validated public compatibility data.
  return {
    slug: submission.slug,
    displayName: submission.displayName,
    summary: submission.summary,
    license: submission.license,
    provenance: submission.kind,
    source: {
      repository: new URL(submission.source.repository).href,
      revision: submission.source.revision
    },
    sdk: {
      range: submission.sdk.range,
      lastTestedVersion: submission.sdk.lastTestedVersion
    },
    hook: {
      name: submission.hook.name,
      type: submission.hook.type
    },
    capabilities: [...submission.capabilities],
    egress: { mode: "deny" },
    configKeys: [...submission.configKeys],
    review: { decision: "approve" }
  };
});

const output = `${JSON.stringify({ schemaVersion: 1, templates }, null, 2)}\n`;
const catalogPath = join(repoRoot, "templates", "catalog.json");

if (write) {
  let metadata;
  try {
    metadata = lstatSync(catalogPath);
  } catch (error) {
    if (typeof error !== "object" || error === null || error.code !== "ENOENT") {
      fail("template catalog path is unsafe");
    }
  }
  if (metadata !== undefined && (!metadata.isFile() || metadata.isSymbolicLink())) {
    fail("template catalog path is unsafe");
  }
  writeFileSync(catalogPath, output, { encoding: "utf8", mode: 0o644 });
  process.stdout.write(`Template catalog written (${String(templates.length)} templates).\n`);
} else {
  let current;
  try {
    const metadata = lstatSync(catalogPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("unsafe");
    current = readFileSync(catalogPath, "utf8");
  } catch {
    fail("template catalog is missing or stale");
  }
  if (current !== output) fail("template catalog is missing or stale");
  process.stdout.write(`Template catalog check passed (${String(templates.length)} templates).\n`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("template catalog input is invalid");
  }
}

function validateRepositoryInput(script, errorMessage) {
  const checker = spawnSync(process.execPath, [join(scriptDirectory, script), repoRoot], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" }
  });
  if (checker.status !== 0) fail(errorMessage);
}

function validateApprovedReview(review) {
  const requiredDomains = ["compatibility", "documentation", "license", "operations", "security"];
  const domains = Array.isArray(review?.domains)
    ? review.domains.map((domain) => domain?.name).sort()
    : [];
  if (
    review?.decision !== "approve" ||
    !Array.isArray(review.blockingFindings) ||
    review.blockingFindings.length !== 0 ||
    JSON.stringify(domains) !== JSON.stringify(requiredDomains) ||
    review.domains.some((domain) => domain?.status !== "pass")
  ) {
    fail("template submissions are invalid");
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
