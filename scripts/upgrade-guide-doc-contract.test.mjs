import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const guideUrl = new URL("../docs/operations/control-plane-upgrades.md", import.meta.url);

test("documents the repository-verified control-plane upgrade contract", async () => {
  const guide = await readFile(guideUrl, "utf8");

  for (const heading of ["Evidence boundary", "Preflight", "Apply", "Postflight", "Recovery"]) {
    assert.match(guide, new RegExp(`^## ${heading}$`, "mu"));
  }
  for (const invariant of [
    "pre-v1-0010",
    "D1",
    "R2",
    "Durable Object",
    "d1_migrations",
    "backup",
    "no automatic down migration"
  ]) {
    assert.ok(guide.includes(invariant), `missing upgrade invariant: ${invariant}`);
  }
  assert.match(guide, /accountless/iu);
  assert.match(guide, /Tier 2[^.]*(?:credential|live)/iu);
  assert.match(guide, /pnpm --filter @tenantscript\/control-plane test/u);
  assert.match(guide, /pnpm verify/u);
  assert.doesNotMatch(guide, /\/Volumes\/|\/Users\//u);
});

test("routes operators and contributors to the upgrade guide", async () => {
  const [landing, operations, selection] = await Promise.all([
    readFile(new URL("../docs/README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/operations/README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/contributing/test-selection.md", import.meta.url), "utf8")
  ]);

  assert.match(landing, /\(operations\/control-plane-upgrades\.md\)/u);
  assert.match(operations, /\(control-plane-upgrades\.md\)/u);
  assert.match(selection, /\(\.\.\/operations\/control-plane-upgrades\.md\)/u);
});
