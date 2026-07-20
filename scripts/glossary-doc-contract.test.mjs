import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const glossaryUrl = new URL("../docs/reference/glossary.md", import.meta.url);

const requiredTerms = [
  "App",
  "Tenant",
  "Plugin",
  "Plugin version",
  "Installation",
  "Hook",
  "Capability",
  "Grant",
  "Approval",
  "Runtime primitive",
  "Control Plane",
  "Host SDK"
];

test("defines every canonical term in concise English", async () => {
  const glossary = await readFile(glossaryUrl, "utf8");

  for (const term of requiredTerms) {
    const definition = section(glossary, term);
    assert.ok(definition.trim().length >= 40, `${term}: definition is too short`);
  }
  assert.ok([...glossary.matchAll(/^## [^\n]+$/gmu)].length >= 12);
  assert.doesNotMatch(glossary, /[\u3040-\u30ff\u3400-\u9fff]/u);
  assert.doesNotMatch(glossary, /\/Volumes\/|\/Users\//u);
});

test("separates concepts that must not share authority", async () => {
  const glossary = await readFile(glossaryUrl, "utf8");

  assert.match(glossary, /app[^.]*not[^.]*tenant/iu);
  assert.match(glossary, /plugin[^.]*plugin version[^.]*installation/iu);
  assert.match(glossary, /capability[^.]*grant/iu);
  assert.match(glossary, /grant[^.]*not[^.]*approval/iu);
  assert.match(glossary, /runtime primitive[^.]*not[^.]*Control Plane/iu);
  assert.match(glossary, /Host SDK[^.]*Plugin SDK/iu);
});

test("publishes the glossary from public entrypoints", async () => {
  const [readme, llms] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../llms.txt", import.meta.url), "utf8")
  ]);

  assert.match(readme, /\(docs\/reference\/glossary\.md\)/u);
  assert.match(llms, /\(docs\/reference\/glossary\.md\)/u);
});

function section(markdown, heading) {
  const match = new RegExp(
    `^## ${escapeRegExp(heading)}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`,
    "mu"
  ).exec(markdown);
  assert.notEqual(match, null, `missing glossary term: ${heading}`);
  return match?.[1] ?? "";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
