import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../packages/manifest/dist/index.js";
import { runManifestConformance } from "./manifest-conformance.mjs";
import {
  MAX_MANIFEST_CONFORMANCE_REPORT_BYTES,
  validateManifestConformanceReport
} from "./manifest-conformance-verify.mjs";

const corpusUrl = new URL("../spec/manifest/v1/conformance.json", import.meta.url);
const verifierPath = fileURLToPath(new URL("./manifest-conformance-verify.mjs", import.meta.url));

async function readCorpus() {
  return JSON.parse(await readFile(corpusUrl, "utf8"));
}

async function createValidReport() {
  const corpus = await readCorpus();
  return {
    corpus,
    report: runManifestConformance(corpus, parseManifest)
  };
}

function runVerifier(input) {
  return spawnSync(process.execPath, [verifierPath], {
    input,
    maxBuffer: MAX_MANIFEST_CONFORMANCE_REPORT_BYTES * 2
  });
}

test("accepts only the complete canonical report contract", async () => {
  const { corpus, report } = await createValidReport();

  assert.deepEqual(validateManifestConformanceReport(report, corpus), {
    ok: true,
    value: {
      protocolVersion: "1.0.0",
      conformant: true,
      total: 21
    }
  });
});

test("rejects report shape, identity, expectation, and decision drift", async () => {
  const { corpus, report } = await createValidReport();
  const mutations = [
    (copy) => (copy.unknown = true),
    (copy) => (copy.protocolVersion = "2.0.0"),
    (copy) => (copy.corpusVersion = "2.0.0"),
    (copy) => (copy.total = 20),
    (copy) => copy.results.pop(),
    (copy) => copy.results.push(structuredClone(copy.results[0])),
    (copy) => copy.results.reverse(),
    (copy) => (copy.results[0].id = "accept-rewritten"),
    (copy) => (copy.results[0].rule = "manifest.valid"),
    (copy) => (copy.results[0].expected = "reject"),
    (copy) => (copy.results[0].actual = "reject"),
    (copy) => (copy.results[0].actual = "maybe"),
    (copy) => (copy.results[0].diagnostic = "ts_conformance_sentinel")
  ];

  for (const mutate of mutations) {
    const copy = structuredClone(report);
    mutate(copy);
    assert.equal(validateManifestConformanceReport(copy, corpus).ok, false);
  }
});

test("publishes one closed success line for a canonical adapter report", async () => {
  const { report } = await createValidReport();
  const result = runVerifier(`${JSON.stringify(report)}\n`);

  assert.equal(result.status, 0);
  assert.equal(
    result.stdout.toString("utf8"),
    '{"protocolVersion":"1.0.0","conformant":true,"total":21}\n'
  );
  assert.equal(result.stderr.toString("utf8"), "");
});

test("fails closed without reflecting malformed, oversized, or invalid UTF-8 input", () => {
  const invalidInputs = [
    '{"diagnostic":"ts_conformance_sentinel"}\n',
    `${"x".repeat(MAX_MANIFEST_CONFORMANCE_REPORT_BYTES + 1)}\n`,
    Buffer.from([0xff, 0xfe, 0xfd])
  ];

  for (const input of invalidInputs) {
    const result = runVerifier(input);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.toString("utf8"), "");
    assert.equal(
      result.stderr.toString("utf8"),
      '{"error":"manifest-conformance-report-invalid"}\n'
    );
    assert.doesNotMatch(result.stderr.toString("utf8"), /sentinel|diagnostic|\/Volumes/u);
  }
});

test("rejects duplicate JSON members at the root and inside results before parsing", async () => {
  const { report } = await createValidReport();
  const serialized = JSON.stringify(report);
  const duplicateInputs = [
    serialized.replace(
      '"protocolVersion":"1.0.0"',
      '"protocolVersion":"ts_conformance_sentinel","protocolVersion":"1.0.0"'
    ),
    serialized.replace('"actual":"accept"', '"actual":"ts_conformance_sentinel","actual":"accept"'),
    serialized.replace(
      '"actual":"accept"',
      '"\\u0061ctual":"ts_conformance_sentinel","actual":"accept"'
    )
  ];

  for (const input of duplicateInputs) {
    const result = runVerifier(input);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.toString("utf8"), "");
    assert.equal(
      result.stderr.toString("utf8"),
      '{"error":"manifest-conformance-report-invalid"}\n'
    );
    assert.doesNotMatch(result.stderr.toString("utf8"), /sentinel|protocolVersion|actual/u);
  }
});

test("wires the fail-closed pipe contract into Tier 1 and the public specification", async () => {
  const [workflow, specification] = await Promise.all(
    ["../.github/workflows/tier1.yml", "../docs/spec/manifest-v1.md"].map((path) =>
      readFile(new URL(path, import.meta.url), "utf8")
    )
  );

  for (const contract of [workflow, specification]) {
    assert.match(contract, /set -o pipefail/u);
    assert.match(
      contract,
      /node scripts\/manifest-conformance\.mjs \|\s+node scripts\/manifest-conformance-verify\.mjs/u
    );
  }
  assert.match(specification, /Input is limited to\s+64 KiB/u);
  assert.match(specification, /does not attest to the adapter's sandbox/u);
});
