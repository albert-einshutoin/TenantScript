import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [catalog, httpApi, workerEntry, readme] = await Promise.all([
  readFile(new URL("../docs/reference/control-plane-errors.md", import.meta.url), "utf8"),
  readFile(new URL("../packages/control-plane/src/http-api.ts", import.meta.url), "utf8"),
  readFile(new URL("../packages/control-plane/src/worker-entry.ts", import.meta.url), "utf8"),
  readFile(new URL("../README.md", import.meta.url), "utf8")
]);

const nonErrorSnakeCaseLiterals = new Set(["budget_exceeded", "egress_denied", "same_version"]);

function sourceErrorCodes() {
  const snakeCase = [
    ...(httpApi + workerEntry).matchAll(/["']([a-z][a-z0-9]*(?:_[a-z0-9]+)+)["']/gu)
  ]
    .map((match) => match[1])
    .filter((code) => !nonErrorSnakeCaseLiterals.has(code));
  const directSingleWord = [...httpApi.matchAll(/errorResponse\(\s*\d+,\s*"([a-z]+)"/gu)].map(
    (match) => match[1]
  );
  return [...new Set([...snakeCase, ...directSingleWord])].sort();
}

function catalogRows() {
  // Markdown formatters pad table cells for readability, so the contract parser deliberately
  // ignores cell-edge whitespace while keeping the public code and status strict.
  return [...catalog.matchAll(/^\|\s*`([a-z][a-z0-9_]*)`\s*\|\s*(\d{3})\s*\|/gmu)].map((match) => ({
    code: match[1],
    status: Number(match[2])
  }));
}

test("catalogs every public source error code exactly once", () => {
  const sourceCodes = sourceErrorCodes();
  const rows = catalogRows();
  assert.ok(sourceCodes.length >= 50, "source error extraction unexpectedly shrank");
  assert.equal(
    new Set(rows.map(({ code }) => code)).size,
    rows.length,
    "catalog has duplicate codes"
  );
  assert.deepEqual(rows.map(({ code }) => code).sort(), sourceCodes);
});

test("keeps literal errorResponse status values aligned with the catalog", () => {
  const statuses = new Map(catalogRows().map(({ code, status }) => [code, status]));
  for (const match of httpApi.matchAll(/errorResponse\(\s*(\d+),\s*"([a-z][a-z0-9_]*)"/gu)) {
    assert.equal(statuses.get(match[2]), Number(match[1]), `${match[2]} status drifted`);
  }
});

test("documents the safe client contract and stable entrypoint", () => {
  assert.match(catalog, /branch on `error\.code`, not `error\.message`/u);
  assert.match(catalog, /cross-tenant[^]*same `404`/iu);
  assert.match(catalog, /provider[^]*storage[^]*never reflected/iu);
  assert.match(catalog, /Retryability[^]*Client action/u);
  assert.match(readme, /docs\/reference\/control-plane-errors\.md/u);
});
