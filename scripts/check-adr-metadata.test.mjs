import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "check-adr-metadata.mjs");
const repoRoot = join(dirname(scriptPath), "..");

function runLinter(adrDir) {
  return spawnSync(process.execPath, [scriptPath, adrDir], {
    cwd: repoRoot,
    encoding: "utf8"
  });
}

function withTempAdrDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "adr-lint-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("reports file path and reason for ADR missing required metadata", () => {
  withTempAdrDir((dir) => {
    writeFileSync(
      join(dir, "001-bad.md"),
      `# ADR-001: Bad

Date: 2026-01-01
Deciders: team

## Context

Pending.
`
    );

    const result = runLinter(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /001-bad\.md/);
    assert.match(result.stderr, /missing Status metadata/);
  });
});

test("fails when a non-blocked ADR is missing the Consequences section", () => {
  withTempAdrDir((dir) => {
    writeFileSync(
      join(dir, "002-missing-consequences.md"),
      `# ADR-002: Missing Consequences

Date: 2026-01-01
Deciders: team
Status: Accepted

## Context

We need a decision.

## Decision

We chose option A.
`
    );

    const result = runLinter(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /002-missing-consequences\.md/);
    assert.match(result.stderr, /missing ## Consequences section/);
  });
});

test("allows Blocked ADRs without Context, Decision, or Consequences sections", () => {
  withTempAdrDir((dir) => {
    writeFileSync(
      join(dir, "003-blocked.md"),
      `# ADR-003: Blocked

Date: 2026-01-01
Deciders: team
Status: Blocked

## Blockers

Waiting on external dependency.
`
    );

    const result = runLinter(dir);
    assert.equal(result.status, 0, result.stderr);
  });
});
