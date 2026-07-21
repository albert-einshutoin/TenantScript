import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const checklistUrl = new URL("../docs/security/plugin-review-checklist.md", import.meta.url);
const landingUrl = new URL("../docs/README.md", import.meta.url);

test("plugin review checklist fixes the target and separates five evidence domains", async () => {
  const checklist = await readFile(checklistUrl, "utf8");

  for (const phrase of ["commit SHA", "ext audit", "Automated audit boundary"]) {
    assert.match(checklist, new RegExp(escapeRegExp(phrase), "iu"));
  }

  for (const heading of ["Security", "Compatibility", "Operation", "Documentation", "License"]) {
    const content = section(checklist, heading);
    assert.match(content, /Blocking condition/iu, `${heading} must define blocking conditions`);
    assert.match(content, /Evidence/iu, `${heading} must define retained evidence`);
  }
});

test("plugin review checklist defines bounded decisions and a reusable evidence record", async () => {
  const checklist = await readFile(checklistUrl, "utf8");
  const decision = section(checklist, "Decision");
  const record = section(checklist, "Review record template");
  const boundaries = section(checklist, "Non-guarantees");

  for (const outcome of ["approve", "request changes", "reject"]) {
    assert.match(decision, new RegExp(escapeRegExp(outcome), "iu"));
    assert.match(record, new RegExp(escapeRegExp(outcome), "iu"));
  }
  assert.match(decision, /blocking finding/iu);
  assert.match(decision, /unverified|not verified/iu);
  assert.match(record, /evidence link/iu);
  assert.match(record, /checked|failed|not-applicable/iu);
  assert.match(boundaries, /not a certification/iu);
  assert.match(boundaries, /future version|vulnerability-free|live environment/iu);
  assert.doesNotMatch(checklist, /\/Volumes\/|\/Users\//u);
});

test("plugin authors and security reviewers can reach the canonical checklist", async () => {
  const landing = await readFile(landingUrl, "utf8");
  const link = "security/plugin-review-checklist.md";

  for (const audience of ["Plugin author", "Security reviewer"]) {
    assert.match(section(landing, audience), new RegExp(`\\(${escapeRegExp(link)}\\)`, "u"));
  }
});

function section(markdown, heading) {
  const match = new RegExp(
    `^## ${escapeRegExp(heading)}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`,
    "mu"
  ).exec(markdown);
  assert.notEqual(match, null, `missing heading: ${heading}`);
  return match?.[1] ?? "";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
