import type { ExecutionStatus } from "./index.js";

export interface AnalyticsEngineDataPoint {
  indexes?: ((ArrayBuffer | string) | null)[];
  doubles?: number[];
  blobs?: ((ArrayBuffer | string) | null)[];
}

export interface AnalyticsEngineDatasetLike {
  writeDataPoint: (event?: AnalyticsEngineDataPoint) => void;
}

export interface RecordUsageMetricRequest {
  executionId: string;
  tenantId: string;
  pluginId: string;
  hookName: string;
  status: ExecutionStatus;
  cpuMs: number;
  subrequests: number;
  workflowRuns: number;
  at: Date;
}

export interface GetDailyUsageSummaryRequest {
  tenantId: string;
  pluginId: string;
  date: string;
}

export interface DailyUsageSummary {
  tenantId: string;
  pluginId: string;
  date: string;
  executions: number;
  cpuMs: number;
  subrequests: number;
  workflowRuns: number;
}

export interface UsageMeter {
  recordExecutionUsage: (request: RecordUsageMetricRequest) => Promise<DailyUsageSummary>;
  getDailyUsageSummary: (request: GetDailyUsageSummaryRequest) => Promise<DailyUsageSummary>;
}

export interface DailyUsageSummaryStore {
  incrementDailyUsage: (request: RecordUsageMetricRequest) => Promise<DailyUsageSummary>;
  getDailyUsageSummary: (request: GetDailyUsageSummaryRequest) => Promise<DailyUsageSummary>;
}

export function createInMemoryUsageMeter(
  params: {
    analytics?: AnalyticsEngineDatasetLike;
  } = {}
): UsageMeter {
  return createUsageMeter({
    summaries: createInMemoryDailyUsageSummaryStore(),
    ...(params.analytics === undefined ? {} : { analytics: params.analytics })
  });
}

export function createUsageMeter(params: {
  analytics?: AnalyticsEngineDatasetLike;
  summaries: DailyUsageSummaryStore;
}): UsageMeter {
  return {
    recordExecutionUsage: async (request) => {
      validateUsageMetric(request);
      const date = usageDate(request.at);
      params.analytics?.writeDataPoint(analyticsDataPoint(request, date));
      return params.summaries.incrementDailyUsage(request);
    },
    getDailyUsageSummary: (request) => params.summaries.getDailyUsageSummary(request)
  };
}

export function createInMemoryDailyUsageSummaryStore(): DailyUsageSummaryStore {
  const summaries = new Map<string, DailyUsageSummary>();
  const locks = new Map<string, Promise<void>>();

  return {
    incrementDailyUsage: (request) =>
      withSummaryLock(locks, summaryKey(metricSummaryKey(request)), () => {
        const key = metricSummaryKey(request);
        const mapKey = summaryKey(key);
        const current = summaries.get(mapKey) ?? emptySummary(key);
        const updated = {
          ...current,
          executions: current.executions + 1,
          cpuMs: current.cpuMs + request.cpuMs,
          subrequests: current.subrequests + request.subrequests,
          workflowRuns: current.workflowRuns + request.workflowRuns
        };
        summaries.set(mapKey, updated);
        return cloneSummary(updated);
      }),
    getDailyUsageSummary: (request) =>
      Promise.resolve(cloneSummary(summaries.get(summaryKey(request)) ?? emptySummary(request)))
  };
}

function analyticsDataPoint(
  request: RecordUsageMetricRequest,
  date: string
): AnalyticsEngineDataPoint {
  return {
    indexes: [analyticsBillingIndex(request)],
    blobs: [
      request.tenantId,
      request.pluginId,
      request.executionId,
      request.hookName,
      request.status,
      date
    ],
    doubles: [1, request.cpuMs, request.subrequests, request.workflowRuns]
  };
}

function analyticsBillingIndex(request: RecordUsageMetricRequest): string {
  // Workers Analytics Engine records only one index per data point; combining tenant/plugin
  // preserves sampling by the billing dimension while raw IDs remain queryable in blobs.
  return `${request.tenantId}:${request.pluginId}`;
}

async function withSummaryLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T> | T
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(
    () => next,
    () => next
  );
  locks.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === tail) {
      locks.delete(key);
    }
  }
}

function validateUsageMetric(request: RecordUsageMetricRequest): void {
  validateNonNegativeFinite("cpuMs", request.cpuMs);
  validateNonNegativeInteger("subrequests", request.subrequests);
  validateNonNegativeInteger("workflowRuns", request.workflowRuns);
}

function validateNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}

function validateNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite integer`);
  }
}

function metricSummaryKey(request: RecordUsageMetricRequest): GetDailyUsageSummaryRequest {
  return {
    tenantId: request.tenantId,
    pluginId: request.pluginId,
    date: usageDate(request.at)
  };
}

function summaryKey(key: GetDailyUsageSummaryRequest): string {
  return `${key.tenantId}:${key.pluginId}:${key.date}`;
}

function usageDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function emptySummary(key: GetDailyUsageSummaryRequest): DailyUsageSummary {
  return {
    tenantId: key.tenantId,
    pluginId: key.pluginId,
    date: key.date,
    executions: 0,
    cpuMs: 0,
    subrequests: 0,
    workflowRuns: 0
  };
}

function cloneSummary(summary: DailyUsageSummary): DailyUsageSummary {
  return { ...summary };
}
