import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "check-doc-command-contracts.mjs");
const repoRoot = join(dirname(scriptPath), "..");

function runChecker(dir) {
  return spawnSync(process.execPath, [scriptPath, dir], { cwd: repoRoot, encoding: "utf8" });
}

function withRepo(run) {
  const dir = mkdtempSync(join(tmpdir(), "doc-command-contracts-"));
  try {
    mkdirSync(join(dir, "docs", "quickstarts"), { recursive: true });
    mkdirSync(join(dir, "packages", "demo"), { recursive: true });
    writeFileSync(
      join(dir, "packages", "demo", "package.json"),
      JSON.stringify({ name: "@tenantscript/demo" })
    );
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("rejects shell snippets without cwd and expected exit metadata", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "docs", "quickstarts", "bad.md"), "```sh\npnpm test\n```\n");

    const result = runChecker(dir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bad\.md:1: shell block must start with # cwd:/);
  });
});

test("rejects unknown working directories and workspace filters", () => {
  withRepo((dir) => {
    writeFileSync(
      join(dir, "docs", "quickstarts", "bad.md"),
      "```sh\n# cwd: missing/path\n# expected-exit: 0\npnpm --filter @tenantscript/missing test\n```\n"
    );

    const result = runChecker(dir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /working directory does not exist: missing\/path/);
    assert.match(result.stderr, /unknown workspace filter @tenantscript\/missing/);
  });
});

test("accepts reproducible repository-root commands and known workspace filters", () => {
  withRepo((dir) => {
    writeFileSync(
      join(dir, "docs", "quickstarts", "good.md"),
      "```sh\n# cwd: repository root\n# expected-exit: 0\npnpm --filter @tenantscript/demo test\n```\n"
    );

    const result = runChecker(dir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Doc command contract check passed/);
  });
});

test("checks SDK reference shell snippets", () => {
  withRepo((dir) => {
    mkdirSync(join(dir, "docs", "reference"), { recursive: true });
    writeFileSync(join(dir, "docs", "reference", "sdk.md"), "```bash\npnpm test\n```\n");

    const result = runChecker(dir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /docs\/reference\/sdk\.md:1: shell block must start with # cwd:/);
  });
});

test("checks contributor onboarding shell snippets", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "CONTRIBUTING.md"), "```sh\npnpm verify\n```\n");

    const result = runChecker(dir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CONTRIBUTING\.md:1: shell block must start with # cwd:/);
  });
});
