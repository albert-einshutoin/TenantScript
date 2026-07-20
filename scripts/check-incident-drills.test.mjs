import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "check-incident-drills.mjs");

function withRepo(run) {
  const repoRoot = mkdtempSync(join(tmpdir(), "incident-drill-"));
  try {
    mkdirSync(join(repoRoot, "docs", "operations", "incident-drills"), { recursive: true });
    mkdirSync(join(repoRoot, "evidence"), { recursive: true });
    writeFileSync(join(repoRoot, "evidence", "synthetic-test.txt"), "synthetic evidence\n");
    run(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function runChecker(repoRoot) {
  return spawnSync(process.execPath, [scriptPath, repoRoot], { encoding: "utf8" });
}

test("accepts a complete chronological public synthetic incident drill", () => {
  withRepo((repoRoot) => {
    writeDrill(repoRoot, validDrill());

    const result = runChecker(repoRoot);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Incident drill check passed \(1 record\)/);
  });
});

test("rejects a drill that omits or reorders required lifecycle stages", () => {
  withRepo((repoRoot) => {
    const drill = validDrill();
    drill.stages = drill.stages.filter((stage) => stage.name !== "contain");
    drill.stages.reverse();
    writeDrill(repoRoot, drill);

    const result = runChecker(repoRoot);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing required stage contain/);
    assert.match(result.stderr, /stages must follow the required lifecycle order/);
  });
});

test("rejects non-chronological stages and evidence outside the repository", () => {
  withRepo((repoRoot) => {
    const drill = validDrill();
    drill.stages[3].at = "2026-07-20T00:01:30.000Z";
    drill.stages[3].evidence = "../private-note.md";
    writeDrill(repoRoot, drill);

    const result = runChecker(repoRoot);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /stages must be chronological/);
    assert.match(result.stderr, /evidence must stay inside the repository/);
  });
});

test("rejects missing evidence and unsupported outcomes", () => {
  withRepo((repoRoot) => {
    const drill = validDrill();
    drill.outcome = "unknown";
    drill.stages[0].evidence = "evidence/missing.txt";
    writeDrill(repoRoot, drill);

    const result = runChecker(repoRoot);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outcome must be passed or follow-up-required/);
    assert.match(result.stderr, /evidence does not exist/);
  });
});

test("rejects credential-shaped fields, values, and URL query data", () => {
  withRepo((repoRoot) => {
    const drill = validDrill();
    drill.apiToken = "synthetic-but-forbidden";
    drill.scenario = "Synthetic credential ghp_12345678901234567890 must not be recorded.";
    drill.stages[4].evidence = "https://github.com/example/repository/issues/1?private=true";
    writeDrill(repoRoot, drill);

    const result = runChecker(repoRoot);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /forbidden sensitive field apiToken/);
    assert.match(result.stderr, /forbidden credential-like value/);
    assert.match(result.stderr, /HTTPS evidence must not contain query or fragment data/);
  });
});

function writeDrill(repoRoot, drill) {
  writeFileSync(
    join(repoRoot, "docs", "operations", "incident-drills", "drill.json"),
    `${JSON.stringify(drill, null, 2)}\n`
  );
}

function validDrill() {
  const names = ["detect", "scope", "contain", "recover", "postmortem"];

  return {
    schemaVersion: 1,
    id: "TS-INCIDENT-DRILL-2026-001",
    kind: "tabletop",
    visibility: "public-synthetic",
    scenario: "A runaway plugin exhausts its memory budget and is quarantined.",
    severity: "high",
    startedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:05:00.000Z",
    stages: names.map((name, index) => ({
      name,
      at: `2026-07-20T00:0${String(index)}:00.000Z`,
      evidence: "evidence/synthetic-test.txt"
    })),
    outcome: "passed",
    remainingLimitations: ["No live provider or Cloudflare account was used in this tabletop."]
  };
}
