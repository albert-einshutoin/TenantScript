import type { D1DatabaseLike } from "./storage.js";

export type AdminExecutionStatus =
  | "success"
  | "error"
  | "timeout"
  | "egress_denied"
  | "budget_exceeded";

export interface AdminExecutionDetail {
  id: string;
  pluginId: string;
  hookName: string;
  version: string;
  status: AdminExecutionStatus;
  durationMs: number;
  errorCode?: "execution_failed" | "execution_timeout" | "egress_denied" | "budget_exceeded";
  capabilityCalls: readonly {
    name: string;
    status: "success" | "denied" | "error";
  }[];
  createdAt: string;
}

export interface AdminExecutionDetailStore {
  readExecution: (request: {
    appId: string;
    tenantId: string;
    id: string;
  }) => Promise<AdminExecutionDetail | null>;
}

export function createD1AdminExecutionDetailStore(db: D1DatabaseLike): AdminExecutionDetailStore {
  return { readExecution: (request) => readExecution(db, request) };
}

async function readExecution(
  db: D1DatabaseLike,
  request: { appId: string; tenantId: string; id: string }
): Promise<AdminExecutionDetail | null> {
  const row = await db
    .prepare(
      [
        "SELECT e.id, e.plugin_id, e.hook_name, e.version, e.status, e.duration_ms,",
        "e.capability_calls_json, e.created_at",
        "FROM executions e",
        "JOIN tenants t ON t.id = e.tenant_id",
        "JOIN plugins p ON p.id = e.plugin_id",
        // The raw error column is deliberately not selected. It can contain provider messages,
        // customer payload fragments, or PII, so Admin receives only a status-derived code.
        "WHERE t.id = ?1 AND t.app_id = ?2 AND p.app_id = t.app_id AND e.id = ?3"
      ].join(" ")
    )
    .bind(request.tenantId, request.appId, request.id)
    .first<ExecutionDetailRow>();
  if (row === null) return null;

  const status = executionStatus(row.status);
  const errorCode = executionErrorCode(status);
  return {
    id: requiredString(row.id),
    pluginId: requiredString(row.plugin_id),
    hookName: requiredString(row.hook_name),
    version: requiredString(row.version),
    status,
    durationMs: requiredSafeInteger(row.duration_ms),
    ...(errorCode === undefined ? {} : { errorCode }),
    capabilityCalls: capabilityCalls(row.capability_calls_json),
    createdAt: requiredString(row.created_at)
  };
}

function executionErrorCode(
  status: AdminExecutionStatus
): AdminExecutionDetail["errorCode"] | undefined {
  switch (status) {
    case "success":
      return undefined;
    case "error":
      return "execution_failed";
    case "timeout":
      return "execution_timeout";
    case "egress_denied":
      return "egress_denied";
    case "budget_exceeded":
      return "budget_exceeded";
  }
}

function capabilityCalls(value: unknown): AdminExecutionDetail["capabilityCalls"] {
  if (typeof value !== "string") throw new Error("invalid execution detail");
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("invalid execution detail");
  return parsed.map((call) => {
    if (
      typeof call !== "object" ||
      call === null ||
      Array.isArray(call) ||
      typeof (call as Record<string, unknown>).name !== "string" ||
      !isCapabilityStatus((call as Record<string, unknown>).status)
    ) {
      throw new Error("invalid execution detail");
    }
    return {
      name: (call as { name: string }).name,
      status: (call as { status: "success" | "denied" | "error" }).status
    };
  });
}

function executionStatus(value: unknown): AdminExecutionStatus {
  if (
    value === "success" ||
    value === "error" ||
    value === "timeout" ||
    value === "egress_denied" ||
    value === "budget_exceeded"
  ) {
    return value;
  }
  throw new Error("invalid execution detail");
}

function isCapabilityStatus(value: unknown): value is "success" | "denied" | "error" {
  return value === "success" || value === "denied" || value === "error";
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("invalid execution detail");
  return value;
}

function requiredSafeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid execution detail");
  }
  return value;
}

interface ExecutionDetailRow {
  id: unknown;
  plugin_id: unknown;
  hook_name: unknown;
  version: unknown;
  status: unknown;
  duration_ms: unknown;
  capability_calls_json: unknown;
  created_at: unknown;
}
