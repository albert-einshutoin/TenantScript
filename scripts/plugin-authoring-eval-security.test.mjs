import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  generatePluginAuthoringEvalArtifacts,
  parsePluginAuthoringCorpus,
  parsePluginAuthoringResult
} from "./plugin-authoring-eval.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evalRoot = join(repoRoot, "evals", "plugin-authoring");
const scriptPath = join(repoRoot, "scripts", "plugin-authoring-eval.mjs");

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "tenantscript-agent-eval-security-"));
  try {
    cpSync(evalRoot, join(root, "evals", "plugin-authoring"), { recursive: true });
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("does not reflect secret-shaped result metadata in parser errors", () => {
  const corpus = parsePluginAuthoringCorpus(loadJson(join(evalRoot, "corpus.json")));
  const result = loadJson(join(evalRoot, "results", "repository-simulation-001.json"));
  result.run.agent = "API_TOKEN=do-not-reflect";

  assert.throws(
    () => parsePluginAuthoringResult(result, corpus),
    (error) => {
      assert.equal(error.message, "plugin authoring result is invalid");
      assert.doesNotMatch(error.message, /do-not-reflect|API_TOKEN/);
      return true;
    }
  );
});

test("rejects machine-local paths and secret-shaped corpus prose without reflection", () => {
  const corpus = loadJson(join(evalRoot, "corpus.json"));
  for (const unsafe of ["Inspect /Volumes/private/work", "Use password=do-not-reflect"]) {
    const input = structuredClone(corpus);
    input.tasks[0].requirement = unsafe.padEnd(40, ".");
    assert.throws(
      () => parsePluginAuthoringCorpus(input),
      (error) => {
        assert.equal(error.message, "plugin authoring corpus is invalid");
        assert.doesNotMatch(error.message, /Volumes|do-not-reflect/);
        return true;
      }
    );
  }
});

test("rejects symlinked and oversized result evidence", () => {
  withFixture((root) => {
    const resultsRoot = join(root, "evals", "plugin-authoring", "results");
    const resultPath = join(resultsRoot, "repository-simulation-001.json");
    const outside = join(root, "outside.json");
    writeFileSync(outside, readFileSync(resultPath));
    rmSync(resultPath);
    symlinkSync(outside, resultPath);
    assert.throws(
      () => generatePluginAuthoringEvalArtifacts(root),
      /plugin authoring eval inputs are invalid/
    );

    rmSync(resultPath);
    writeFileSync(resultPath, " ".repeat(1_048_577));
    assert.throws(
      () => generatePluginAuthoringEvalArtifacts(root),
      /plugin authoring eval inputs are invalid/
    );
  });
});

test("rejects unknown evidence files instead of silently excluding them", () => {
  withFixture((root) => {
    writeFileSync(join(root, "evals", "plugin-authoring", "results", ".hidden"), "ignored");
    assert.throws(
      () => generatePluginAuthoringEvalArtifacts(root),
      /plugin authoring eval inputs are invalid/
    );
  });
});

test("will not follow a generated-report symlink during write", () => {
  withFixture((root) => {
    const outputPath = join(root, "evals", "plugin-authoring", "report.json");
    const outside = join(root, "outside-report.json");
    writeFileSync(outside, "operator-owned\n");
    rmSync(outputPath);
    symlinkSync(outside, outputPath);

    const result = spawnSync(process.execPath, [scriptPath, root, "--write"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" }
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /plugin authoring eval output path is unsafe/);
    assert.equal(readFileSync(outside, "utf8"), "operator-owned\n");
  });
});
