import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = join(repoRoot, "scripts", "generate-template-catalog.mjs");

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "tenantscript-template-catalog-"));
  try {
    cpSync(join(repoRoot, "templates", "submissions"), join(root, "templates", "submissions"), {
      recursive: true
    });
    mkdirSync(join(root, "docs", "security", "plugin-reviews"), { recursive: true });
    const submissionPath = join(
      root,
      "templates/submissions/ticket-priority-normalizer/submission.json"
    );
    const submission = JSON.parse(readFileSync(submissionPath, "utf8"));
    submission.kind = "community";
    submission.source.repository = "https://github.com/community/template-example";
    writeFileSync(submissionPath, `${JSON.stringify(submission, null, 2)}\n`);
    initializeFixtureReview(root, submission);
    run({ root, submission });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function initializeFixtureReview(root, submission) {
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.name", "TenantScript Test"],
    ["config", "user.email", "test@example.com"],
    ["add", "templates/submissions"],
    ["commit", "--quiet", "-m", "fixture"]
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const baseline = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  assert.equal(baseline.status, 0, baseline.stderr);
  const evidencePath = Object.keys(submission.source.files)[0];
  const review = {
    schemaVersion: 1,
    id: "TS-PLUGIN-REVIEW-2026-002",
    baselineCommit: baseline.stdout.trim(),
    target: {
      name: "Fixture template review",
      scope: Object.keys(submission.source.files),
      sourceDigests: submission.source.files
    },
    reviewer: { identity: "Fixture reviewer", relationship: "Test-only review" },
    reviewedAt: "2026-07-22T00:00:00.000Z",
    domains: ["security", "compatibility", "operations", "documentation", "license"].map(
      (name) => ({ name, status: "pass", evidence: [evidencePath], notes: "Fixture evidence" })
    ),
    evidenceDigests: { [evidencePath]: submission.source.files[evidencePath] },
    decision: "approve",
    blockingFindings: [],
    unverified: [],
    limitations: ["Fixture-only review"],
    nonGuarantees: ["Not a production claim"]
  };
  writeFileSync(join(root, submission.reviewRecord), `${JSON.stringify(review, null, 2)}\n`);
}

function runGenerator(root, ...args) {
  return spawnSync(process.execPath, [generatorPath, root, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" }
  });
}

function cloneSubmission(root, submission, slug, reviewNumber) {
  const originalSlug = submission.slug;
  const originalPacket = join(root, "templates", "submissions", originalSlug);
  const clonedPacket = join(root, "templates", "submissions", slug);
  cpSync(originalPacket, clonedPacket, { recursive: true });

  const clonedSubmissionPath = join(clonedPacket, "submission.json");
  const clonedSubmission = JSON.parse(
    readFileSync(clonedSubmissionPath, "utf8").replaceAll(originalSlug, slug)
  );
  clonedSubmission.slug = slug;
  clonedSubmission.displayName = `Template ${slug}`;
  clonedSubmission.reviewRecord = `docs/security/plugin-reviews/TS-PLUGIN-REVIEW-2026-${reviewNumber}.json`;
  writeFileSync(clonedSubmissionPath, `${JSON.stringify(clonedSubmission, null, 2)}\n`);

  const originalReviewPath = join(root, submission.reviewRecord);
  const clonedReviewPath = join(root, clonedSubmission.reviewRecord);
  const clonedReview = readFileSync(originalReviewPath, "utf8").replaceAll(originalSlug, slug);
  writeFileSync(clonedReviewPath, clonedReview);
}

test("writes a deterministic minimal compatibility catalog from approved submissions", () => {
  withFixture(({ root, submission }) => {
    const first = runGenerator(root, "--write");
    assert.equal(first.status, 0, first.stderr);
    const catalogPath = join(root, "templates", "catalog.json");
    const firstBytes = readFileSync(catalogPath, "utf8");
    const catalog = JSON.parse(firstBytes);

    assert.deepEqual(catalog, {
      schemaVersion: 1,
      templates: [
        {
          slug: submission.slug,
          displayName: submission.displayName,
          summary: submission.summary,
          license: submission.license,
          provenance: "community",
          source: {
            repository: submission.source.repository,
            revision: submission.source.revision
          },
          sdk: submission.sdk,
          hook: submission.hook,
          capabilities: submission.capabilities,
          egress: { mode: "deny" },
          configKeys: submission.configKeys,
          review: { decision: "approve" }
        }
      ]
    });
    assert.equal(firstBytes.endsWith("\n"), true);
    assert.doesNotMatch(
      firstBytes,
      /reviewRecord|securityNote|verification|reviewer|evidence|\/Users\/|\/Volumes\//
    );

    const second = runGenerator(root, "--write");
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(catalogPath, "utf8"), firstBytes);
  });
});

test("fails closed when the committed catalog is missing or stale", () => {
  withFixture(({ root }) => {
    const missing = runGenerator(root);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /template catalog is missing or stale/);

    assert.equal(runGenerator(root, "--write").status, 0);
    const catalogPath = join(root, "templates", "catalog.json");
    rmSync(catalogPath);
    symlinkSync(
      join(root, "templates/submissions/ticket-priority-normalizer/submission.json"),
      catalogPath
    );
    const symlinked = runGenerator(root);
    assert.equal(symlinked.status, 1);
    assert.match(symlinked.stderr, /template catalog is missing or stale/);
    rmSync(catalogPath);
    const danglingTarget = join(root, "outside-catalog.json");
    symlinkSync(danglingTarget, catalogPath);
    const danglingWrite = runGenerator(root, "--write");
    assert.equal(danglingWrite.status, 1);
    assert.match(danglingWrite.stderr, /template catalog path is unsafe/);
    assert.equal(existsSync(danglingTarget), false);
    unlinkSync(catalogPath);
    const rewritten = runGenerator(root, "--write");
    assert.equal(rewritten.status, 0, rewritten.stderr);
    writeFileSync(catalogPath, '{"schemaVersion":1,"templates":[]}\n');
    const stale = runGenerator(root);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /template catalog is missing or stale/);
  });
});

test("sorts every discovered submission by slug", () => {
  withFixture(({ root, submission }) => {
    cloneSubmission(root, submission, "alpha-template", "003");

    const result = runGenerator(root, "--write");
    assert.equal(result.status, 0, result.stderr);
    const catalog = JSON.parse(readFileSync(join(root, "templates", "catalog.json"), "utf8"));
    assert.deepEqual(
      catalog.templates.map((template) => template.slug),
      ["alpha-template", "ticket-priority-normalizer"]
    );
  });
});

test("normalizes an accepted source URL before publishing it", () => {
  withFixture(({ root }) => {
    const submissionPath = join(
      root,
      "templates/submissions/ticket-priority-normalizer/submission.json"
    );
    const submission = JSON.parse(readFileSync(submissionPath, "utf8"));
    submission.source.repository = "HTTPS://GITHUB.COM/community/template-example";
    writeFileSync(submissionPath, `${JSON.stringify(submission, null, 2)}\n`);

    const result = runGenerator(root, "--write");
    assert.equal(result.status, 0, result.stderr);
    const catalog = JSON.parse(readFileSync(join(root, "templates", "catalog.json"), "utf8"));
    assert.equal(
      catalog.templates[0].source.repository,
      "https://github.com/community/template-example"
    );
  });
});

test("rejects a submission whose review no longer approves the exact source", () => {
  withFixture(({ root, submission }) => {
    const reviewPath = join(root, submission.reviewRecord);
    const review = JSON.parse(readFileSync(reviewPath, "utf8"));
    review.decision = "request-changes";
    writeFileSync(reviewPath, `${JSON.stringify(review, null, 2)}\n`);

    const result = runGenerator(root, "--write");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /template submissions are invalid/);
    assert.doesNotMatch(result.stderr, /request-changes|ticket-priority-normalizer/);
  });
});

test("rejects an approved review whose evidence digest is stale", () => {
  withFixture(({ root, submission }) => {
    const reviewPath = join(root, submission.reviewRecord);
    const review = JSON.parse(readFileSync(reviewPath, "utf8"));
    const evidencePath = Object.keys(review.evidenceDigests)[0];
    review.evidenceDigests[evidencePath] = "0".repeat(64);
    writeFileSync(reviewPath, `${JSON.stringify(review, null, 2)}\n`);

    const result = runGenerator(root, "--write");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /plugin review records are invalid/);
    assert.doesNotMatch(result.stderr, /0{16}|ticket-priority-normalizer/);
  });
});

test("publishes a closed schema for gallery consumers", () => {
  const schema = JSON.parse(readFileSync(join(repoRoot, "templates", "catalog.schema.json")));

  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["schemaVersion", "templates"]);
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.equal(schema.properties.templates.items.additionalProperties, false);
  assert.equal(schema.properties.templates.items.properties.egress.properties.mode.const, "deny");
  assert.equal(
    schema.properties.templates.items.properties.review.properties.decision.const,
    "approve"
  );
});

test("wires catalog drift and documentation into public quality gates", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json")));
  const tier1 = readFileSync(join(repoRoot, ".github/workflows/tier1.yml"), "utf8");
  const guide = readFileSync(join(repoRoot, "docs/community/template-gallery-data.md"), "utf8");
  const docsIndex = readFileSync(join(repoRoot, "docs/README.md"), "utf8");

  assert.equal(
    packageJson.scripts["template-catalog:write"],
    "node scripts/generate-template-catalog.mjs --write"
  );
  assert.equal(
    packageJson.scripts["lint:template-catalog"],
    "node scripts/generate-template-catalog.mjs"
  );
  assert.equal(
    packageJson.scripts["test:template-catalog"],
    "node --test scripts/generate-template-catalog.test.mjs"
  );
  assert.match(packageJson.scripts.lint, /pnpm lint:template-catalog/);
  assert.match(packageJson.scripts.test, /pnpm test:template-catalog/);
  assert.match(tier1, /pnpm test:template-catalog/);
  for (const required of [
    "templates/catalog.json",
    "templates/catalog.schema.json",
    "pnpm template-catalog:write",
    "pnpm lint:template-catalog",
    "approved",
    "not a compatibility guarantee"
  ]) {
    assert.ok(guide.includes(required), `gallery data guide must include ${required}`);
  }
  assert.match(docsIndex, /community\/template-gallery-data\.md/);
});
