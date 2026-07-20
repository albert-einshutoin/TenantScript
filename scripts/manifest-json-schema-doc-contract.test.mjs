import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("publishes the manifest JSON Schema contract and its authority boundary", async () => {
  const guide = await readFile(
    new URL("../docs/reference/manifest-json-schema.md", import.meta.url),
    "utf8"
  );

  for (const value of [
    "tenantScriptManifestJsonSchema",
    "tenantscript-manifest.schema.json",
    "draft-07",
    "parseManifest",
    "semver",
    "pnpm test:api-surface",
    "pnpm verify"
  ]) {
    assert.ok(guide.includes(value), `missing manifest schema contract: ${value}`);
  }
  assert.match(guide, /structural/iu);
  assert.match(guide, /semantic/iu);
  assert.doesNotMatch(guide, /\/Volumes\/|\/Users\//u);
});

test("links the manifest schema guide from package and audience entrypoints", async () => {
  const [packageReadme, landing, stability] = await Promise.all([
    readFile(new URL("../packages/manifest/README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/reference/public-api-stability.md", import.meta.url), "utf8")
  ]);

  assert.match(packageReadme, /docs\/reference\/manifest-json-schema\.md/u);
  assert.match(landing, /\(reference\/manifest-json-schema\.md\)/u);
  assert.match(stability, /\(manifest-json-schema\.md\)/u);
});
