import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const referenceUrl = new URL("../docs/reference/cli.md", import.meta.url);

const commandContracts = new Map([
  ["init", { required: ["--name", "--dir"], exits: [0, 2] }],
  ["build", { required: ["--entry"], exits: [0, 1, 2] }],
  ["audit", { required: ["--manifest", "--package"], exits: [0, 1, 2] }],
  ["dev", { required: ["--entry", "--hook"], exits: [0, 1, 2] }],
  ["replay", { required: ["--entry", "--sample"], exits: [0, 1, 2] }],
  ["schema", { required: ["diff", "--from", "--to"], exits: [0, 1, 2] }],
  ["manifest", { required: ["lint", "--manifest"], exits: [0, 1, 2] }],
  [
    "deploy",
    {
      required: ["--app", "--plugin", "--version", "--entry", "--manifest"],
      exits: [0, 1, 2]
    }
  ],
  [
    "rollback-drill",
    {
      required: ["--deployed-at", "--detected-at", "--rollback-started-at", "--completed-at"],
      exits: [0, 2]
    }
  ],
  ["doctor", { required: ["--report"], exits: [0, 1, 2] }],
  ["setup", { required: ["--profile", "--runtime", "--dry-run"], exits: [0, 2] }],
  [
    "approvals",
    {
      required: ["approve", "reject", "--approval"],
      exits: [0, 1, 2]
    }
  ],
  [
    "rollback",
    {
      required: ["--installation", "--target-version", "--expected-revision", "--idempotency-key"],
      exits: [0, 1, 2]
    }
  ]
]);

test("documents exactly the implemented top-level CLI commands", async () => {
  const [reference, source] = await Promise.all([
    readFile(referenceUrl, "utf8"),
    readFile(new URL("../packages/cli/src/index.ts", import.meta.url), "utf8")
  ]);

  const implemented = new Set(
    [...source.matchAll(/command === "([^"]+)"/gu)].map((match) => match[1])
  );
  assert.match(source, /command !== "rollback"/u);
  implemented.add("rollback");

  assert.deepEqual([...commandContracts.keys()].sort(), [...implemented].sort());
  const documented = new Set(
    [...reference.matchAll(/^\|\s*\*\*`ext ([^` ]+)`\*\*\s*\|/gmu)].map((match) => match[1])
  );
  assert.deepEqual([...documented].sort(), [...implemented].sort());
});

test("publishes required arguments, JSON output, and tested exit codes", async () => {
  const reference = await readFile(referenceUrl, "utf8");

  for (const [command, contract] of commandContracts) {
    const row = tableRow(reference, command);
    assert.match(row, /JSON/iu, `${command}: output format is missing`);
    for (const required of contract.required) {
      assert.ok(row.includes(`\`${required}\``), `${command}: missing required token ${required}`);
    }
    for (const exit of contract.exits) {
      assert.ok(
        row.includes(`\`${String(exit)}\``),
        `${command}: missing exit code ${String(exit)}`
      );
    }
  }
});

test("documents output safety, binary limitations, and public entrypoints", async () => {
  const [reference, readme, llms] = await Promise.all([
    readFile(referenceUrl, "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../llms.txt", import.meta.url), "utf8")
  ]);

  assert.match(reference, /stdout[^.]*JSON/iu);
  assert.match(reference, /stderr[^.]*(?:diagnostic|診断)/iu);
  assert.match(reference, /provider[^.]*(?:error|detail)[^.]*(?:not|しない|ません)/iu);
  assert.match(reference, /deploy[^.]*dry-run[^.]*(?:binary|client)/iu);
  assert.doesNotMatch(reference, /\/Volumes\/|\/Users\//u);
  assert.match(readme, /\(docs\/reference\/cli\.md\)/u);
  assert.match(llms, /\(docs\/reference\/cli\.md\)/u);
});

function tableRow(markdown, command) {
  const row = markdown.split("\n").find((line) => {
    const firstCell = /^\|\s*\*\*`ext ([^` ]+)`\*\*\s*\|/u.exec(line)?.[1];
    return firstCell === command;
  });
  assert.notEqual(row, undefined, `missing command row: ext ${command}`);
  return row ?? "";
}
