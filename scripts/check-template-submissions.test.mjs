import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = join(repoRoot, "scripts", "check-template-submissions.mjs");

function withRepository(run) {
  const root = mkdtempSync(join(tmpdir(), "template-submission-"));
  try {
    const packetRoot = join(root, "templates", "submissions", "example-template");
    const pluginRoot = join(packetRoot, "plugin");
    mkdirSync(join(pluginRoot, "src"), { recursive: true });
    mkdirSync(join(pluginRoot, "test"), { recursive: true });
    mkdirSync(join(root, "docs", "security", "plugin-reviews"), { recursive: true });
    writeFileSync(join(pluginRoot, "package.json"), '{"license":"Apache-2.0"}\n');
    writeFileSync(join(pluginRoot, "src", "index.ts"), "export const plugin = {};\n");
    writeFileSync(join(pluginRoot, "src", "manifest.ts"), "export const manifest = {};\n");
    writeFileSync(join(pluginRoot, "test", "plugin.test.ts"), "export {};\n");
    writeFileSync(join(packetRoot, "SECURITY.md"), "Not a certification. Synthetic input only.\n");
    writeFileSync(join(packetRoot, "verification.md"), "Accountless checks passed.\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "template-test@example.invalid"], {
      cwd: root
    });
    execFileSync("git", ["config", "user.name", "Template Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "test source"], { cwd: root });
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8"
    }).trim();
    const submission = validSubmission(root, revision);
    writeReviewRecord(root, submission);
    writeSubmission(root, "example-template", submission);
    run({ root, submission, revision });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeReviewRecord(root, submission, overrides = {}) {
  const record = {
    id: "TS-PLUGIN-REVIEW-2026-999",
    baselineCommit: submission.source.revision,
    target: {
      name: "Example template",
      scope: Object.keys(submission.source.files),
      sourceDigests: submission.source.files
    },
    decision: "approve",
    ...overrides
  };
  writeFileSync(
    join(root, "docs", "security", "plugin-reviews", "TS-PLUGIN-REVIEW-2026-999.json"),
    `${JSON.stringify(record, null, 2)}\n`
  );
}

function validSubmission(root, revision) {
  const files = {};
  for (const path of [
    "templates/submissions/example-template/plugin/package.json",
    "templates/submissions/example-template/plugin/src/index.ts",
    "templates/submissions/example-template/plugin/src/manifest.ts",
    "templates/submissions/example-template/plugin/test/plugin.test.ts"
  ]) {
    files[path] = createHash("sha256")
      .update(readFileSync(join(root, path)))
      .digest("hex");
  }
  return {
    schemaVersion: 1,
    kind: "simulation",
    slug: "example-template",
    displayName: "Example template",
    summary: "A bounded simulated submission for the repository contract.",
    license: "Apache-2.0",
    source: {
      repository: "https://github.com/albert-einshutoin/TenantScript",
      revision,
      directory: "templates/submissions/example-template/plugin",
      files
    },
    sdk: { range: "^0.0.0", lastTestedVersion: "0.0.0" },
    hook: { name: "ticket.created", type: "transform" },
    capabilities: [],
    egress: { mode: "deny", allowHosts: [] },
    configKeys: [],
    verification: {
      commands: {
        build: "pnpm build",
        test: "pnpm test",
        audit:
          "ext audit --manifest ./manifest.json --package ./package.json --bundle ./dist/plugin.cjs"
      },
      evidence: ["templates/submissions/example-template/verification.md"]
    },
    reviewRecord: "docs/security/plugin-reviews/TS-PLUGIN-REVIEW-2026-999.json",
    securityNote: "templates/submissions/example-template/SECURITY.md",
    nonGuarantees: ["This simulated submission is not a certification or live deployment proof."]
  };
}

function writeSubmission(root, directory, submission) {
  const directoryPath = join(root, "templates", "submissions", directory);
  mkdirSync(directoryPath, { recursive: true });
  writeFileSync(join(directoryPath, "submission.json"), `${JSON.stringify(submission, null, 2)}\n`);
}

function runChecker(root) {
  return spawnSync(process.execPath, [checkerPath, root], { encoding: "utf8" });
}

test("accepts a digest-bound simulated submission with deterministic output", () => {
  withRepository(({ root }) => {
    const first = runChecker(root);
    const second = runChecker(root);

    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, "Template submission check passed (1 submission).\n");
    assert.equal(second.stdout, first.stdout);
    assert.equal(second.stderr, "");
  });
});

test("rejects closed-schema, identity, SDK, hook, and egress violations", () => {
  withRepository(({ root, submission }) => {
    submission.unexpected = true;
    submission.slug = "Unsafe Slug";
    submission.sdk.range = "latest";
    submission.sdk.lastTestedVersion = "v1";
    submission.hook.type = "unknown";
    submission.capabilities = ["slack.send", "slack.send"];
    submission.egress = { mode: "deny", allowHosts: ["api.example.com"] };
    writeSubmission(root, "example-template", submission);

    const result = runChecker(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /submission\.json: unknown field unexpected/);
    assert.match(result.stderr, /submission\.json: slug is invalid/);
    assert.match(result.stderr, /submission\.json: sdk\.range must be a pinned caret range/);
    assert.match(result.stderr, /submission\.json: sdk\.lastTestedVersion must be exact semver/);
    assert.match(result.stderr, /submission\.json: hook\.type is invalid/);
    assert.match(result.stderr, /submission\.json: capabilities must be sorted and unique/);
    assert.match(result.stderr, /submission\.json: deny egress requires an empty allowHosts/);
  });
});

test("rejects mutable provenance, source drift, missing evidence, path escape, and symlinks", () => {
  withRepository(({ root, submission }) => {
    submission.source.revision = "main";
    submission.source.files["templates/submissions/example-template/plugin/src/index.ts"] =
      "0".repeat(64);
    submission.verification.evidence = ["../private.log"];
    submission.reviewRecord = "docs/security/plugin-reviews/missing.json";
    submission.securityNote = "templates/submissions/example-template/security-link.md";
    symlinkSync("SECURITY.md", join(root, submission.securityNote));
    writeSubmission(root, "example-template", submission);

    const result = runChecker(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /submission\.json: source\.revision must be a full commit SHA/);
    assert.match(result.stderr, /submission\.json: source file digest does not match/);
    assert.match(
      result.stderr,
      /submission\.json: verification\.evidence must stay inside the repository/
    );
    assert.match(result.stderr, /submission\.json: reviewRecord must reference a regular file/);
    assert.match(result.stderr, /submission\.json: securityNote must reference a regular file/);
  });
});

test("rejects duplicate slugs and emits findings in stable lexical order", () => {
  withRepository(({ root, submission }) => {
    const duplicate = structuredClone(submission);
    duplicate.source.directory = "templates/submissions/second-template/plugin";
    writeSubmission(root, "second-template", duplicate);

    const result = runChecker(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /templates\/submissions: duplicate slug/);
    const lines = result.stderr.trim().split("\n");
    assert.deepEqual(lines, [...lines].sort());
  });
});

test("rejects sensitive content and prohibited guarantees without reflecting input", () => {
  withRepository(({ root, submission }) => {
    const credential = `Bearer ${"A".repeat(24)}`;
    submission.summary = `Certified vulnerability-free ${credential}`;
    submission.nonGuarantees = ["customer tenant_very_private is safe"];
    submission.apiToken = credential;
    submission["forged\nlog-line"] = credential;
    writeSubmission(root, "example-template", submission);

    const result = runChecker(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /submission\.json: sensitive or private content is not allowed/);
    assert.match(result.stderr, /submission\.json: prohibited guarantee language is not allowed/);
    assert.doesNotMatch(result.stderr, new RegExp("A{8}"));
    assert.doesNotMatch(result.stderr, /tenant_very_private/);
    assert.doesNotMatch(result.stderr, /forged|log-line/);
  });
});

test("rejects oversized packets and unsafe semver components with bounded errors", () => {
  withRepository(({ root, submission }) => {
    submission.sdk.range = `^${"9".repeat(400)}.0.0`;
    submission.sdk.lastTestedVersion = `${"9".repeat(400)}.0.0`;
    writeSubmission(root, "example-template", submission);

    const semverResult = runChecker(root);
    assert.equal(semverResult.status, 1);
    assert.match(
      semverResult.stderr,
      /submission\.json: sdk versions must use safe integer components/
    );
    assert.doesNotMatch(semverResult.stderr, /9{20}/);

    submission.summary = "x".repeat(300_000);
    writeSubmission(root, "example-template", submission);
    const oversizedResult = runChecker(root);
    assert.equal(oversizedResult.status, 1);
    assert.match(oversizedResult.stderr, /submission\.json: JSON exceeds the 256 KiB limit/);
    assert.ok(oversizedResult.stderr.length < 500);
  });
});

test("normalizes equivalent TenantScript repository URLs and rejects the null revision", () => {
  withRepository(({ root, submission }) => {
    submission.source.repository = "https://github.com/albert-einshutoin/TenantScript.git/";
    submission.source.revision = "0".repeat(40);
    writeReviewRecord(root, submission);
    writeSubmission(root, "example-template", submission);

    const result = runChecker(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /submission\.json: source\.revision must be a full commit SHA/);
  });
});

test("accepts digest provenance when a squash removes the source commit object", () => {
  withRepository(({ root, submission }) => {
    submission.source.revision = "1".repeat(40);
    writeReviewRecord(root, submission);
    writeSubmission(root, "example-template", submission);

    const result = runChecker(root);

    assert.equal(result.status, 0, result.stderr);
  });
});

test("binds an approved review record to the exact submitted source", () => {
  withRepository(({ root, submission }) => {
    submission.reviewRecord = "unreviewed.json";
    writeFileSync(join(root, "unreviewed.json"), '{"decision":"approve"}\n');
    writeSubmission(root, "example-template", submission);

    let result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /reviewRecord must use the canonical review directory/);

    submission.reviewRecord = "docs/security/plugin-reviews/TS-PLUGIN-REVIEW-2026-999.json";
    writeReviewRecord(root, submission, {
      target: { name: "Unrelated review", scope: [], sourceDigests: {} }
    });
    writeSubmission(root, "example-template", submission);

    result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /reviewRecord source scope and digests must match submission\.source/
    );
  });
});

test("rejects loopback, private-address, and local-only repository hosts", () => {
  withRepository(({ root, submission }) => {
    for (const repository of [
      "https://127.0.0.1/org/repo",
      "https://10.0.0.1/org/repo",
      "https://[::1]/org/repo",
      "https://source.internal/org/repo",
      "https://singlelabel/org/repo"
    ]) {
      submission.source.repository = repository;
      writeSubmission(root, "example-template", submission);

      const result = runChecker(root);

      assert.equal(result.status, 1, repository);
      assert.match(
        result.stderr,
        /submission\.json: source\.repository must be a public HTTPS repository URL/
      );
      assert.doesNotMatch(result.stderr, /127\.0\.0\.1|10\.0\.0\.1|source\.internal|singlelabel/);
    }
  });
});

test("publishes a closed JSON Schema for the submission packet", () => {
  const schema = JSON.parse(readFileSync(join(repoRoot, "templates", "submission.schema.json")));

  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.kind.enum, ["community", "simulation"]);
  assert.equal(schema.properties.source.additionalProperties, false);
  assert.equal(schema.properties.verification.additionalProperties, false);
  for (const required of [
    "source",
    "sdk",
    "hook",
    "capabilities",
    "egress",
    "verification",
    "reviewRecord",
    "securityNote",
    "nonGuarantees"
  ]) {
    assert.ok(schema.required.includes(required));
  }
});
