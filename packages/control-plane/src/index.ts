export type ExecutionStatus = "success" | "error" | "timeout" | "egress_denied" | "budget_exceeded";

export interface CapabilityCallRecord {
  name: string;
  status: "success" | "denied" | "error";
}

export interface ExecutionRecord {
  id: string;
  tenantId: string;
  pluginId: string;
  hookName: string;
  version: string;
  status: ExecutionStatus;
  durationMs: number;
  error?: string;
  capabilityCalls: readonly CapabilityCallRecord[];
  createdAt: Date;
}

export interface ExecutionSearchQuery {
  tenantId?: string;
  pluginId?: string;
  hookName?: string;
  status?: ExecutionStatus;
}

export interface ExecutionLogStore {
  writeExecution: (record: ExecutionRecord) => ExecutionRecord;
  searchExecutions: (query: ExecutionSearchQuery) => readonly ExecutionRecord[];
}

export function createInMemoryExecutionLogStore(): ExecutionLogStore {
  const executions: ExecutionRecord[] = [];

  return {
    writeExecution: (record) => {
      const stored = cloneExecution(record);
      executions.push(stored);
      return cloneExecution(stored);
    },
    searchExecutions: (query) =>
      executions
        .filter((record) => matchesQuery(record, query))
        .map((record) => cloneExecution(record))
  };
}

function matchesQuery(record: ExecutionRecord, query: ExecutionSearchQuery): boolean {
  return (
    (query.tenantId === undefined || record.tenantId === query.tenantId) &&
    (query.pluginId === undefined || record.pluginId === query.pluginId) &&
    (query.hookName === undefined || record.hookName === query.hookName) &&
    (query.status === undefined || record.status === query.status)
  );
}

function cloneExecution(record: ExecutionRecord): ExecutionRecord {
  return {
    ...record,
    capabilityCalls: record.capabilityCalls.map((call) => ({ ...call })),
    createdAt: new Date(record.createdAt)
  };
}

export {
  ControlPlaneApiError,
  createControlPlaneApi,
  toControlPlaneErrorResponse,
  type ArtifactStore,
  type ControlPlaneApi,
  type ControlPlaneErrorEnvelope,
  type ControlPlaneErrorResponse,
  type ControlPlaneErrorStatus,
  type ControlPlaneExecutionRecord,
  type ControlPlaneStore,
  type CreateAppRequest,
  type CreateTenantRequest,
  type InstallPluginRequest,
  type ListPluginVersionsRequest,
  type RegisterPluginRequest,
  type RegisterPluginVersionRequest,
  type RollbackAuditRecord,
  type RollbackInstallationRequest,
  type RollbackResult,
  type SetInstallationEnabledRequest,
  type UpdateInstallationConfigRequest,
  type UpdateInstallationPriorityRequest
} from "./api.js";

export {
  ArtifactAlreadyExistsError,
  createD1ControlPlaneStore,
  createR2ArtifactStore,
  type AppRecord,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type InstallationRecord,
  type PluginRecord,
  type PluginVersionRecord,
  type R2BucketLike,
  type ResolvedInstallation,
  type TenantRecord
} from "./storage.js";
