import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "check-security-advisory-drills.mjs"
);

function withRepo(run) {
  const repoRoot = mkdtempSync(join(tmpdir(), "advisory-drill-"));
  try {
    mkdirSync(join(repoRoot, "docs", "security", "advisory-drills"), { recursive: true });
    mkdirSync(join(repoRoot, "evidence"), { recursive: true });
    writeFileSync(join(repoRoot, "evidence", "red-test.txt"), "synthetic evidence\n");
    run(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function runChecker(repoRoot) {
  return spawnSync(process.execPath, [scriptPath, repoRoot], { encoding: "utf8" });
}

test("accepts a complete chronological synthetic advisory drill", () => {
  withRepo((repoRoot) => {
    writeDrill(repoRoot, validDrill());

    const result = runChecker(repoRoot);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Advisory drill check passed \(1 record\)/);
  });
});

test("rejects a drill that skips a required response stage", () => {
  withRepo((repoRoot) => {
    const drill = validDrill();
    drill.stages = drill.stages.filter((stage) => stage.name !== "regression-test");
    writeDrill(repoRoot, drill);

    const result = runChecker(repoRoot);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing required stage regression-test/);
  });
});

test("rejects non-chronological stages and evidence outside the repository", () => {
  withRepo((repoRoot) => {
    const drill = validDrill();
    const fix = drill.stages.find((stage) => stage.name === "fix");
    assert.ok(fix);
    fix.at = "2026-07-20T00:01:30.000Z";
    fix.evidence = "../private-note.md";
    writeDrill(repoRoot, drill);

    const result = runChecker(repoRoot);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /stages must be chronological/);
    assert.match(result.stderr, /evidence must stay inside the repository/);
  });
});

test("rejects credential-shaped fields from public synthetic records", () => {
  withRepo((repoRoot) => {
    writeDrill(repoRoot, { ...validDrill(), apiToken: "synthetic-but-forbidden" });

    const result = runChecker(repoRoot);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /forbidden sensitive field apiToken/);
  });
});

test("rejects credential-shaped values and URL query data", () => {
  withRepo((repoRoot) => {
    const drill = validDrill();
    drill.scenario = "Synthetic credential ghp_12345678901234567890 must not be recorded.";
    const closeout = drill.stages.find((stage) => stage.name === "closeout");
    assert.ok(closeout);
    closeout.evidence = "https://github.com/example/repository/pull/1?access=private";
    writeDrill(repoRoot, drill);

    const result = runChecker(repoRoot);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /forbidden credential-like value/);
    assert.match(result.stderr, /HTTPS evidence must not contain query or fragment data/);
  });
});

function writeDrill(repoRoot, drill) {
  writeFileSync(
    join(repoRoot, "docs", "security", "advisory-drills", "drill.json"),
    `${JSON.stringify(drill, null, 2)}\n`
  );
}

function validDrill() {
  const names = ["intake", "triage", "regression-test", "fix", "advisory-decision", "closeout"];

  return {
    schemaVersion: 1,
    id: "TS-DRILL-2026-001",
    kind: "tabletop",
    visibility: "public-synthetic",
    scenario: "Malformed configuration input causes a structured-validation boundary crash.",
    severity: "low",
    startedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:06:00.000Z",
    advisoryDecision: "not-required",
    decisionRationale: "The synthetic case has no confidentiality or cross-tenant impact.",
    stages: names.map((name, index) => ({
      name,
      at: `2026-07-20T00:0${String(index)}:00.000Z`,
      evidence: "evidence/red-test.txt"
    })),
    remainingLimitations: ["No GitHub private advisory was created for this synthetic drill."]
  };
}
