import type { ControlPlaneExecutionRecord } from "./api.js";
import type { UsageHookType, UsageMeter } from "./usage-meter.js";

export interface ExecutionUsageMetrics {
  hookType: UsageHookType;
  cpuMs: number;
  subrequests: number;
  workflowRuns: number;
}

export interface ExecutionUsageRecordingRequest {
  execution: ControlPlaneExecutionRecord;
  metrics: ExecutionUsageMetrics;
}

export interface ExecutionUsageRecorderFailure {
  code: "execution_usage_recording_failed";
  tenantId: string;
  pluginId: string;
}

export interface ExecutionUsageRecorder {
  record: (request: ExecutionUsageRecordingRequest) => Promise<ControlPlaneExecutionRecord>;
}

export type ExecutionUsageRecorderErrorCode = "execution_usage_invalid_request";

export class ExecutionUsageRecorderError extends Error {
  override readonly name = "ExecutionUsageRecorderError";

  constructor(readonly code: ExecutionUsageRecorderErrorCode) {
    super(code);
  }

  toJSON(): { code: ExecutionUsageRecorderErrorCode } {
    return { code: this.code };
  }
}

interface ExecutionUsageRecorderConfiguration {
  store: {
    writeExecution: (
      record: ControlPlaneExecutionRecord
    ) => Promise<ControlPlaneExecutionRecord> | ControlPlaneExecutionRecord;
  };
  usageMeter: UsageMeter;
  reportFailure?: (failure: ExecutionUsageRecorderFailure) => Promise<void> | void;
}

export function createExecutionUsageRecorder(
  params: ExecutionUsageRecorderConfiguration
): ExecutionUsageRecorder {
  validateConfiguration(params);

  return {
    record: async (request) => {
      validateRequest(request);
      const persisted = await params.store.writeExecution(request.execution);
      validateExecution(persisted);

      try {
        // The persisted execution is the authority for identity, outcome, and time. Callers supply
        // only runtime measurements so a stale or compromised caller cannot meter another scope.
        await params.usageMeter.recordExecutionUsage({
          tenantId: persisted.tenantId,
          pluginId: persisted.pluginId,
          hookType: request.metrics.hookType,
          status: persisted.status,
          cpuMs: request.metrics.cpuMs,
          subrequests: request.metrics.subrequests,
          workflowRuns: request.metrics.workflowRuns,
          at: persisted.createdAt
        });
      } catch {
        // Usage is observability, not execution authority. Never replay either mutation or turn a
        // successfully persisted plugin result into a failure because its metric could not write.
        if (params.reportFailure !== undefined) {
          try {
            await params.reportFailure({
              code: "execution_usage_recording_failed",
              tenantId: persisted.tenantId,
              pluginId: persisted.pluginId
            });
          } catch {
            // A diagnostic sink must not become a second execution authority.
          }
        }
      }

      return persisted;
    }
  };
}

function validateConfiguration(value: unknown): asserts value is {
  store: ExecutionUsageRecorderConfiguration["store"];
  usageMeter: ExecutionUsageRecorderConfiguration["usageMeter"];
  reportFailure?: ExecutionUsageRecorderConfiguration["reportFailure"];
} {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["store", "usageMeter", "reportFailure"]) ||
    !isRecord(value.store) ||
    typeof value.store.writeExecution !== "function" ||
    !isRecord(value.usageMeter) ||
    !hasExactKeys(value.usageMeter, [
      "recordExecutionUsage",
      "getDailyUsageSummary",
      "getDailyUsageSummaries"
    ]) ||
    typeof value.usageMeter.recordExecutionUsage !== "function" ||
    typeof value.usageMeter.getDailyUsageSummary !== "function" ||
    typeof value.usageMeter.getDailyUsageSummaries !== "function" ||
    (value.reportFailure !== undefined && typeof value.reportFailure !== "function")
  ) {
    throw invalidRequest();
  }
}

function validateRequest(value: unknown): asserts value is ExecutionUsageRecordingRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["execution", "metrics"]) ||
    !isRecord(value.metrics) ||
    !hasExactKeys(value.metrics, ["hookType", "cpuMs", "subrequests", "workflowRuns"]) ||
    !(["event", "transform", "policy"] as const).includes(
      value.metrics.hookType as UsageHookType
    ) ||
    !isNonNegativeFinite(value.metrics.cpuMs) ||
    !isNonNegativeInteger(value.metrics.subrequests) ||
    !isNonNegativeInteger(value.metrics.workflowRuns)
  ) {
    throw invalidRequest();
  }
  validateExecution(value.execution);
}

function validateExecution(value: unknown): asserts value is ControlPlaneExecutionRecord {
  if (!isRecord(value)) throw invalidRequest();
  const keys = [
    "id",
    "tenantId",
    "pluginId",
    "hookName",
    "version",
    "status",
    "durationMs",
    "capabilityCalls",
    "createdAt",
    ...(value.error === undefined ? [] : ["error"])
  ];
  if (
    !hasExactKeys(value, keys) ||
    !isIdentifier(value.id) ||
    !isIdentifier(value.tenantId) ||
    !isIdentifier(value.pluginId) ||
    !isBoundedText(value.hookName, 256) ||
    !isBoundedText(value.version, 128) ||
    !(["success", "error", "timeout", "egress_denied", "budget_exceeded"] as const).includes(
      value.status as ControlPlaneExecutionRecord["status"]
    ) ||
    !isNonNegativeFinite(value.durationMs) ||
    (value.error !== undefined && !isBoundedText(value.error, 4_096)) ||
    !Array.isArray(value.capabilityCalls) ||
    value.capabilityCalls.length > 256 ||
    !value.capabilityCalls.every(isCapabilityCall) ||
    !(value.createdAt instanceof Date) ||
    Number.isNaN(value.createdAt.getTime())
  ) {
    throw invalidRequest();
  }
}

function isCapabilityCall(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["name", "status"]) &&
    isBoundedText(value.name, 256) &&
    (["success", "denied", "error"] as const).includes(
      value.status as ControlPlaneExecutionRecord["capabilityCalls"][number]["status"]
    )
  );
}

function isIdentifier(value: unknown): value is string {
  return isBoundedText(value, 256) && !hasControlCharacter(value);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= maximum;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function invalidRequest(): ExecutionUsageRecorderError {
  return new ExecutionUsageRecorderError("execution_usage_invalid_request");
}
