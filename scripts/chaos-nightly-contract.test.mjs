import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("nightly runs the canonical accountless chaos suite", async () => {
  const [rootPackage, workflow] = await Promise.all([
    readJson("package.json"),
    readFile(".github/workflows/tier2-live.yml", "utf8")
  ]);

  assert.equal(
    rootPackage.scripts?.["test:chaos"],
    "pnpm --filter @tenantscript/loader test:chaos && pnpm --filter @tenantscript/host-sdk test:chaos && pnpm --filter @tenantscript/control-plane test:chaos"
  );
  assert.match(workflow, /chaos-contract:/);
  assert.match(workflow, /run: pnpm test:chaos/);
});

test("each affected runtime package exposes one focused chaos command", async () => {
  const packages = await Promise.all(
    ["loader", "host-sdk", "control-plane"].map((name) => readJson(`packages/${name}/package.json`))
  );

  for (const manifest of packages) {
    assert.equal(manifest.scripts?.["test:chaos"], "vitest run test/chaos-suite.test.ts");
  }
});

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
