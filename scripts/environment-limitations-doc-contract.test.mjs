import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(repoRoot, path), "utf8");

test("public docs separate accountless work from maintainer-only environment blockers", () => {
  const readme = read("README.md");
  const runtimeAdr = read("docs/adr/001-runtime-primitive.md");
  const benchmark = read("docs/benchmarks/phase0.md");

  assert.match(readme, /## 既知の環境制約/);
  assert.match(readme, /docs\/adr\/001-runtime-primitive\.md/);
  assert.match(readme, /docs\/benchmarks\/phase0\.md/);
  assert.match(readme, /npm.*@tenantscript.*(?:認証|authentication)/i);
  assert.match(readme, /pnpm verify/);
  assert.match(readme, /wrangler deploy.*--dry-run/);

  for (const [label, contents] of [
    ["README.md", readme],
    ["docs/adr/001-runtime-primitive.md", runtimeAdr],
    ["docs/benchmarks/phase0.md", benchmark]
  ]) {
    assert.doesNotMatch(
      contents,
      /dash\.cloudflare\.com\/[0-9a-f]{16,}/i,
      `${label} must not expose a Cloudflare account ID`
    );
  }
});
