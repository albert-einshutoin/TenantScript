import { valid as validSemanticVersion } from "semver";
import type { D1DatabaseLike } from "./storage.js";

export const TELEMETRY_SCHEMA_VERSION = 1 as const;

export type TelemetryRuntimePrimitive =
  | "cloudflare-workers"
  | "dynamic-workers"
  | "workers-for-platforms";

export type TelemetryConfiguration =
  | { enabled: false }
  | {
      enabled: true;
      endpoint: string;
      productVersion: string;
      runtimePrimitive: TelemetryRuntimePrimitive;
    };

export interface TelemetryAggregateSnapshot {
  enabledInstallations: number;
  executions: number;
  errors: {
    runtime: number;
    timeout: number;
    egressDenied: number;
    budgetExceeded: number;
  };
}

export interface PublicTelemetryEvent {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  generatedAt: string;
  productVersion: string;
  runtimePrimitive: TelemetryRuntimePrimitive;
  counts: TelemetryAggregateSnapshot;
}

export interface TelemetryStatus {
  enabled: boolean;
  mode: "disabled" | "anonymous-aggregate";
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
}

export interface TelemetrySnapshotSource {
  readAggregateSnapshot: () => Promise<TelemetryAggregateSnapshot>;
}

export interface TelemetrySink {
  send: (event: PublicTelemetryEvent) => Promise<void>;
}

export type TelemetryScheduleResult = { sent: false; reason: "disabled" } | { sent: true };

export function parseTelemetryConfiguration(input: {
  enabled?: string;
  endpoint?: string;
  productVersion?: string;
  runtimePrimitive?: string;
}): TelemetryConfiguration {
  if (input.enabled === undefined || input.enabled === "false") {
    return { enabled: false };
  }
  if (input.enabled !== "true") {
    throw new Error("telemetry enabled must be true or false");
  }
  if (input.endpoint === undefined || input.endpoint.trim() === "") {
    throw new Error("telemetry endpoint is required when enabled");
  }
  const endpoint = validateTelemetryEndpoint(input.endpoint);
  if (input.productVersion === undefined || !isSemanticVersion(input.productVersion)) {
    throw new Error("telemetry productVersion must be a semantic version");
  }
  if (!isRuntimePrimitive(input.runtimePrimitive)) {
    throw new Error(
      "telemetry runtimePrimitive must be cloudflare-workers, dynamic-workers, or workers-for-platforms"
    );
  }
  return {
    enabled: true,
    endpoint,
    productVersion: input.productVersion,
    runtimePrimitive: input.runtimePrimitive
  };
}

export function publicTelemetryStatus(configuration: TelemetryConfiguration): TelemetryStatus {
  return {
    enabled: configuration.enabled,
    mode: configuration.enabled ? "anonymous-aggregate" : "disabled",
    schemaVersion: TELEMETRY_SCHEMA_VERSION
  };
}

export async function runTelemetrySchedule(params: {
  configuration: TelemetryConfiguration;
  source: TelemetrySnapshotSource;
  sink: TelemetrySink;
  now?: () => Date;
}): Promise<TelemetryScheduleResult> {
  if (!params.configuration.enabled) {
    // This early return is the privacy boundary: default-off must not even read aggregate state,
    // because a future source could perform network I/O or access deployment-owned data.
    return { sent: false, reason: "disabled" };
  }
  const snapshot = await params.source.readAggregateSnapshot();
  const now = (params.now ?? (() => new Date()))();
  if (Number.isNaN(now.getTime())) {
    throw new Error("telemetry generatedAt must be a valid date");
  }
  const event = publicTelemetryEvent({
    generatedAt: now.toISOString(),
    productVersion: params.configuration.productVersion,
    runtimePrimitive: params.configuration.runtimePrimitive,
    snapshot
  });
  await params.sink.send(event);
  return { sent: true };
}

export function createD1TelemetrySnapshotSource(db: D1DatabaseLike): TelemetrySnapshotSource {
  return {
    readAggregateSnapshot: async () => {
      // A single aggregate-only statement ensures no tenant/plugin identifier, payload, config,
      // provider error, or execution row can cross the telemetry source boundary.
      const row = await db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM installations WHERE enabled = 1) AS enabled_installations,
             COUNT(*) AS executions,
             COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS runtime_errors,
             COALESCE(SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END), 0) AS timeouts,
             COALESCE(SUM(CASE WHEN status = 'egress_denied' THEN 1 ELSE 0 END), 0) AS egress_denied,
             COALESCE(SUM(CASE WHEN status = 'budget_exceeded' THEN 1 ELSE 0 END), 0) AS budget_exceeded
           FROM executions`
        )
        .first<TelemetryCountRow>();
      if (row === null) {
        throw new Error("telemetry aggregate query returned no row");
      }
      return {
        enabledInstallations: aggregateCount(row.enabled_installations, "enabled_installations"),
        executions: aggregateCount(row.executions, "executions"),
        errors: {
          runtime: aggregateCount(row.runtime_errors, "runtime_errors"),
          timeout: aggregateCount(row.timeouts, "timeouts"),
          egressDenied: aggregateCount(row.egress_denied, "egress_denied"),
          budgetExceeded: aggregateCount(row.budget_exceeded, "budget_exceeded")
        }
      };
    }
  };
}

export function createHttpTelemetrySink(params: {
  endpoint: string;
  fetcher?: typeof fetch;
}): TelemetrySink {
  const endpoint = validateTelemetryEndpoint(params.endpoint);
  const fetcher = params.fetcher ?? fetch;
  return {
    send: async (event) => {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sanitizePublicTelemetryEvent(event)),
        redirect: "error"
      });
      if (!response.ok) {
        // Never read or reflect the receiver body: it is outside the self-host trust boundary and
        // could contain operational data or credentials from an upstream proxy.
        throw new Error("telemetry endpoint rejected the event");
      }
    }
  };
}

function publicTelemetryEvent(params: {
  generatedAt: string;
  productVersion: string;
  runtimePrimitive: TelemetryRuntimePrimitive;
  snapshot: TelemetryAggregateSnapshot;
}): PublicTelemetryEvent {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    generatedAt: params.generatedAt,
    productVersion: params.productVersion,
    runtimePrimitive: params.runtimePrimitive,
    counts: sanitizeAggregateSnapshot(params.snapshot)
  };
}

function sanitizePublicTelemetryEvent(event: PublicTelemetryEvent): PublicTelemetryEvent {
  const runtimeSchemaVersion = (event as { schemaVersion: unknown }).schemaVersion;
  if (runtimeSchemaVersion !== TELEMETRY_SCHEMA_VERSION) {
    throw new Error("telemetry schemaVersion must be 1");
  }
  const generatedAt = Date.parse(event.generatedAt);
  if (!Number.isFinite(generatedAt) || new Date(generatedAt).toISOString() !== event.generatedAt) {
    throw new Error("telemetry generatedAt must be an ISO timestamp");
  }
  if (!isSemanticVersion(event.productVersion)) {
    throw new Error("telemetry productVersion must be a semantic version");
  }
  if (!isRuntimePrimitive(event.runtimePrimitive)) {
    throw new Error("telemetry runtimePrimitive is invalid");
  }
  return publicTelemetryEvent({
    generatedAt: event.generatedAt,
    productVersion: event.productVersion,
    runtimePrimitive: event.runtimePrimitive,
    snapshot: event.counts
  });
}

function sanitizeAggregateSnapshot(
  snapshot: TelemetryAggregateSnapshot
): TelemetryAggregateSnapshot {
  return {
    enabledInstallations: aggregateCount(snapshot.enabledInstallations, "enabledInstallations"),
    executions: aggregateCount(snapshot.executions, "executions"),
    errors: {
      runtime: aggregateCount(snapshot.errors.runtime, "errors.runtime"),
      timeout: aggregateCount(snapshot.errors.timeout, "errors.timeout"),
      egressDenied: aggregateCount(snapshot.errors.egressDenied, "errors.egressDenied"),
      budgetExceeded: aggregateCount(snapshot.errors.budgetExceeded, "errors.budgetExceeded")
    }
  };
}

function validateTelemetryEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("telemetry endpoint must be a public HTTPS URL");
  }
  const hostname = endpoint.hostname.toLowerCase();
  if (
    endpoint.protocol !== "https:" ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".test") ||
    hostname.endsWith(".invalid") ||
    /^[0-9.]+$/.test(hostname) ||
    hostname.includes(":") ||
    hostname === "" ||
    !hostname.includes(".")
  ) {
    throw new Error("telemetry endpoint must be a public HTTPS URL");
  }
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error("telemetry endpoint must not contain credentials, query, or fragment");
  }
  return endpoint.toString();
}

function isSemanticVersion(value: string): boolean {
  return validSemanticVersion(value) === value;
}

function isRuntimePrimitive(value: unknown): value is TelemetryRuntimePrimitive {
  return (
    value === "cloudflare-workers" ||
    value === "dynamic-workers" ||
    value === "workers-for-platforms"
  );
}

function aggregateCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`telemetry ${field} must be a non-negative safe integer`);
  }
  return value as number;
}

interface TelemetryCountRow {
  enabled_installations: unknown;
  executions: unknown;
  runtime_errors: unknown;
  timeouts: unknown;
  egress_denied: unknown;
  budget_exceeded: unknown;
}
