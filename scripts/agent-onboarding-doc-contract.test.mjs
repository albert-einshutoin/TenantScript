import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const llmsPath = join(repoRoot, "llms.txt");

test("llms.txt maps public docs, entrypoints, and safe contribution boundaries", () => {
  assert.ok(existsSync(llmsPath), "missing root llms.txt");
  const contents = readFileSync(llmsPath, "utf8");

  for (const path of [
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "docs/Cloudflare-native_SaaS_Extension_Control_Plane_Product_Document.md",
    "tasks/README.md",
    "docs/adr/README.md",
    "docs/quickstarts/zero-integration-proxy-mode.md",
    "docs/quickstarts/sdk-integration.md",
    "packages/manifest/src/index.ts",
    "packages/host-sdk/src/index.ts",
    "packages/plugin-sdk/src/index.ts",
    "packages/loader/src/index.ts",
    "packages/capabilities/src/index.ts",
    "packages/control-plane/src/index.ts",
    "packages/proxy/src/index.ts",
    "packages/cli/src/index.ts"
  ]) {
    assert.ok(contents.includes(`(${path})`), `llms.txt must link ${path}`);
  }

  for (const phrase of [
    "RED -> GREEN -> REFACTOR",
    "pnpm verify",
    "Tier 1",
    "Tier 2",
    "maintainer-controlled credentials"
  ]) {
    assert.ok(contents.includes(phrase), `llms.txt must document ${phrase}`);
  }

  assert.doesNotMatch(contents, /\]\((?:https?:|\/Users\/|\/Volumes\/)/);
  assert.doesNotMatch(contents, /dash\.cloudflare\.com\/[0-9a-f]{16,}/i);
});
