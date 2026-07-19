import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(repoRoot, path), "utf8");

test("SECURITY.md defines the public attack surface and canonical evidence links", () => {
  const security = read("SECURITY.md");

  for (const component of [
    "loader",
    "capability broker",
    "control-plane API",
    "proxy",
    "CLI",
    "documentation examples"
  ]) {
    assert.ok(security.includes(component), `SECURITY.md must name ${component}`);
  }

  for (const path of [
    "docs/adr/002-oss-license-and-publication.md",
    "docs/benchmarks/README.md",
    "tasks/README.md"
  ]) {
    assert.ok(security.includes(`(${path})`), `SECURITY.md must link ${path}`);
  }
});

test("CONTRIBUTING.md links contributors to benchmark evidence requirements", () => {
  const contributing = read("CONTRIBUTING.md");

  assert.ok(
    contributing.includes("(docs/benchmarks/README.md)"),
    "CONTRIBUTING.md must link the benchmark evidence index"
  );
});
