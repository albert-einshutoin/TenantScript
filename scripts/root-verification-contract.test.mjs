import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

test("verify runs the complete local accountless gate in a deterministic order", () => {
  assert.deepEqual(manifest.scripts.verify.split(" && "), [
    "pnpm typecheck",
    "pnpm lint",
    "pnpm test",
    "pnpm test:coverage",
    "pnpm test:security",
    "pnpm audit --audit-level high",
    "pnpm format"
  ]);
});

test("every named verify subcommand is a root script", () => {
  for (const command of ["typecheck", "lint", "test", "test:coverage", "test:security", "format"]) {
    assert.equal(typeof manifest.scripts[command], "string", `missing root script ${command}`);
  }
});
