import type { ExecutionStatus } from "./index.js";

export interface AnalyticsEngineDataPoint {
  indexes?: ((ArrayBuffer | string) | null)[];
  doubles?: number[];
  blobs?: ((ArrayBuffer | string) | null)[];
}

export interface AnalyticsEngineDatasetLike {
  writeDataPoint: (event?: AnalyticsEngineDataPoint) => void;
}

export type UsageHookType = "event" | "transform" | "policy";

export interface RecordUsageMetricRequest {
  tenantId: string;
  pluginId: string;
  hookType: UsageHookType;
  status: ExecutionStatus;
  cpuMs: number;
  subrequests: number;
  workflowRuns: number;
  at: Date;
}

export interface UsageEvent {
  tenantId: string;
  pluginId: string;
  hookType: UsageHookType;
  status: ExecutionStatus;
  executions: 1;
  cpuMs: number;
  subrequests: number;
  workflowRuns: number;
}

export interface UsageSink {
  writeUsage: (event: UsageEvent) => Promise<void> | void;
}

export interface UsageMeterFailure {
  code: "usage_sink_write_failed";
  tenantId: string;
  pluginId: string;
}

export class UsageMeterQueryError extends Error {
  override readonly name = "UsageMeterQueryError";
  readonly code = "invalid_usage_query";
}

export interface GetDailyUsageSummaryRequest {
  tenantId: string;
  pluginId: string;
  date: string;
}

export interface GetDailyUsageSummariesRequest {
  tenantId: string;
  pluginId?: string;
  fromDate: string;
  toDate: string;
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
  getDailyUsageSummaries: (
    request: GetDailyUsageSummariesRequest
  ) => Promise<readonly DailyUsageSummary[]>;
}

export interface DailyUsageSummaryStore {
  incrementDailyUsage: (request: RecordUsageMetricRequest) => Promise<DailyUsageSummary>;
  getDailyUsageSummary: (request: GetDailyUsageSummaryRequest) => Promise<DailyUsageSummary>;
  getDailyUsageSummaries: (
    request: GetDailyUsageSummariesRequest
  ) => Promise<readonly DailyUsageSummary[]>;
}

export function createAnalyticsEngineUsageSink(analytics: AnalyticsEngineDatasetLike): UsageSink {
  return {
    writeUsage: (event) => {
      analytics.writeDataPoint({
        indexes: [`${event.tenantId}:${event.pluginId}`],
        blobs: [event.tenantId, event.pluginId, event.hookType, event.status],
        doubles: [event.executions, event.cpuMs, event.subrequests, event.workflowRuns]
      });
    }
  };
}

export function createInMemoryUsageMeter(
  params: {
    analytics?: AnalyticsEngineDatasetLike;
    reportFailure?: (failure: UsageMeterFailure) => Promise<void> | void;
  } = {}
): UsageMeter {
  return createUsageMeter({
    summaries: createInMemoryDailyUsageSummaryStore(),
    ...(params.analytics === undefined
      ? {}
      : { sink: createAnalyticsEngineUsageSink(params.analytics) }),
    ...(params.reportFailure === undefined ? {} : { reportFailure: params.reportFailure })
  });
}

export function createUsageMeter(params: {
  sink?: UsageSink;
  summaries: DailyUsageSummaryStore;
  reportFailure?: (failure: UsageMeterFailure) => Promise<void> | void;
}): UsageMeter {
  const failureReporter = params.reportFailure ?? defaultUsageFailureReporter;
  return {
    recordExecutionUsage: async (request) => {
      validateUsageMetric(request);
      const summary = await params.summaries.incrementDailyUsage(request);
      if (params.sink !== undefined) {
        try {
          await params.sink.writeUsage(toUsageEvent(request));
        } catch {
          // Metering is operational telemetry, not execution authority. A provider outage must not
          // turn a successful plugin execution into a failure or expose the provider error text.
          await reportUsageFailure(failureReporter, {
            code: "usage_sink_write_failed",
            tenantId: request.tenantId,
            pluginId: request.pluginId
          });
        }
      }
      return summary;
    },
    getDailyUsageSummary: async (request) => {
      validateDailyUsageKey(request);
      return params.summaries.getDailyUsageSummary(request);
    },
    getDailyUsageSummaries: async (request) => {
      validateUsageRange(request);
      return params.summaries.getDailyUsageSummaries(request);
    }
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
      Promise.resolve(cloneSummary(summaries.get(summaryKey(request)) ?? emptySummary(request))),
    getDailyUsageSummaries: (request) =>
      Promise.resolve(
        [...summaries.values()]
          .filter(
            (summary) =>
              summary.tenantId === request.tenantId &&
              (request.pluginId === undefined || summary.pluginId === request.pluginId) &&
              summary.date >= request.fromDate &&
              summary.date <= request.toDate
          )
          .sort(
            (left, right) =>
              left.date.localeCompare(right.date) || left.pluginId.localeCompare(right.pluginId)
          )
          .map(cloneSummary)
      )
  };
}

function toUsageEvent(request: RecordUsageMetricRequest): UsageEvent {
  // Constructing an exact DTO here ensures accidental payload/config fields on a structural input
  // can never cross the Analytics Engine boundary.
  return {
    tenantId: request.tenantId,
    pluginId: request.pluginId,
    hookType: request.hookType,
    status: request.status,
    executions: 1,
    cpuMs: request.cpuMs,
    subrequests: request.subrequests,
    workflowRuns: request.workflowRuns
  };
}

async function reportUsageFailure(
  reporter: ((failure: UsageMeterFailure) => Promise<void> | void) | undefined,
  failure: UsageMeterFailure
): Promise<void> {
  try {
    await reporter?.(failure);
  } catch {
    // A broken internal logger is subject to the same fail-open rule as the telemetry provider.
  }
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
    if (locks.get(key) === tail) locks.delete(key);
  }
}

function validateUsageMetric(request: RecordUsageMetricRequest): void {
  validateIdentifier("tenantId", request.tenantId);
  validateIdentifier("pluginId", request.pluginId);
  if (!(["event", "transform", "policy"] as const).includes(request.hookType)) {
    throw new Error("hookType must be event, transform, or policy");
  }
  if (
    !(["success", "error", "timeout", "egress_denied", "budget_exceeded"] as const).includes(
      request.status
    )
  ) {
    throw new Error("status must be a known execution status");
  }
  validateNonNegativeFinite("cpuMs", request.cpuMs);
  validateNonNegativeInteger("subrequests", request.subrequests);
  validateNonNegativeInteger("workflowRuns", request.workflowRuns);
  if (Number.isNaN(request.at.getTime())) throw new Error("at must be a valid date");
}

function defaultUsageFailureReporter(failure: UsageMeterFailure): void {
  console.warn("TenantScript usage metering failed", failure);
}

function validateIdentifier(name: string, value: string): void {
  if (value.trim() === "" || value.length > 256) {
    throw new Error(`${name} must be a non-empty bounded string`);
  }
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

function validateDailyUsageKey(request: GetDailyUsageSummaryRequest): void {
  validateIdentifier("tenantId", request.tenantId);
  validateIdentifier("pluginId", request.pluginId);
  validateUtcDate(request.date);
}

function validateUsageRange(request: GetDailyUsageSummariesRequest): void {
  validateQueryIdentifier("tenantId", request.tenantId);
  if (request.pluginId !== undefined) validateQueryIdentifier("pluginId", request.pluginId);
  const from = validateUtcDate(request.fromDate);
  const to = validateUtcDate(request.toDate);
  if (from > to) throw new UsageMeterQueryError("fromDate must not be after toDate");
  if (to - from > 365 * 24 * 60 * 60 * 1000) {
    throw new UsageMeterQueryError("usage summary range must not exceed 366 UTC days");
  }
}

function validateQueryIdentifier(name: string, value: string): void {
  if (value.trim() === "" || value.length > 256) {
    throw new UsageMeterQueryError(`${name} must be a non-empty bounded string`);
  }
}

function validateUtcDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new UsageMeterQueryError("usage date must use YYYY-MM-DD");
  }
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw new UsageMeterQueryError("usage date must be a valid UTC date");
  }
  return time;
}

function metricSummaryKey(request: RecordUsageMetricRequest): GetDailyUsageSummaryRequest {
  return { tenantId: request.tenantId, pluginId: request.pluginId, date: usageDate(request.at) };
}

function summaryKey(key: GetDailyUsageSummaryRequest): string {
  return JSON.stringify([key.tenantId, key.pluginId, key.date]);
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
