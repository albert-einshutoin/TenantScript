import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readmeUrl = new URL("../README.md", import.meta.url);

test("presents TenantScript as a repository-verified Public Alpha", async () => {
  const readme = await readFile(readmeUrl, "utf8");

  assert.match(readme, /Public Alpha/u);
  assert.match(readme, /Repository verified/u);
  assert.doesNotMatch(readme, /計画段階/u);
  assert.doesNotMatch(readme, /production[- ]ready|battle[- ]tested/iu);
});

test("provides one runnable accountless path and explicit live evidence limits", async () => {
  const readme = await readFile(readmeUrl, "utf8");

  for (const command of [
    "pnpm install --frozen-lockfile",
    "pnpm --filter @tenantscript/example-saas test -- zero-integration",
    "pnpm verify"
  ]) {
    assert.match(readme, new RegExp(escapeRegExp(command), "u"));
  }
  assert.match(readme, /Tier 1/u);
  assert.match(readme, /Tier 2/u);
  assert.match(readme, /credential/u);
  assert.match(readme, /live/iu);
});

test("links the public trust and contribution entrypoints", async () => {
  const readme = await readFile(readmeUrl, "utf8");

  for (const link of [
    "docs/README.md",
    "docs/quickstarts/zero-integration-proxy-mode.md",
    "docs/quickstarts/sdk-integration.md",
    "docs/security/threat-model.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "GOVERNANCE.md",
    "LICENSE"
  ]) {
    assert.match(readme, new RegExp(`\\(${escapeRegExp(link)}(?:#[^)]+)?\\)`, "u"));
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
