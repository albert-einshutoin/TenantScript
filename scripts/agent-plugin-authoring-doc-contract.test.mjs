import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const guidePath = join(repoRoot, "docs/quickstarts/agent-plugin-authoring.md");

test("agent plugin guide preserves the executable least-privilege path", () => {
  const guide = readFileSync(guidePath, "utf8");

  for (const required of [
    "pnpm dlx @tenantscript/cli@<version> init",
    "pnpm test:agent-scaffold",
    "pnpm build",
    "pnpm test",
    'egress: { mode: "deny" }',
    "UnknownHookError",
    "Manifest JSON Schema",
    "SDK reference",
    "Not live verified"
  ]) {
    assert.ok(guide.includes(required), `agent plugin guide must include ${required}`);
  }

  assert.doesNotMatch(guide, /NPM_TOKEN|CLOUDFLARE_API_TOKEN|NODE_AUTH_TOKEN/);
  assert.doesNotMatch(guide, /(?:\/Users\/|\/Volumes\/|packages\/.+\/src\/)/);
});

test("agent plugin guide is linked from both agent and human landing pages", () => {
  const llms = readFileSync(join(repoRoot, "llms.txt"), "utf8");
  const docsIndex = readFileSync(join(repoRoot, "docs/README.md"), "utf8");
  assert.match(llms, /\(docs\/quickstarts\/agent-plugin-authoring\.md\)/);
  assert.match(docsIndex, /\(quickstarts\/agent-plugin-authoring\.md\)/);
});
