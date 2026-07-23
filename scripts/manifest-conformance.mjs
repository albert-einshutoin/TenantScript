import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const allowedRootFields = new Set(["schemaVersion", "manifestSchemaId", "cases"]);
const allowedCaseFields = new Set(["id", "rule", "expected", "input"]);
const identifierPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export const MANIFEST_CONFORMANCE_RULES = new Set([
  "capability.key.syntax",
  "config.default.type-match",
  "config.required.non-empty",
  "egress.allowlist.non-empty",
  "hook.priority.integer",
  "hook.schema-version-range.semver",
  "hook.timeout.positive-integer",
  "hook.type.enum",
  "hooks.non-empty",
  "hooks.unique-name",
  "limits.positive-integer",
  "manifest.valid",
  "name.syntax",
  "object.closed",
  "version.syntax"
]);

export const MANIFEST_CONFORMANCE_CASE_IDS = [
  "accept-allowlist",
  "accept-capability-config-reference",
  "accept-config-default",
  "accept-minimal-deny",
  "accept-priority",
  "reject-capability-key",
  "reject-config-default-type",
  "reject-config-required-empty",
  "reject-duplicate-hooks",
  "reject-empty-allowlist",
  "reject-empty-hooks",
  "reject-fractional-cpu",
  "reject-fractional-hook-priority",
  "reject-fractional-hook-timeout",
  "reject-invalid-hook-type",
  "reject-invalid-name",
  "reject-invalid-schema-range",
  "reject-invalid-version",
  "reject-unknown-field",
  "reject-zero-limit"
];

export function validateManifestConformanceCorpus(input) {
  if (!isRecord(input)) return invalid("corpus must be an object");
  if (hasUnknownField(input, allowedRootFields)) return invalid("unknown corpus field");
  if (input.schemaVersion !== "1.0.0") return invalid("unsupported corpus version");
  if (
    input.manifestSchemaId !==
    "https://raw.githubusercontent.com/albert-einshutoin/TenantScript/main/docs/reference/tenantscript-manifest.schema.json"
  ) {
    return invalid("unexpected manifest schema id");
  }
  if (!Array.isArray(input.cases) || input.cases.length === 0) {
    return invalid("cases must not be empty");
  }

  const ids = new Set();
  let previousId = "";
  for (const candidate of input.cases) {
    if (!isRecord(candidate)) return invalid("case must be an object");
    if (hasUnknownField(candidate, allowedCaseFields)) return invalid("unknown field in case");
    if (typeof candidate.id !== "string" || !identifierPattern.test(candidate.id)) {
      return invalid("invalid case id");
    }
    if (ids.has(candidate.id)) return invalid("case ids must be unique");
    if (candidate.id <= previousId) return invalid("cases must be ordered by id");
    if (typeof candidate.rule !== "string" || !MANIFEST_CONFORMANCE_RULES.has(candidate.rule)) {
      return invalid("unknown rule");
    }
    if (candidate.expected !== "accept" && candidate.expected !== "reject") {
      return invalid("invalid expectation");
    }
    if (!Object.hasOwn(candidate, "input")) return invalid("case input is required");

    ids.add(candidate.id);
    previousId = candidate.id;
  }
  if (
    input.cases.length !== MANIFEST_CONFORMANCE_CASE_IDS.length ||
    input.cases.some((candidate, index) => candidate.id !== MANIFEST_CONFORMANCE_CASE_IDS[index])
  ) {
    return invalid("unexpected case set");
  }

  return { ok: true, value: input };
}

export function runManifestConformance(corpusInput, parseManifest) {
  const corpusResult = validateManifestConformanceCorpus(corpusInput);
  if (!corpusResult.ok) {
    throw new Error(`Invalid manifest conformance corpus: ${corpusResult.error}`);
  }
  if (typeof parseManifest !== "function") {
    throw new TypeError("parseManifest must be a function");
  }

  const results = corpusResult.value.cases.map((testCase) => {
    let parsed;
    try {
      parsed = parseManifest(structuredClone(testCase.input));
    } catch {
      throw new Error("Manifest conformance parser failed");
    }
    if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
      throw new Error("Manifest conformance parser returned an invalid result");
    }
    const accepted = parsed.ok;
    const actual = accepted ? "accept" : "reject";

    // Portable reports intentionally omit parser diagnostics and manifest values so
    // adapters cannot turn untrusted conformance input into an accidental data channel.
    return {
      id: testCase.id,
      rule: testCase.rule,
      expected: testCase.expected,
      actual,
      passed: actual === testCase.expected
    };
  });
  const passed = results.filter((result) => result.passed).length;

  return {
    protocolVersion: "1.0.0",
    corpusVersion: corpusResult.value.schemaVersion,
    total: results.length,
    passed,
    failed: results.length - passed,
    results
  };
}

function hasUnknownField(value, allowedFields) {
  return Object.keys(value).some((field) => !allowedFields.has(field));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(error) {
  return { ok: false, error };
}

async function main() {
  const corpus = JSON.parse(
    await readFile(new URL("../spec/manifest/v1/conformance.json", import.meta.url), "utf8")
  );
  const { parseManifest } = await import("../packages/manifest/dist/index.js");
  const report = runManifestConformance(corpus, parseManifest);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.failed > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch {
    process.stderr.write('{"error":"manifest-conformance-failed"}\n');
    process.exitCode = 1;
  }
}
