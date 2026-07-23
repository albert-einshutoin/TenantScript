import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseManifest } from "../packages/manifest/dist/index.js";
import {
  MANIFEST_CONFORMANCE_CASE_IDS,
  MANIFEST_CONFORMANCE_RULES,
  runManifestConformance,
  validateManifestConformanceCorpus
} from "./manifest-conformance.mjs";

const corpusUrl = new URL("../spec/manifest/v1/conformance.json", import.meta.url);

async function readCorpus() {
  return JSON.parse(await readFile(corpusUrl, "utf8"));
}

test("validates the closed, ordered manifest v1 corpus", async () => {
  const corpus = await readCorpus();
  const result = validateManifestConformanceCorpus(corpus);

  assert.deepEqual(result, { ok: true, value: corpus });
  assert.equal(corpus.schemaVersion, "1.0.0");
  assert.equal(corpus.cases.length, 20);
  assert.deepEqual(
    corpus.cases.map(({ id }) => id),
    MANIFEST_CONFORMANCE_CASE_IDS
  );
  assert.deepEqual(new Set(corpus.cases.map(({ rule }) => rule)), MANIFEST_CONFORMANCE_RULES);
});

test("publishes closed corpus and result schemas with the same stable rule set", async () => {
  const [corpusSchema, resultSchema] = await Promise.all(
    ["conformance.schema.json", "result.schema.json"].map(async (name) =>
      JSON.parse(await readFile(new URL(`../spec/manifest/v1/${name}`, import.meta.url), "utf8"))
    )
  );

  assert.equal(corpusSchema.additionalProperties, false);
  assert.equal(corpusSchema.properties.cases.items.additionalProperties, false);
  assert.deepEqual(
    new Set(corpusSchema.properties.cases.items.properties.rule.enum),
    MANIFEST_CONFORMANCE_RULES
  );
  assert.equal(resultSchema.additionalProperties, false);
  assert.equal(resultSchema.definitions.result.additionalProperties, false);
  assert.deepEqual(
    new Set(resultSchema.definitions.result.properties.rule.enum),
    MANIFEST_CONFORMANCE_RULES
  );
  assert.deepEqual(resultSchema.definitions.result.properties.actual.enum, ["accept", "reject"]);
  assert.equal(resultSchema.properties.total.const, MANIFEST_CONFORMANCE_CASE_IDS.length);
  assert.equal(resultSchema.properties.results.minItems, MANIFEST_CONFORMANCE_CASE_IDS.length);
  assert.equal(resultSchema.properties.results.maxItems, MANIFEST_CONFORMANCE_CASE_IDS.length);
  assert.equal(resultSchema.properties.results.additionalItems, false);
  assert.deepEqual(
    resultSchema.properties.results.items.map((item) => item.allOf[1].properties.id.const),
    MANIFEST_CONFORMANCE_CASE_IDS
  );
});

test("reference adapter matches every portable case without reflecting input or diagnostics", async () => {
  const corpus = await readCorpus();
  const report = runManifestConformance(corpus, parseManifest);

  assert.deepEqual(Object.keys(report), [
    "protocolVersion",
    "corpusVersion",
    "total",
    "passed",
    "failed",
    "results"
  ]);
  assert.equal(report.protocolVersion, "1.0.0");
  assert.equal(report.corpusVersion, "1.0.0");
  assert.equal(report.total, 20);
  assert.equal(report.passed, 20);
  assert.equal(report.failed, 0);
  assert.equal(report.results.length, 20);
  for (const result of report.results) {
    assert.deepEqual(Object.keys(result), ["id", "rule", "expected", "actual", "passed"]);
  }

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /input|diagnostic|error|ts_conformance_sentinel/u);
});

test("rejects corpus shape and policy drift before invoking a parser", async () => {
  const corpus = await readCorpus();
  const mutations = [
    ["unknown root field", (copy) => (copy.unknown = true), "unknown corpus field"],
    ["unknown case field", (copy) => (copy.cases[0].unknown = true), "unknown field in case"],
    [
      "duplicate case id",
      (copy) => (copy.cases[1].id = copy.cases[0].id),
      "case ids must be unique"
    ],
    ["unknown rule", (copy) => (copy.cases[0].rule = "runtime.secret"), "unknown rule"],
    ["empty corpus", (copy) => (copy.cases = []), "cases must not be empty"],
    ["missing case", (copy) => copy.cases.pop(), "unexpected case set"],
    [
      "unexpected case",
      (copy) =>
        copy.cases.push({
          id: "reject-zz-extra-case",
          rule: "manifest.valid",
          expected: "reject",
          input: null
        }),
      "unexpected case set"
    ],
    ["case order drift", (copy) => copy.cases.reverse(), "cases must be ordered by id"],
    ["invalid expectation", (copy) => (copy.cases[0].expected = "maybe"), "invalid expectation"]
  ];

  for (const [name, mutate, expectedMessage] of mutations) {
    const copy = structuredClone(corpus);
    mutate(copy);
    const result = validateManifestConformanceCorpus(copy);
    assert.equal(result.ok, false, name);
    if (result.ok) throw new Error("invalid corpus was accepted");
    assert.equal(result.error, expectedMessage, name);
  }
});

test("reports expectation drift with only stable identifiers", async () => {
  const corpus = await readCorpus();
  const copy = structuredClone(corpus);
  copy.cases[0].expected = copy.cases[0].expected === "accept" ? "reject" : "accept";

  const report = runManifestConformance(copy, parseManifest);

  assert.equal(report.failed, 1);
  assert.equal(report.passed, 19);
  assert.equal(report.results[0].passed, false);
  assert.deepEqual(Object.keys(report.results[0]), ["id", "rule", "expected", "actual", "passed"]);
});

test("fails closed when an adapter throws or returns an open result", async () => {
  const corpus = await readCorpus();

  assert.throws(
    () =>
      runManifestConformance(corpus, () => {
        throw new Error("ts_conformance_sentinel");
      }),
    new Error("Manifest conformance parser failed")
  );
  assert.throws(
    () =>
      runManifestConformance(corpus, () => ({ accepted: true, secret: "ts_conformance_sentinel" })),
    new Error("Manifest conformance parser returned an invalid result")
  );
});
