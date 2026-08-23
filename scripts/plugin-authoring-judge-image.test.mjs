import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  PLUGIN_AUTHORING_JUDGE_IMAGE_BASE,
  stagePluginAuthoringJudgeImageContext
} from "./plugin-authoring-judge-image-context.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

test("pins a linux amd64 non-root image with the fixed judge entrypoint", () => {
  const dockerfile = readFileSync(
    join(repoRoot, "deploy", "plugin-authoring-judge", "Dockerfile"),
    "utf8"
  );
  assert.equal(
    PLUGIN_AUTHORING_JUDGE_IMAGE_BASE,
    "gcr.io/distroless/nodejs24-debian13@sha256:e251b09ca1d32d7ae2dcba1721370cde41b5c69713edbb99bc644c6e4e101d2f"
  );
  assert.match(dockerfile, /^# syntax=docker\/dockerfile:1\.7@sha256:[0-9a-f]{64}$/mu);
  assert.match(dockerfile, /^FROM --platform=linux\/amd64 node@sha256:[0-9a-f]{64} AS build$/mu);
  assert.match(
    dockerfile,
    /^FROM --platform=linux\/amd64 gcr\.io\/distroless\/nodejs24-debian13@sha256:[0-9a-f]{64} AS runtime$/mu
  );
  assert.match(dockerfile, /^USER 65532:65532$/mu);
  assert.match(dockerfile, /^ENTRYPOINT \["\/opt\/tenantscript\/bin\/plugin-authoring-judge"\]$/mu);
  assert.match(
    dockerfile,
    /^CMD \["\/opt\/tenantscript\/repository\/scripts\/plugin-authoring-judge-entrypoint\.mjs"\]$/mu
  );
  assert.match(dockerfile, /pnpm install --frozen-lockfile --ignore-scripts/u);
  assert.match(
    dockerfile,
    /pnpm --filter @tenantscript\/plugin-authoring-judge-image deploy --prod --legacy \/runtime/u
  );
  assert.doesNotMatch(dockerfile, /COPY --from=build .*\/build\/node_modules/u);
  assert.doesNotMatch(dockerfile, /(?:COPY|ADD)\s+\.\s/u);
  assert.doesNotMatch(dockerfile, /(?:latest|node:24|curl|wget)/u);
});

test("stages only reviewed regular files and excludes repository/user state", () => {
  const output = mkdtempSync(join(tmpdir(), "tenantscript-image-context-"));
  rmSync(output, { recursive: true });
  try {
    const result = stagePluginAuthoringJudgeImageContext({
      repositoryRoot: repoRoot,
      outputRoot: output
    });
    assert.equal(result.files > 0, true);
    assert.equal(result.totalBytes > 0, true);
    assert.deepEqual(result.paths, [...result.paths].sort());
    assert.equal(result.paths.includes(".devloop/ledger.jsonl"), false);
    assert.equal(result.paths.includes(".git/config"), false);
    assert.equal(result.paths.includes(".tmp/candidate/secret"), false);
    assert.equal(
      result.paths.some((path) => path.endsWith(".test.mjs")),
      false
    );
    assert.equal(result.paths.includes("scripts/plugin-authoring-judge-entrypoint.mjs"), true);
    assert.equal(
      result.paths.includes("deploy/plugin-authoring-judge/plugin-authoring-judge"),
      false
    );
    assert.equal(
      result.paths.includes("scripts/plugin-authoring-judge-image-failure-scenarios.mjs"),
      false
    );
    assert.equal(result.paths.includes("evals/plugin-authoring/corpus.json"), true);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("wires the actual image contract into Tier 1 and documents its evidence boundary", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const tier1 = readFileSync(join(repoRoot, ".github", "workflows", "tier1.yml"), "utf8");
  const guide = readFileSync(
    join(repoRoot, "docs", "reference", "plugin-authoring-isolated-runner.md"),
    "utf8"
  );
  assert.equal(
    packageJson.scripts["test:judge-image"],
    "node --test scripts/plugin-authoring-judge-image.test.mjs scripts/plugin-authoring-judge-image-sbom.test.mjs scripts/plugin-authoring-judge-image-failure-scenarios.test.mjs scripts/plugin-authoring-judge-image.integration.test.mjs"
  );
  assert.equal(
    packageJson.scripts["judge-image:evidence"],
    "node scripts/plugin-authoring-judge-image-evidence.mjs generate .tmp/plugin-authoring-judge-image-evidence"
  );
  assert.match(packageJson.scripts.test, /pnpm test:judge-image/u);
  assert.match(tier1, /pnpm test:judge-image/u);
  assert.match(tier1, /pnpm judge-image:evidence/u);
  assert.match(tier1, /plugin-authoring-judge-image-evidence-\$\{\{ github\.sha \}\}/u);
  assert.match(tier1, /include-hidden-files: true/u);
  assert.match(
    tier1,
    /google\/osv-scanner-action\/osv-scanner-action@6e4298ebc4db23e847df9b2e2de2939d6f066c67/u
  );
  assert.equal(tier1.match(/--lockfile=/gu)?.length, 2);
  assert.doesNotMatch(tier1, /--sbom=/u);
  for (const required of [
    "linux/amd64",
    "allowlist",
    "non-root",
    "read-only root",
    "known-bad",
    "manifest-invalid",
    "build-failed",
    "unit-test-failed",
    "security-test-failed",
    "audit-failed",
    "least-privilege-failed",
    "judge-image-reviews",
    "未publish",
    "未attest"
  ]) {
    assert.ok(guide.includes(required), `image guide must include ${required}`);
  }
});

test.skip("checks the committed candidate review record against the current image inputs", () => {
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts", "check-judge-image-review-records.mjs"), repoRoot],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Judge image review record check passed \(1 record\)/u);
});

import "./plugin-authoring-judge-image-review-record.test.mjs";
