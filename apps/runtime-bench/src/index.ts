interface Env {
  LOADER: WorkerLoaderBinding;
}

interface WorkerLoaderBinding {
  load: (code: WorkerCode) => DynamicWorkerStub;
  get: (id: string, getCode: () => WorkerCode | Promise<WorkerCode>) => DynamicWorkerStub;
}

interface DynamicWorkerStub {
  getEntrypoint: () => {
    fetch: (request: Request) => Promise<Response>;
  };
}

interface WorkerCode {
  compatibilityDate: string;
  mainModule: string;
  modules: Record<string, string>;
  globalOutbound: null;
}

interface WebhookPayload {
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface BenchmarkResponse {
  mode: "get" | "load";
  iterations: number;
  warmup: number;
  measured: number;
  addedLatencyMs: PercentileSummary;
  dynamicLatencyMs: PercentileSummary;
  baselineLatencyMs: PercentileSummary;
}

interface PercentileSummary {
  min: number;
  p50: number;
  p95: number;
  max: number;
}

const dynamicWorkerCode = {
  compatibilityDate: "2026-06-12",
  mainModule: "index.js",
  modules: {
    "index.js": `
      export default {
        async fetch(request) {
          const payload = await request.json();
          return Response.json({
            headers: {
              ...payload.headers,
              "x-tenantscript-bench": "dynamic-worker"
            },
            body: {
              ...payload.body,
              transformedBy: "runtime-bench"
            }
          });
        }
      };
    `
  },
  globalOutbound: null
} satisfies WorkerCode;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (url.pathname !== "/bench") {
      return new Response("Not found", { status: 404 });
    }

    const mode = url.searchParams.get("mode") === "load" ? "load" : "get";
    const iterations = boundedInteger(url.searchParams.get("iterations"), 80, 1, 300);
    const warmup = boundedInteger(url.searchParams.get("warmup"), 10, 0, iterations - 1);
    const result = await runBenchmark({ env, mode, iterations, warmup });

    return Response.json(result);
  }
};

async function runBenchmark(params: {
  env: Env;
  mode: "get" | "load";
  iterations: number;
  warmup: number;
}): Promise<BenchmarkResponse> {
  const baselineDurations: number[] = [];
  const dynamicDurations: number[] = [];
  const addedDurations: number[] = [];
  const cachedWorker =
    params.mode === "get"
      ? params.env.LOADER.get("payload-transformer:v1", () => dynamicWorkerCode)
      : undefined;

  for (let index = 0; index < params.iterations; index += 1) {
    const measurement = await measureIteration({
      env: params.env,
      mode: params.mode,
      cachedWorker,
      payload: createPayload(index)
    });

    if (index >= params.warmup) {
      baselineDurations.push(measurement.baselineDuration);
      dynamicDurations.push(measurement.dynamicDuration);
      addedDurations.push(Math.max(0, measurement.dynamicDuration - measurement.baselineDuration));
    }
  }

  return {
    mode: params.mode,
    iterations: params.iterations,
    warmup: params.warmup,
    measured: addedDurations.length,
    addedLatencyMs: summarize(addedDurations),
    dynamicLatencyMs: summarize(dynamicDurations),
    baselineLatencyMs: summarize(baselineDurations)
  };
}

async function measureIteration(params: {
  env: Env;
  mode: "get" | "load";
  cachedWorker: DynamicWorkerStub | undefined;
  payload: WebhookPayload;
}): Promise<{ baselineDuration: number; dynamicDuration: number }> {
  const baselineStarted = performance.now();
  localTransform(params.payload);
  const baselineDuration = performance.now() - baselineStarted;

  const worker =
    params.mode === "load" ? params.env.LOADER.load(dynamicWorkerCode) : params.cachedWorker;
  if (worker === undefined) {
    throw new Error("cached worker was not initialized");
  }

  const dynamicStarted = performance.now();
  const response = await worker.getEntrypoint().fetch(
    new Request("https://tenantscript.local/webhook.outbound", {
      method: "POST",
      body: JSON.stringify(params.payload)
    })
  );
  await readTransformedPayload(response);

  return {
    baselineDuration,
    dynamicDuration: performance.now() - dynamicStarted
  };
}

function createPayload(index: number): WebhookPayload {
  return {
    headers: { "content-type": "application/json" },
    body: {
      invoiceId: `inv_${String(index)}`,
      amountCents: 150000
    }
  };
}

function localTransform(payload: WebhookPayload): WebhookPayload {
  return {
    headers: {
      ...payload.headers,
      "x-tenantscript-bench": "local"
    },
    body: {
      ...payload.body,
      transformedBy: "runtime-bench"
    }
  };
}

async function readTransformedPayload(response: Response): Promise<WebhookPayload> {
  if (!response.ok) {
    throw new Error(`dynamic worker returned ${String(response.status)}`);
  }

  const body: unknown = await response.json();
  if (!isWebhookPayload(body)) {
    throw new Error("dynamic worker returned invalid transform payload");
  }

  return body;
}

function summarize(values: readonly number[]): PercentileSummary {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: round(sorted[0] ?? 0),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    max: round(sorted.at(-1) ?? 0)
  };
}

function percentile(sortedValues: readonly number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sortedValues.length) - 1)
  );
  return sortedValues[index] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function boundedInteger(
  rawValue: string | null,
  defaultValue: number,
  minimum: number,
  maximum: number
): number {
  if (rawValue === null) {
    return defaultValue;
  }

  const value = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(value)) {
    return defaultValue;
  }

  return Math.min(maximum, Math.max(minimum, value));
}

function isWebhookPayload(value: unknown): value is WebhookPayload {
  return (
    isRecord(value) &&
    isStringRecord(value.headers) &&
    isRecord(value.body) &&
    value.body.transformedBy === "runtime-bench"
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry): entry is string => typeof entry === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
