import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { runRuntimeBenchmark, validateRuntimeBenchmarkBaseUrl } from "./runtime-benchmark-live.mjs";

const sourceRevision = "a".repeat(40);
const baseUrl = "https://tenantscript-runtime-bench.example.org";
const accessClientId = "tier2-client-id";
const accessClientSecret = "tier2-client-secret-sentinel";

function summary(p95) {
  return { min: 1, p50: 2, p95, max: p95 + 1 };
}

function benchmark(mode, iterations, warmup, p95) {
  return {
    mode,
    iterations,
    warmup,
    measured: iterations - warmup,
    addedLatencyMs: summary(p95),
    dynamicLatencyMs: summary(p95 + 5),
    baselineLatencyMs: summary(3)
  };
}

function response(value, init) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

function accessChallenge() {
  return new Response("", { status: 403 });
}

test("runs the fixed warm and cold scenarios and emits closed passing evidence", async () => {
  const requests = [];
  const responses = [
    accessChallenge(),
    response({ ok: true }),
    response(benchmark("get", 80, 10, 49)),
    response(benchmark("load", 40, 0, 299))
  ];
  const evidence = await runRuntimeBenchmark({
    baseUrl,
    sourceRevision,
    measuredAt: "2026-07-23T00:00:00.000Z",
    accessClientId,
    accessClientSecret,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return responses.shift();
    }
  });

  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      `${baseUrl}/health`,
      `${baseUrl}/health`,
      `${baseUrl}/bench?mode=get&iterations=80&warmup=10`,
      `${baseUrl}/bench?mode=load&iterations=40&warmup=0`
    ]
  );
  assert.deepEqual(requests[0].init.headers, { accept: "application/json" });
  assert(
    requests
      .slice(1)
      .every(
        ({ init }) =>
          init.method === "GET" &&
          init.redirect === "error" &&
          init.headers.accept === "application/json" &&
          init.headers["CF-Access-Client-Id"] === accessClientId &&
          init.headers["CF-Access-Client-Secret"] === accessClientSecret &&
          init.credentials === "omit" &&
          init.signal instanceof AbortSignal
      )
  );
  assert.deepEqual(evidence, {
    schemaVersion: 1,
    kind: "tenantscript-runtime-benchmark-evidence",
    repository: "albert-einshutoin/TenantScript",
    sourceRevision,
    measuredAt: "2026-07-23T00:00:00.000Z",
    scenarios: [
      {
        name: "warm-get",
        mode: "get",
        iterations: 80,
        warmup: 10,
        measured: 70,
        addedLatencyMs: summary(49),
        thresholdP95Ms: 50,
        status: "pass"
      },
      {
        name: "cold-load",
        mode: "load",
        iterations: 40,
        warmup: 0,
        measured: 40,
        addedLatencyMs: summary(299),
        thresholdP95Ms: 300,
        status: "pass"
      }
    ],
    decision: "pass"
  });
});

test("records a closed failed decision when either absolute p95 threshold is reached", async () => {
  const responses = [
    accessChallenge(),
    response({ ok: true }),
    response(benchmark("get", 80, 10, 50)),
    response(benchmark("load", 40, 0, 10))
  ];
  const evidence = await runRuntimeBenchmark({
    baseUrl,
    sourceRevision,
    measuredAt: "2026-07-23T00:00:00.000Z",
    accessClientId,
    accessClientSecret,
    fetchImpl: async () => responses.shift()
  });
  assert.equal(evidence.scenarios[0].status, "fail");
  assert.equal(evidence.decision, "fail");
});

test("rejects response widening, scenario drift, unsafe metrics, and secret-shaped data", async () => {
  const invalid = [
    { ...benchmark("get", 80, 10, 10), extra: "value" },
    benchmark("load", 80, 10, 10),
    { ...benchmark("get", 80, 10, 10), measured: 80 },
    { ...benchmark("get", 80, 10, 10), addedLatencyMs: summary(-1) },
    { ...benchmark("get", 80, 10, 10), addedLatencyMs: summary(Number.NaN) },
    {
      ...benchmark("get", 80, 10, 10),
      addedLatencyMs: { ...summary(10), detail: "Bearer secret-sentinel" }
    }
  ];

  for (const value of invalid) {
    const responses = [accessChallenge(), response({ ok: true }), response(value)];
    await assert.rejects(
      runRuntimeBenchmark({
        baseUrl,
        sourceRevision,
        measuredAt: "2026-07-23T00:00:00.000Z",
        accessClientId,
        accessClientSecret,
        fetchImpl: async () => responses.shift()
      }),
      /runtime benchmark failed/u
    );
  }
});

test("rejects redirects, HTTP failure, oversized bodies, and transport failure", async () => {
  for (const result of [
    new Response("", { status: 302, headers: { location: "https://example.org" } }),
    new Response("unavailable", { status: 503 }),
    new Response("x".repeat(65 * 1024), { status: 200 }),
    new Error("provider-secret-sentinel")
  ]) {
    await assert.rejects(
      runRuntimeBenchmark({
        baseUrl,
        sourceRevision,
        measuredAt: "2026-07-23T00:00:00.000Z",
        accessClientId,
        accessClientSecret,
        fetchImpl: async () => {
          if (result instanceof Error) throw result;
          return result;
        }
      }),
      /runtime benchmark failed/u
    );
  }
});

test("accepts only a public credential-free HTTPS benchmark origin", () => {
  assert.equal(validateRuntimeBenchmarkBaseUrl(baseUrl), `${baseUrl}/`);
  for (const value of [
    "http://example.org",
    "https://user:password@example.org",
    "https://example.org/path",
    "https://example.org/?token=redacted",
    "https://127.0.0.1",
    "https://[::1]",
    "https://runtime.internal",
    "https://example.org:8443"
  ]) {
    assert.throws(() => validateRuntimeBenchmarkBaseUrl(value), /runtime benchmark failed/u);
  }
});

test("requires bounded Access credentials without reflecting them into evidence", async () => {
  let requests = 0;
  await assert.rejects(
    runRuntimeBenchmark({
      baseUrl,
      sourceRevision,
      measuredAt: "2026-07-23T00:00:00.000Z",
      accessClientId: "",
      accessClientSecret,
      fetchImpl: async () => {
        requests += 1;
        return response({ ok: true });
      }
    }),
    /runtime benchmark failed/u
  );
  assert.equal(requests, 0);
  const responses = [
    accessChallenge(),
    response({ ok: true }),
    response(benchmark("get", 80, 10, 10)),
    response(benchmark("load", 40, 0, 10))
  ];
  const evidence = await runRuntimeBenchmark({
    baseUrl,
    sourceRevision,
    measuredAt: "2026-07-23T00:00:00.000Z",
    accessClientId,
    accessClientSecret,
    fetchImpl: async () => responses.shift()
  });
  assert.doesNotMatch(JSON.stringify(evidence), /tier2-client/u);
});

test("fails closed when the benchmark origin is not protected by Access", async () => {
  let requests = 0;
  await assert.rejects(
    runRuntimeBenchmark({
      baseUrl,
      sourceRevision,
      measuredAt: "2026-07-23T00:00:00.000Z",
      accessClientId,
      accessClientSecret,
      fetchImpl: async (_url, init) => {
        requests += 1;
        assert.deepEqual(init.headers, { accept: "application/json" });
        return response({ ok: true });
      }
    }),
    /runtime benchmark failed/u
  );
  assert.equal(requests, 1);
});

test("Tier 2 keeps credentials off PRs and preserves sanitized evidence", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/tier2-live.yml", import.meta.url),
    "utf8"
  );
  const guide = readFileSync(new URL("../docs/benchmarks/phase0.md", import.meta.url), "utf8");

  assert.doesNotMatch(workflow, /live Cloudflare smoke placeholder/u);
  assert.match(workflow, /vars\.TIER2_LIVE_ENABLED == 'true'/u);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /environment:\s*cloudflare-live/u);
  assert.match(workflow, /secrets\.CLOUDFLARE_API_TOKEN/u);
  assert.match(workflow, /secrets\.CLOUDFLARE_ACCOUNT_ID/u);
  assert.match(workflow, /secrets\.CF_ACCESS_CLIENT_ID/u);
  assert.match(workflow, /secrets\.CF_ACCESS_CLIENT_SECRET/u);
  assert.match(workflow, /vars\.TIER2_RUNTIME_BENCH_URL/u);
  assert.match(workflow, /node scripts\/runtime-benchmark-live\.mjs check-url/u);
  assert.match(workflow, /node scripts\/runtime-benchmark-live\.mjs run/u);
  assert.match(workflow, /actions\/upload-artifact@v6/u);
  assert.match(workflow, /if-no-files-found:\s*error/u);
  assert.doesNotMatch(workflow, /pull_request:/u);
  assert.match(guide, /TIER2_LIVE_ENABLED/u);
  assert.match(guide, /cloudflare-live/u);
  assert.match(guide, /not live\s+evidence/u);
});
