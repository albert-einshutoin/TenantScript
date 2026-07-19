import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const guidePath = join(repoRoot, "docs", "reference", "schema-diff-ci.md");

test("schema diff CI guide documents the implemented exit contract", () => {
  assert.ok(existsSync(guidePath), "missing docs/reference/schema-diff-ci.md");
  const guide = readFileSync(guidePath, "utf8");

  for (const expected of [
    "| Compatible, no warnings | `0` |",
    "| Compatible, warning-only | `0` |",
    "| Breaking change | `1` |",
    "| Schema read or parse failure | `1` |",
    "| Command usage error | `2` |"
  ]) {
    assert.ok(guide.includes(expected), `missing exit-code row: ${expected}`);
  }

  for (const example of ["Field removal", "Optional field addition", "Field type change"]) {
    assert.match(guide, new RegExp(`## ${example}`), `missing example: ${example}`);
  }

  assert.match(guide, /\.\.\/\.\.\/tasks\/Phase1\.md/);
  assert.match(guide, /ext schema diff --from .* --to /);
});
