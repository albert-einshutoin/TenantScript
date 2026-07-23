import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { validateManifestConformanceCorpus } from "./manifest-conformance.mjs";

export const MAX_MANIFEST_CONFORMANCE_REPORT_BYTES = 64 * 1024;

const MAX_JSON_NESTING_DEPTH = 32;
const reportFields = new Set(["protocolVersion", "corpusVersion", "total", "results"]);
const resultFields = new Set(["id", "rule", "expected", "actual"]);

export function validateManifestConformanceReport(reportInput, corpusInput) {
  const corpusResult = validateManifestConformanceCorpus(corpusInput);
  if (!corpusResult.ok) return invalid("invalid-corpus");
  if (!isRecord(reportInput) || !hasExactFields(reportInput, reportFields)) {
    return invalid("invalid-report-shape");
  }
  if (
    reportInput.protocolVersion !== "1.0.0" ||
    reportInput.corpusVersion !== corpusResult.value.schemaVersion
  ) {
    return invalid("unsupported-report-version");
  }
  if (
    reportInput.total !== corpusResult.value.cases.length ||
    !Array.isArray(reportInput.results) ||
    reportInput.results.length !== corpusResult.value.cases.length
  ) {
    return invalid("incomplete-report");
  }

  for (const [index, expectedCase] of corpusResult.value.cases.entries()) {
    const actualResult = reportInput.results[index];
    if (!isRecord(actualResult) || !hasExactFields(actualResult, resultFields)) {
      return invalid("invalid-result-shape");
    }
    if (
      actualResult.id !== expectedCase.id ||
      actualResult.rule !== expectedCase.rule ||
      actualResult.expected !== expectedCase.expected
    ) {
      return invalid("result-contract-drift");
    }
    if (
      (actualResult.actual !== "accept" && actualResult.actual !== "reject") ||
      actualResult.actual !== expectedCase.expected
    ) {
      return invalid("conformance-mismatch");
    }
  }

  return {
    ok: true,
    value: {
      protocolVersion: "1.0.0",
      conformant: true,
      total: corpusResult.value.cases.length
    }
  };
}

function hasExactFields(value, expectedFields) {
  const fields = Object.keys(value);
  return (
    fields.length === expectedFields.size && fields.every((field) => expectedFields.has(field))
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(error) {
  return { ok: false, error };
}

function parseJsonWithUniqueObjectMembers(text) {
  let offset = 0;

  function skipWhitespace() {
    while (
      text[offset] === " " ||
      text[offset] === "\t" ||
      text[offset] === "\n" ||
      text[offset] === "\r"
    ) {
      offset += 1;
    }
  }

  function parseString() {
    const start = offset;
    if (text[offset] !== '"') throw new SyntaxError("Expected a JSON string");
    offset += 1;

    while (offset < text.length) {
      if (text[offset] === '"') {
        offset += 1;
        return JSON.parse(text.slice(start, offset));
      }
      if (text[offset] === "\\") {
        offset += 2;
      } else {
        offset += 1;
      }
    }
    throw new SyntaxError("Unterminated JSON string");
  }

  function parseObject(depth) {
    const keys = new Set();
    offset += 1;
    skipWhitespace();
    if (text[offset] === "}") {
      offset += 1;
      return;
    }

    while (offset < text.length) {
      const key = parseString();
      if (keys.has(key)) throw new SyntaxError("Duplicate JSON object member");
      keys.add(key);
      skipWhitespace();
      if (text[offset] !== ":") throw new SyntaxError("Expected a JSON member separator");
      offset += 1;
      parseValue(depth);
      skipWhitespace();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      if (text[offset] !== ",") throw new SyntaxError("Expected a JSON object separator");
      offset += 1;
      skipWhitespace();
    }
    throw new SyntaxError("Unterminated JSON object");
  }

  function parseArray(depth) {
    offset += 1;
    skipWhitespace();
    if (text[offset] === "]") {
      offset += 1;
      return;
    }

    while (offset < text.length) {
      parseValue(depth);
      skipWhitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      if (text[offset] !== ",") throw new SyntaxError("Expected a JSON array separator");
      offset += 1;
      skipWhitespace();
    }
    throw new SyntaxError("Unterminated JSON array");
  }

  function parseValue(depth) {
    if (depth > MAX_JSON_NESTING_DEPTH) throw new SyntaxError("JSON nesting limit exceeded");
    skipWhitespace();
    const token = text[offset];
    if (token === "{") {
      parseObject(depth + 1);
      return;
    }
    if (token === "[") {
      parseArray(depth + 1);
      return;
    }
    if (token === '"') {
      parseString();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    }
    const number = text.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (number !== undefined) {
      offset += number.length;
      return;
    }
    throw new SyntaxError("Invalid JSON value");
  }

  // JSON.parse silently keeps the last duplicate member. Scan the bounded input
  // first so hidden diagnostics or secrets cannot be erased before closed-shape checks.
  parseValue(0);
  skipWhitespace();
  if (offset !== text.length) throw new SyntaxError("Unexpected data after JSON value");
  return JSON.parse(text);
}

async function readBoundedStdin() {
  const chunks = [];
  let totalBytes = 0;

  // Independent adapters are untrusted processes. Bound bytes before concatenation
  // so a diagnostic flood cannot turn a compatibility check into memory pressure.
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_MANIFEST_CONFORMANCE_REPORT_BYTES) {
      throw new Error("Manifest conformance report exceeds the input limit");
    }
    chunks.push(bytes);
  }

  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  return parseJsonWithUniqueObjectMembers(text);
}

async function main() {
  const [report, corpus] = await Promise.all([
    readBoundedStdin(),
    readFile(new URL("../spec/manifest/v1/conformance.json", import.meta.url), "utf8").then(
      JSON.parse
    )
  ]);
  const result = validateManifestConformanceReport(report, corpus);
  if (!result.ok) throw new Error("Manifest conformance report is invalid");
  process.stdout.write(`${JSON.stringify(result.value)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch {
    process.stderr.write('{"error":"manifest-conformance-report-invalid"}\n');
    process.exitCode = 1;
  }
}
