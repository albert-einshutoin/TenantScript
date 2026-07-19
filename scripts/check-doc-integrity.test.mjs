import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "check-doc-integrity.mjs");

function runChecker(repoRoot) {
  return spawnSync(process.execPath, [scriptPath, repoRoot], { encoding: "utf8" });
}

function withRepo(run) {
  const repoRoot = mkdtempSync(join(tmpdir(), "doc-integrity-"));
  try {
    mkdirSync(join(repoRoot, "docs", "quickstarts"), { recursive: true });
    mkdirSync(join(repoRoot, "tasks"), { recursive: true });
    mkdirSync(join(repoRoot, "apps", "example-saas", "test"), { recursive: true });
    writeFileSync(
      join(repoRoot, "apps", "example-saas", "test", "zero-integration-quickstart.e2e.test.ts"),
      [
        'extractJsonSnippet(quickstart, "proxy-mapping");',
        'extractJsonSnippet(quickstart, "forwarded-body");'
      ].join("\n")
    );
    run(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("rejects broken relative Markdown links", () => {
  withRepo((repoRoot) => {
    writeFileSync(join(repoRoot, "docs", "guide.md"), "Read [missing](./missing.md).\n");
    writeValidQuickstart(repoRoot);

    const result = runChecker(repoRoot);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /docs\/guide\.md:1: broken relative link \.\/missing\.md/);
  });
});

test("rejects broken relative links in llms.txt", () => {
  withRepo((repoRoot) => {
    writeFileSync(join(repoRoot, "llms.txt"), "Read [missing](docs/missing.md).\n");
    writeValidQuickstart(repoRoot);

    const result = runChecker(repoRoot);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /llms\.txt:1: broken relative link docs\/missing\.md/);
  });
});

test("rejects missing and duplicate proxy snippet identifiers", () => {
  withRepo((repoRoot) => {
    writeFileSync(
      quickstartPath(repoRoot),
      ["```json proxy-mapping", "{}", "```", "", "```json proxy-mapping", "{}", "```"].join("\n")
    );

    const result = runChecker(repoRoot);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /duplicate proxy quickstart snippet identifier proxy-mapping/);
    assert.match(result.stderr, /missing proxy quickstart snippet identifier forwarded-body/);
  });
});

test("accepts valid relative links and unique E2E snippets", () => {
  withRepo((repoRoot) => {
    writeFileSync(join(repoRoot, "tasks", "Phase1.md"), "# Phase 1\n");
    writeFileSync(
      join(repoRoot, "docs", "guide.md"),
      "Read [Phase 1](../tasks/Phase1.md) and [external](https://example.com).\n"
    );
    writeValidQuickstart(repoRoot);

    const result = runChecker(repoRoot);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Doc integrity check passed/);
  });
});

function writeValidQuickstart(repoRoot) {
  writeFileSync(
    quickstartPath(repoRoot),
    ["```json proxy-mapping", "{}", "```", "", "```json forwarded-body", "{}", "```"].join("\n")
  );
}

function quickstartPath(repoRoot) {
  return join(repoRoot, "docs", "quickstarts", "zero-integration-proxy-mode.md");
}
