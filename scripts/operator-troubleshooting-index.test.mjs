import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexUrl = new URL("../docs/operations/README.md", import.meta.url);

const symptomRunbooks = new Map([
  ["Install failure", ["admin-install-idempotency.md", "app-database-routing.md"]],
  ["Approval stalled", ["installation-grant-approval.md"]],
  ["Rollback", ["rollback-troubleshooting.md", "admin-rollback-idempotency.md"]],
  ["Rate limit", ["admin-mutation-rate-limits.md"]],
  ["Archive", ["execution-retention.md", "audit-export.md"]],
  ["Migration", ["schema-migrations.md"]],
  ["Runaway", ["runaway-quarantine.md", "incident-response.md"]],
  ["Telemetry failure", ["../privacy/telemetry.md"]]
]);

test("routes each operational symptom through a safe observation to its runbook", async () => {
  const index = await readFile(indexUrl, "utf8");

  for (const [symptom, links] of symptomRunbooks) {
    const row = tableRow(index, symptom);
    assert.match(row, /safe observation|安全な観測/iu, `${symptom}: safe observation is missing`);
    for (const link of links) {
      assert.match(row, new RegExp(`\\(${escapeRegExp(link)}(?:#[^)]+)?\\)`, "u"));
    }
  }
});

test("forbids destructive recovery and disclosure shortcuts", async () => {
  const index = await readFile(indexUrl, "utf8");

  assert.match(index, /destructive SQL/iu);
  assert.match(index, /force[ -]push/iu);
  assert.match(index, /(?:raw )?secrets?[^.\n]*(?:issue|pull request|log)/iu);
  assert.match(index, /監査[^.\n]*(?:迂回|削除)|(?:bypass|delete)[^.\n]*audit/iu);
  assert.doesNotMatch(index, /\/Volumes\/|\/Users\//u);
});

test("publishes the operator index from public entrypoints", async () => {
  const [readme, llms, landing] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../llms.txt", import.meta.url), "utf8"),
    readFile(new URL("../docs/README.md", import.meta.url), "utf8")
  ]);

  assert.match(readme, /\(docs\/operations\/README\.md\)/u);
  assert.match(llms, /\(docs\/operations\/README\.md\)/u);
  assert.match(landing, /\(operations\/README\.md\)/u);
});

function tableRow(markdown, symptom) {
  const row = markdown
    .split("\n")
    .find((line) => line.startsWith("|") && line.includes(`**${symptom}**`));
  assert.notEqual(row, undefined, `missing symptom row: ${symptom}`);
  return row ?? "";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
