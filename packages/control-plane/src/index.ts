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
  AdminApprovalDecisionError,
  createD1AdminApprovalDecisionStore,
  type AdminApprovalDecisionRequest,
  type AdminApprovalDecisionResult,
  type AdminApprovalDecisionStore
} from "./admin-approvals.js";
export {
  ControlPlaneApiError,
  createControlPlaneApi,
  createStaticTokenIdentityResolver,
  toControlPlaneErrorResponse,
  type ApprovalDecision,
  type ApprovalContinuationRequest,
  type ApprovalDecisionPayload,
  type ApprovalRecord,
  type ApprovalState,
  type ArtifactStore,
  type AuthenticatedIdentity,
  type ContinuationRunner,
  type ControlPlaneApi,
  type ControlPlaneErrorEnvelope,
  type ControlPlaneErrorResponse,
  type ControlPlaneErrorStatus,
  type ControlPlaneExecutionRecord,
  type ControlPlaneStore,
  type ConnectSlackWorkspaceRequest,
  type CreateAppRequest,
  type CreateTenantRequest,
  type DecideApprovalRequest,
  type IdentityResolver,
  type InstallPluginRequest,
  type ListPluginVersionsRequest,
  type RegisterPluginRequest,
  type RegisterPluginVersionRequest,
  type RollbackAuditRecord,
  type RollbackInstallationRequest,
  type RollbackResult,
  type SetInstallationEnabledRequest,
  type SlackOAuthClient,
  type SlackOAuthTokenResponse,
  type UpdateInstallationConfigRequest,
  type UpdateInstallationPriorityRequest
} from "./api.js";

export {
  approvalDecisionTransitions,
  resolveApprovalDecisionTransition,
  type ApprovalDecisionTransition
} from "./approval-state.js";

export {
  RBAC_OPERATIONS,
  RBAC_ROLES,
  canRolePerform,
  isSupportedRbacRole,
  isRbacOperation,
  normalizeRbacRole,
  type RbacOperation,
  type RbacRole,
  type SupportedRbacRole
} from "./rbac.js";

export {
  ServiceTokenError,
  createD1ServiceTokenStore,
  createServiceTokenAwareIdentityResolver,
  createServiceTokenIdentityResolver,
  createServiceTokenManager,
  isServiceTokenCredential,
  type ServiceTokenErrorCode,
  type ServiceTokenManager,
  type ServiceTokenRecord,
  type ServiceTokenStore
} from "./service-tokens.js";

export {
  createDurableObjectDailyUsageCounter,
  createInMemoryDailyUsageCounter,
  type DailyUsageCounter,
  type DailyUsageCounterStorage,
  type DailyUsageKey,
  type DailyUsageRecord,
  type RecordExecutionUsageRequest
} from "./usage-counter.js";

export {
  createInMemoryDailyUsageSummaryStore,
  createInMemoryUsageMeter,
  createAnalyticsEngineUsageSink,
  createUsageMeter,
  type AnalyticsEngineDataPoint,
  type AnalyticsEngineDatasetLike,
  type DailyUsageSummary,
  type DailyUsageSummaryStore,
  type GetDailyUsageSummariesRequest,
  type GetDailyUsageSummaryRequest,
  type RecordUsageMetricRequest,
  type UsageEvent,
  type UsageHookType,
  type UsageMeter,
  type UsageMeterFailure,
  type UsageSink,
  UsageMeterQueryError
} from "./usage-meter.js";

export {
  enforceBudgetBeforeExecution,
  reEnableBudgetDisabledInstallation,
  type BudgetExceededNotification,
  type BudgetGuardResult,
  type BudgetGuardStore,
  type BudgetNotificationSink,
  type DailyBudget
} from "./budget-guard.js";

export {
  ArtifactAlreadyExistsError,
  createD1ControlPlaneStore,
  createD1SlackConnectionStore,
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

export {
  createD1AuditLogStore,
  type AppendAuditEvent,
  type AuditEvent,
  type AuditLogStore,
  type AuditScope,
  type AuditValue,
  type AuditVerificationResult
} from "./audit-log.js";

export {
  createD1R2ExecutionArchiveStore,
  type ArchiveExpiredExecutionsRequest,
  type ExecutionArchiveManifest,
  type ExecutionArchiveScope,
  type ExecutionArchiveSearchQuery,
  type ExecutionArchiveStore,
  type ExecutionArchiveStoreOptions
} from "./execution-archive.js";

export {
  createAuditExportService,
  verifyAuditExport,
  type AuditExportManifest,
  type AuditExportRequest,
  type AuditExportResult,
  type AuditExportService,
  type AuditExportServiceOptions
} from "./audit-export.js";

export {
  createDurableObjectSecretStore,
  createInMemorySecretStore,
  type PutSecretRequest,
  type SecretRef,
  type SecretStore,
  type SecretStoreStorage
} from "./secret-store.js";

export {
  createInMemorySlackConnectionStore,
  type InspectableSlackConnectionStore,
  type SlackConnectionRecord,
  type SlackConnectionStore
} from "./slack-connection-store.js";

export {
  AdminInstallFlowError,
  createD1AdminInstallFlowStore,
  type AdminInstallCapability,
  type AdminInstallConfigField,
  type AdminInstallFlowStore,
  type AdminInstallPreview,
  type AdminInstallRequest,
  type AdminInstallResult,
  type D1AdminInstallFlowStoreOptions
} from "./admin-install-flow.js";

export {
  createD1AdminInstallRequestStore,
  type AdminInstallRequestResult,
  type AdminInstallRequestStore
} from "./admin-install-requests.js";

export {
  createControlPlaneHttpHandler,
  type AdminRole,
  type ControlPlaneHttpHandler,
  type ControlPlaneHttpHandlerOptions,
  type TenantScopedAdminIdentity
} from "./http-api.js";

export {
  createAdminMutationRateLimiter,
  createDurableObjectAdminMutationRateLimitStore,
  evaluateFixedWindowReservation,
  parseAdminMutationRateLimitConfiguration,
  type AdminMutationFamily,
  type AdminMutationRateLimiter,
  type AdminMutationRateLimitRequest,
  type AdminMutationRateLimitResult,
  type AdminMutationRateLimitStore
} from "./admin-mutation-rate-limit.js";

export {
  createD1AdminDashboardStore,
  createAdminCursorCodec,
  type AdminApprovalSummary,
  type AdminCursorCodec,
  type AdminCursorPayload,
  type AdminDashboardScope,
  type AdminDashboardSection,
  type AdminDashboardSectionPage,
  type AdminDashboardStore,
  type AdminExecutionSummary,
  type AdminExecutionFilters,
  type AdminInstallationSummary,
  type AdminPluginVersionSummary,
  type AdminUsageSummary
} from "./admin-dashboard.js";

export {
  createD1AdminExecutionDetailStore,
  type AdminExecutionDetail,
  type AdminExecutionDetailStore,
  type AdminExecutionStatus
} from "./admin-executions.js";

export {
  SchemaMigrationBlockedError,
  createD1SchemaMigrationTracker,
  parsePublishedHookSchemaCatalog,
  type PublishedHookSchemaCatalog,
  type SchemaMigrationBlocker,
  type SchemaMigrationStatus,
  type SchemaMigrationTracker,
  type SchemaMigrationVersionStatus
} from "./schema-migrations.js";

export {
  createD1RunawayGuardStore,
  enforceRunawayPolicyAfterExecution,
  recoverRunawayInstallation,
  type RunawayExecutionOutcome,
  type RunawayGuardResult,
  type RunawayGuardState,
  type RunawayGuardStore,
  type RunawayNotificationSink,
  type RunawayPolicy,
  type RunawayQuarantineNotification,
  type RunawayQuarantineReason
} from "./runaway-guard.js";

export {
  createD1AdminInstallationCommandStore,
  createD1AdminInstallationDetailStore,
  type AdminInstallationCommandResult,
  type AdminInstallationCommandStore,
  type AdminCapabilityMetadata,
  type D1AdminInstallationCommandStoreOptions,
  type AdminConfigFieldMetadata,
  type AdminEgressMetadata,
  type AdminInstallationDetail,
  type AdminInstallationDetailStore
} from "./admin-installations.js";

export {
  AdminRollbackError,
  createD1AdminRollbackStore,
  type AdminRollbackRequest,
  type AdminRollbackResult,
  type AdminRollbackStore,
  type D1AdminRollbackStoreOptions
} from "./admin-rollbacks.js";

export {
  TELEMETRY_SCHEMA_VERSION,
  createD1TelemetrySnapshotSource,
  createHttpTelemetrySink,
  parseTelemetryConfiguration,
  publicTelemetryStatus,
  runTelemetrySchedule,
  type PublicTelemetryEvent,
  type TelemetryAggregateSnapshot,
  type TelemetryConfiguration,
  type TelemetryRuntimePrimitive,
  type TelemetryScheduleResult,
  type TelemetrySink,
  type TelemetrySnapshotSource,
  type TelemetryStatus
} from "./telemetry.js";

export {
  createAppDatabaseRouterFromBindings,
  createStaticAppDatabaseRouter,
  type AppDatabaseRoute,
  type AppDatabaseRouter
} from "./app-database-router.js";

export {
  ADMIN_HTTP_ENDPOINT_CONTRACTS,
  matchAdminHttpEndpoint,
  type AdminHttpEndpointContract,
  type AdminHttpEndpointId,
  type AdminHttpEndpointMatch,
  type AdminHttpIsolation,
  type AdminRoute
} from "./http-api.js";
