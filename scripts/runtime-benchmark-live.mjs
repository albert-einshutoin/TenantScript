import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const EVIDENCE_PATH = resolve(".tmp/tier2/runtime-benchmark-evidence.json");
const scenarios = [
  { name: "warm-get", mode: "get", iterations: 80, warmup: 10, thresholdP95Ms: 50 },
  { name: "cold-load", mode: "load", iterations: 40, warmup: 0, thresholdP95Ms: 300 }
];
const secretLike =
  /(?:bearer\s+|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:token|password|secret|api[_-]?key)\s*[=:])/iu;

function exactKeys(value, keys) {
  assert(
    typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
  );
  assert.deepEqual(Object.keys(value).sort(), keys);
}

function isPublicHostname(rawHostname) {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (isIP(hostname) !== 0) return false;
  try {
    if (new URL(`https://${hostname}/`).hostname.toLowerCase() !== hostname) return false;
  } catch {
    return false;
  }
  if (
    !hostname.includes(".") ||
    hostname.endsWith(".") ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/u.test(hostname)
  ) {
    return false;
  }
  return hostname
    .split(".")
    .every((label) => /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/u.test(label));
}

export function validateRuntimeBenchmarkBaseUrl(value) {
  try {
    assert(typeof value === "string" && value.length <= 500 && !secretLike.test(value));
    const url = new URL(value);
    assert.equal(url.protocol, "https:");
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert.equal(url.port, "");
    assert.equal(url.pathname, "/");
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
    assert(isPublicHostname(url.hostname));
    return url.href;
  } catch {
    throw new Error("runtime benchmark failed");
  }
}

function validateSummary(value) {
  exactKeys(value, ["max", "min", "p50", "p95"]);
  const metrics = [value.min, value.p50, value.p95, value.max];
  assert(metrics.every((metric) => Number.isFinite(metric) && metric >= 0 && metric <= 60_000));
  assert(value.min <= value.p50 && value.p50 <= value.p95 && value.p95 <= value.max);
  return { min: value.min, p50: value.p50, p95: value.p95, max: value.max };
}

function validateBenchmarkResponse(value, scenario) {
  exactKeys(value, [
    "addedLatencyMs",
    "baselineLatencyMs",
    "dynamicLatencyMs",
    "iterations",
    "measured",
    "mode",
    "warmup"
  ]);
  assert.equal(value.mode, scenario.mode);
  assert.equal(value.iterations, scenario.iterations);
  assert.equal(value.warmup, scenario.warmup);
  assert.equal(value.measured, scenario.iterations - scenario.warmup);
  const addedLatencyMs = validateSummary(value.addedLatencyMs);
  validateSummary(value.dynamicLatencyMs);
  validateSummary(value.baselineLatencyMs);
  return addedLatencyMs;
}

function validateAccessCredential(value) {
  assert(
    typeof value === "string" &&
      value.length >= 8 &&
      value.length <= 512 &&
      /^[A-Za-z0-9._~-]+$/u.test(value)
  );
}

async function fetchJson(fetchImpl, url, access) {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    headers: {
      accept: "application/json",
      "CF-Access-Client-Id": access.clientId,
      "CF-Access-Client-Secret": access.clientSecret
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  assert(response instanceof Response && !response.redirected && response.status === 200);
  assert(/^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? ""));
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    assert(/^\d+$/u.test(contentLength) && Number(contentLength) <= MAX_RESPONSE_BYTES);
  }
  const text = await readBoundedBody(response);
  assert(!secretLike.test(text));
  return JSON.parse(text);
}

async function readBoundedBody(response) {
  assert(response.body !== null);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    assert(value instanceof Uint8Array);
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

export async function runRuntimeBenchmark({
  baseUrl,
  sourceRevision,
  measuredAt,
  accessClientId,
  accessClientSecret,
  fetchImpl = fetch
}) {
  try {
    const origin = validateRuntimeBenchmarkBaseUrl(baseUrl);
    assert(typeof sourceRevision === "string" && /^[0-9a-f]{40}$/u.test(sourceRevision));
    assert(
      typeof measuredAt === "string" &&
        new Date(measuredAt).toISOString() === measuredAt &&
        measuredAt.length <= 64
    );
    validateAccessCredential(accessClientId);
    validateAccessCredential(accessClientSecret);
    const access = { clientId: accessClientId, clientSecret: accessClientSecret };
    const health = await fetchJson(fetchImpl, new URL("health", origin), access);
    exactKeys(health, ["ok"]);
    assert.equal(health.ok, true);

    const evidenceScenarios = [];
    for (const scenario of scenarios) {
      const url = new URL("bench", origin);
      url.searchParams.set("mode", scenario.mode);
      url.searchParams.set("iterations", String(scenario.iterations));
      url.searchParams.set("warmup", String(scenario.warmup));
      const addedLatencyMs = validateBenchmarkResponse(
        await fetchJson(fetchImpl, url, access),
        scenario
      );
      evidenceScenarios.push({
        ...scenario,
        measured: scenario.iterations - scenario.warmup,
        addedLatencyMs,
        // The absolute Phase 0 threshold is evidence-backed. A percentage regression gate must
        // wait for a reviewed live baseline instead of inventing one from repository fixtures.
        status: addedLatencyMs.p95 < scenario.thresholdP95Ms ? "pass" : "fail"
      });
    }
    return {
      schemaVersion: 1,
      kind: "tenantscript-runtime-benchmark-evidence",
      repository: "albert-einshutoin/TenantScript",
      sourceRevision,
      measuredAt,
      scenarios: evidenceScenarios,
      decision: evidenceScenarios.every(({ status }) => status === "pass") ? "pass" : "fail"
    };
  } catch {
    throw new Error("runtime benchmark failed");
  }
}

function ensureEvidenceDirectory() {
  for (const path of [resolve(".tmp"), resolve(".tmp/tier2")]) {
    if (!existsSync(path)) {
      mkdirSync(path);
      continue;
    }
    const stat = lstatSync(path);
    assert(stat.isDirectory() && !stat.isSymbolicLink());
  }
}

async function main() {
  const [command, baseUrlFlag, baseUrl, sourceFlag, sourceRevision] = process.argv.slice(2);
  if (baseUrlFlag !== "--base-url" || baseUrl === undefined) throw new Error("invalid arguments");
  validateRuntimeBenchmarkBaseUrl(baseUrl);
  if (command === "check-url" && process.argv.length === 5) return;
  if (
    command !== "run" ||
    sourceFlag !== "--source-revision" ||
    sourceRevision === undefined ||
    process.argv.length !== 7
  ) {
    throw new Error("invalid arguments");
  }
  const evidence = await runRuntimeBenchmark({
    baseUrl,
    sourceRevision,
    measuredAt: new Date().toISOString(),
    accessClientId: process.env.CF_ACCESS_CLIENT_ID,
    accessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET
  });
  ensureEvidenceDirectory();
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  if (evidence.decision !== "pass") throw new Error("threshold exceeded");
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch(() => {
    console.error("runtime benchmark failed");
    process.exitCode = 1;
  });
}
