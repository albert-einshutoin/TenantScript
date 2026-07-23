import assert from "node:assert/strict";
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
    "node@sha256:1a6a7b2e2e2c80a6973f57aa8b0c6ad67a961ddbc5ef326c448e133f93564ff9"
  );
  assert.match(dockerfile, /^# syntax=docker\/dockerfile:1\.7@sha256:[0-9a-f]{64}$/mu);
  assert.match(dockerfile, /^FROM --platform=linux\/amd64 node@sha256:[0-9a-f]{64} AS build$/mu);
  assert.match(dockerfile, /^FROM --platform=linux\/amd64 node@sha256:[0-9a-f]{64}$/mu);
  assert.match(dockerfile, /^USER node$/mu);
  assert.match(dockerfile, /^ENTRYPOINT \["\/opt\/tenantscript\/bin\/plugin-authoring-judge"\]$/mu);
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
    "node --test scripts/plugin-authoring-judge-image.test.mjs scripts/plugin-authoring-judge-image-sbom.test.mjs scripts/plugin-authoring-judge-image.integration.test.mjs"
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
  for (const required of [
    "linux/amd64",
    "allowlist",
    "non-root",
    "read-only root",
    "未publish",
    "未attest"
  ]) {
    assert.ok(guide.includes(required), `image guide must include ${required}`);
  }
});
