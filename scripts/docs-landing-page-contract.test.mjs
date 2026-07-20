import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const audienceLinks = new Map([
  [
    "Adopter / evaluator",
    [
      "quickstarts/zero-integration-proxy-mode.md",
      "quickstarts/sdk-integration.md",
      "reviews/phase2-gate-evidence.md"
    ]
  ],
  [
    "Plugin author",
    ["quickstarts/sdk-integration.md", "reference/sdk.md", "reference/schema-diff-ci.md"]
  ],
  [
    "Host developer",
    [
      "quickstarts/zero-integration-proxy-mode.md",
      "quickstarts/sdk-integration.md",
      "reference/configuration.md"
    ]
  ],
  [
    "Operator",
    [
      "reference/configuration.md",
      "reference/control-plane-errors.md",
      "operations/incident-response.md",
      "operations/rollback-troubleshooting.md"
    ]
  ],
  [
    "Security reviewer",
    [
      "../SECURITY.md",
      "security/threat-model.md",
      "security/community-review-packet.md",
      "security/rbac-matrix.md"
    ]
  ],
  [
    "Contributor",
    ["../CONTRIBUTING.md", "community/good-first-issues.md", "../tasks/README.md", "adr/README.md"]
  ]
]);

test("routes every audience to its canonical next documents", async () => {
  const landing = await readFile(new URL("../docs/README.md", import.meta.url), "utf8");

  for (const [audience, links] of audienceLinks) {
    const content = section(landing, audience);
    assert.match(content, /\b(?:Implemented|Repository verified|Live verified|Blocked)\b/u);
    for (const link of links) {
      assert.match(content, new RegExp(`\\(${escapeRegExp(link)}(?:#[^)]+)?\\)`, "u"));
    }
  }
});

test("defines status terms without turning plans into available features", async () => {
  const landing = await readFile(new URL("../docs/README.md", import.meta.url), "utf8");

  for (const status of ["Implemented", "Repository verified", "Live verified", "Blocked"]) {
    assert.match(landing, new RegExp(`\\*\\*${escapeRegExp(status)}\\*\\*`, "u"));
  }
  assert.match(landing, /plans?[^.]*not available functionality/iu);
  assert.doesNotMatch(landing, /\/Volumes\/|\/Users\//u);
});

test("publishes the landing page from the public entrypoints", async () => {
  const [readme, llms] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../llms.txt", import.meta.url), "utf8")
  ]);

  assert.match(readme, /\(docs\/README\.md\)/u);
  assert.match(llms, /\(docs\/README\.md\)/u);
});

function section(markdown, heading) {
  const match = new RegExp(
    `^## ${escapeRegExp(heading)}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`,
    "mu"
  ).exec(markdown);
  assert.notEqual(match, null, `missing audience heading: ${heading}`);
  return match?.[1] ?? "";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
