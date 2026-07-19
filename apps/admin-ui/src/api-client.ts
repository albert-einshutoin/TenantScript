import { z } from "zod";
import type { AdminDashboardSection, AuthenticatedIdentity } from "@tenantscript/control-plane";

export type AdminRole = "manager" | "viewer";

export interface AdminSession extends AuthenticatedIdentity {
  role: AdminRole;
  appId: string;
  tenantId: string;
}

export interface AdminSessionClient {
  resolveSession: (request: { token: string }) => Promise<AdminSession>;
}

export interface InstallationView {
  id: string;
  pluginKey: string;
  version: string;
  enabled: boolean;
  priority: number;
  revision: number;
  statusText: "enabled" | "disabled";
}

export interface PluginVersionView {
  id: string;
  pluginId: string;
  pluginKey: string;
  version: string;
  artifactHash: string;
  createdAt: Date;
}

export interface InstallPreview {
  versionId: string;
  pluginKey: string;
  version: string;
  configFields: readonly {
    name: string;
    type: "string" | "number" | "boolean";
    required: boolean;
    hasDefault: boolean;
  }[];
  capabilities: readonly {
    name: string;
    scopeKeys: readonly string[];
    configReferences: readonly string[];
  }[];
  egress: { mode: "deny" | "allowlist"; allowlistedHostCount: number };
}

export interface InstallPluginRequest {
  versionId: string;
  config: Record<string, string | number | boolean>;
  confirmedCapabilities: readonly string[];
  enabled: boolean;
  priority: number;
}

export interface InstallPluginResult {
  id: string;
  versionId: string;
  pluginKey: string;
  version: string;
  enabled: boolean;
  priority: number;
  revision: number;
}

export interface RollbackInstallationRequest {
  installationId: string;
  targetVersionId: string;
  expectedRevision: number;
}

export interface RollbackInstallationResult {
  installationId: string;
  pluginKey: string;
  fromVersion: string;
  toVersion: string;
  revision: number;
  auditId: string;
  completedAt: Date;
}

export interface DailyUsageSummaryView {
  date: string;
  executions: number;
  runtimeMs: number;
}

export interface ApprovalView {
  id: string;
  pluginId: string;
  role: string;
  resumeHook: string;
  state: "pending" | "approved" | "rejected" | "expired";
  expiresAt: Date;
  createdAt: Date;
}

export interface ExecutionView {
  id: string;
  pluginId: string;
  hookName: string;
  version: string;
  status: "success" | "error" | "timeout" | "egress_denied" | "budget_exceeded";
  durationMs: number;
  capabilityNames: readonly string[];
  createdAt: Date;
}

export interface ExecutionSearchRequest {
  pluginId?: string;
  hookName?: string;
  status?: ExecutionView["status"];
  cursor?: string;
}

export interface ExecutionSearchPage {
  items: readonly ExecutionView[];
  nextCursor?: string;
}

export interface ExecutionDetailView {
  id: string;
  pluginId: string;
  hookName: string;
  version: string;
  status: ExecutionView["status"];
  durationMs: number;
  errorCode?: "execution_failed" | "execution_timeout" | "egress_denied" | "budget_exceeded";
  capabilityCalls: readonly {
    name: string;
    status: "success" | "denied" | "error";
  }[];
  createdAt: Date;
}

export interface DashboardSnapshot {
  installations: readonly InstallationView[];
  pluginVersions: readonly PluginVersionView[];
  approvals: readonly ApprovalView[];
  executions: readonly ExecutionView[];
  usage: DailyUsageSummaryView;
  cursors: Partial<Record<AdminDashboardSection, string>>;
}

export interface AdminApiClient extends AdminSessionClient {
  getDashboard: (session: AdminSession) => Promise<DashboardSnapshot>;
  getDashboardSection: (
    section: AdminDashboardSection,
    cursor: string
  ) => Promise<DashboardSectionPage>;
  searchExecutions: (request: ExecutionSearchRequest) => Promise<ExecutionSearchPage>;
  getExecutionDetail: (id: string) => Promise<ExecutionDetailView>;
  getInstallationPermissionReview: (id: string) => Promise<InstallationPermissionReview>;
  updateInstallationCommand: (
    request: InstallationCommandRequest
  ) => Promise<InstallationCommandResult>;
  getInstallPreview: (versionId: string) => Promise<InstallPreview>;
  installPlugin: (request: InstallPluginRequest) => Promise<InstallPluginResult>;
  rollbackInstallation: (
    request: RollbackInstallationRequest
  ) => Promise<RollbackInstallationResult>;
  clearSession: () => void;
}

interface InstallationCommandBase {
  id: string;
  expectedRevision: number;
}

export type InstallationCommandRequest =
  | (InstallationCommandBase & { enabled: boolean; priority?: never })
  | (InstallationCommandBase & { enabled?: never; priority: number })
  | (InstallationCommandBase & { enabled: boolean; priority: number });

export interface InstallationCommandResult {
  id: string;
  enabled: boolean;
  priority: number;
  revision: number;
}

export interface InstallationPermissionReview {
  id: string;
  pluginKey: string;
  version: string;
  enabled: boolean;
  priority: number;
  revision: number;
  configFields: readonly {
    name: string;
    type: "string" | "number" | "boolean";
    required: boolean;
    configured: boolean;
    hasDefault: boolean;
  }[];
  capabilities: readonly {
    name: string;
    status: "granted" | "missing";
    scopeKeys: readonly string[];
    configReferences: readonly string[];
  }[];
  egress: { mode: "deny" | "allowlist"; allowlistedHostCount: number };
}

export type DashboardSectionPage =
  | { section: "installations"; items: readonly InstallationView[]; nextCursor?: string }
  | { section: "pluginVersions"; items: readonly PluginVersionView[]; nextCursor?: string }
  | { section: "approvals"; items: readonly ApprovalView[]; nextCursor?: string }
  | { section: "executions"; items: readonly ExecutionView[]; nextCursor?: string };

export class AdminApiError extends Error {
  override readonly name = "AdminApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const roleSchema = z.enum(["manager", "viewer"]);

const sessionSchema = z.object({
  subject: z.string().min(1),
  role: roleSchema,
  appId: z.string().min(1),
  tenantId: z.string().min(1)
});

const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1)
  })
});

const installationSchema = z
  .object({
    id: z.string(),
    pluginKey: z.string(),
    version: z.string(),
    enabled: z.boolean(),
    priority: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  })
  .strict();

const pluginVersionSchema = z
  .object({
    id: z.string(),
    pluginId: z.string(),
    pluginKey: z.string(),
    version: z.string(),
    artifactHash: z.string(),
    createdAt: z.coerce.date()
  })
  .strict();

const approvalSchema = z
  .object({
    id: z.string(),
    pluginId: z.string(),
    role: z.string(),
    resumeHook: z.string(),
    state: z.enum(["pending", "approved", "rejected", "expired"]),
    expiresAt: z.coerce.date(),
    createdAt: z.coerce.date()
  })
  .strict();

const executionSchema = z
  .object({
    id: z.string(),
    pluginId: z.string(),
    hookName: z.string(),
    version: z.string(),
    status: z.enum(["success", "error", "timeout", "egress_denied", "budget_exceeded"]),
    durationMs: z.number(),
    capabilityNames: z.array(z.string()),
    createdAt: z.coerce.date()
  })
  .strict();

const executionDetailSchema = z
  .object({
    id: z.string().min(1),
    pluginId: z.string().min(1),
    hookName: z.string().min(1),
    version: z.string().min(1),
    status: z.enum(["success", "error", "timeout", "egress_denied", "budget_exceeded"]),
    durationMs: z.number().nonnegative(),
    errorCode: z
      .enum(["execution_failed", "execution_timeout", "egress_denied", "budget_exceeded"])
      .optional(),
    capabilityCalls: z.array(
      z.object({ name: z.string().min(1), status: z.enum(["success", "denied", "error"]) }).strict()
    ),
    createdAt: z.coerce.date()
  })
  .strict();

const usageSummarySchema = z
  .object({
    date: z.string(),
    executions: z.number(),
    runtimeMs: z.number()
  })
  .strict();

const collectionSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().optional() }).strict();

const dashboardSchema = z
  .object({
    installations: collectionSchema(installationSchema),
    pluginVersions: collectionSchema(pluginVersionSchema),
    approvals: collectionSchema(approvalSchema),
    executions: collectionSchema(executionSchema),
    usage: usageSummarySchema
  })
  .strict();

const dashboardSectionSchema = z.discriminatedUnion("section", [
  z
    .object({ section: z.literal("installations"), ...collectionSchema(installationSchema).shape })
    .strict(),
  z
    .object({
      section: z.literal("pluginVersions"),
      ...collectionSchema(pluginVersionSchema).shape
    })
    .strict(),
  z.object({ section: z.literal("approvals"), ...collectionSchema(approvalSchema).shape }).strict(),
  z
    .object({ section: z.literal("executions"), ...collectionSchema(executionSchema).shape })
    .strict()
]);

const installationPermissionReviewSchema = z
  .object({
    id: z.string(),
    pluginKey: z.string(),
    version: z.string(),
    enabled: z.boolean(),
    priority: z.number(),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    configFields: z.array(
      z
        .object({
          name: z.string(),
          type: z.enum(["string", "number", "boolean"]),
          required: z.boolean(),
          configured: z.boolean(),
          hasDefault: z.boolean()
        })
        .strict()
    ),
    capabilities: z.array(
      z
        .object({
          name: z.string(),
          status: z.enum(["granted", "missing"]),
          scopeKeys: z.array(z.string()),
          configReferences: z.array(z.string())
        })
        .strict()
    ),
    egress: z
      .object({
        mode: z.enum(["deny", "allowlist"]),
        allowlistedHostCount: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();

const installationCommandResultSchema = z
  .object({
    id: z.string().min(1),
    enabled: z.boolean(),
    priority: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  })
  .strict();

const installPreviewSchema = z
  .object({
    versionId: z.string().min(1),
    pluginKey: z.string().min(1),
    version: z.string().min(1),
    configFields: z.array(
      z
        .object({
          name: z.string().min(1),
          type: z.enum(["string", "number", "boolean"]),
          required: z.boolean(),
          hasDefault: z.boolean()
        })
        .strict()
    ),
    capabilities: z.array(
      z
        .object({
          name: z.string().min(1),
          scopeKeys: z.array(z.string()),
          configReferences: z.array(z.string())
        })
        .strict()
    ),
    egress: z
      .object({
        mode: z.enum(["deny", "allowlist"]),
        allowlistedHostCount: z.number().int().min(0)
      })
      .strict()
  })
  .strict();

const installPluginResultSchema = z
  .object({
    id: z.string().min(1),
    versionId: z.string().min(1),
    pluginKey: z.string().min(1),
    version: z.string().min(1),
    enabled: z.boolean(),
    priority: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  })
  .strict();

const rollbackInstallationResultSchema = z
  .object({
    installationId: z.string().min(1),
    pluginKey: z.string().min(1),
    fromVersion: z.string().min(1),
    toVersion: z.string().min(1),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    auditId: z.string().min(1),
    completedAt: z.iso.datetime()
  })
  .strict();

const demoSessionList: readonly { token: string; session: AdminSession }[] = [
  {
    token: "manager-token",
    session: {
      subject: "ops-manager",
      role: "manager",
      appId: "app_acme",
      tenantId: "tenant_acme"
    }
  },
  {
    token: "viewer-token",
    session: {
      subject: "support-viewer",
      role: "viewer",
      appId: "app_acme",
      tenantId: "tenant_acme"
    }
  }
];

const demoSessions = new Map<string, AdminSession>(
  demoSessionList.map(({ token, session }) => [token, session])
);

const dashboardFixture: DashboardSnapshot = {
  installations: [
    {
      id: "inst_large_invoice",
      enabled: true,
      priority: 10,
      revision: 0,
      pluginKey: "large-invoice-notify",
      version: "1.3.0",
      statusText: "enabled"
    },
    {
      id: "inst_payload_transformer",
      enabled: true,
      priority: 20,
      revision: 0,
      pluginKey: "payload-transformer",
      version: "0.9.1",
      statusText: "enabled"
    }
  ],
  pluginVersions: [
    {
      id: "version_large_invoice_1_3_0",
      pluginId: "plugin_large_invoice",
      pluginKey: "large-invoice-notify",
      version: "1.3.0",
      artifactHash: "sha256:large-invoice-130",
      createdAt: new Date("2026-07-19T16:00:00.000Z")
    },
    {
      id: "version_large_invoice_1_2_2",
      pluginId: "plugin_large_invoice",
      pluginKey: "large-invoice-notify",
      version: "1.2.2",
      artifactHash: "sha256:large-invoice-122",
      createdAt: new Date("2026-07-18T16:00:00.000Z")
    }
  ],
  approvals: [
    {
      id: "approval_1",
      pluginId: "plugin_large_invoice",
      role: "manager",
      resumeHook: "invoice.approval.decided",
      state: "pending",
      expiresAt: new Date("2026-06-17T00:00:00.000Z"),
      createdAt: new Date("2026-06-16T00:00:00.000Z")
    }
  ],
  executions: [
    {
      id: "exec_1",
      pluginId: "plugin_large_invoice",
      hookName: "invoice.created",
      version: "1.3.0",
      status: "success",
      durationMs: 18,
      capabilityNames: ["slack.send"],
      createdAt: new Date("2026-06-16T00:05:00.000Z")
    },
    {
      id: "exec_2",
      pluginId: "plugin_payload_transformer",
      hookName: "webhook.outbound",
      version: "0.9.1",
      status: "success",
      durationMs: 11,
      capabilityNames: [],
      createdAt: new Date("2026-06-16T00:06:00.000Z")
    }
  ],
  usage: { date: "2026-06-16", executions: 34, runtimeMs: 742 },
  cursors: {}
};

function executionErrorCode(status: ExecutionView["status"]): ExecutionDetailView["errorCode"] {
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

export function createDemoAdminApiClient(): AdminApiClient {
  let snapshot: DashboardSnapshot = {
    ...dashboardFixture,
    installations: [...dashboardFixture.installations]
  };
  return {
    resolveSession: ({ token }) => {
      const session = demoSessions.get(token.trim());
      if (session === undefined) {
        return Promise.reject(new Error("invalid_token"));
      }
      return Promise.resolve(session);
    },
    getDashboard: () => Promise.resolve(snapshot),
    getDashboardSection: () =>
      Promise.reject(new AdminApiError(404, "no_more_results", "No more demo results")),
    searchExecutions: (request) => {
      const items = snapshot.executions.filter(
        (execution) =>
          (request.pluginId === undefined || execution.pluginId === request.pluginId) &&
          (request.hookName === undefined || execution.hookName === request.hookName) &&
          (request.status === undefined || execution.status === request.status)
      );
      return Promise.resolve({ items });
    },
    getExecutionDetail: (id) => {
      const execution = snapshot.executions.find((candidate) => candidate.id === id);
      if (execution === undefined) {
        return Promise.reject(new AdminApiError(404, "execution_not_found", "execution not found"));
      }
      const errorCode = executionErrorCode(execution.status);
      return Promise.resolve({
        id: execution.id,
        pluginId: execution.pluginId,
        hookName: execution.hookName,
        version: execution.version,
        status: execution.status,
        durationMs: execution.durationMs,
        ...(errorCode === undefined ? {} : { errorCode }),
        capabilityCalls: execution.capabilityNames.map((name) => ({
          name,
          status: execution.status === "success" ? "success" : "error"
        })),
        createdAt: execution.createdAt
      });
    },
    getInstallationPermissionReview: (id) => {
      const installation = snapshot.installations.find((candidate) => candidate.id === id);
      if (installation === undefined)
        return Promise.reject(
          new AdminApiError(404, "installation_not_found", "installation not found")
        );
      return Promise.resolve({
        ...installation,
        revision: installation.revision,
        configFields: [],
        capabilities: [],
        egress: { mode: "deny", allowlistedHostCount: 0 }
      });
    },
    getInstallPreview: (versionId) => {
      const version = snapshot.pluginVersions.find((candidate) => candidate.id === versionId);
      if (version === undefined) {
        return Promise.reject(
          new AdminApiError(404, "plugin_version_not_found", "plugin version not found")
        );
      }
      return Promise.resolve({
        versionId: version.id,
        pluginKey: version.pluginKey,
        version: version.version,
        configFields: [
          { name: "notifyChannel", type: "string", required: true, hasDefault: false }
        ],
        capabilities: [
          {
            name: "slack.send",
            scopeKeys: ["channel"],
            configReferences: ["notifyChannel"]
          }
        ],
        egress: { mode: "deny", allowlistedHostCount: 0 }
      });
    },
    installPlugin: (request) => {
      const version = snapshot.pluginVersions.find(
        (candidate) => candidate.id === request.versionId
      );
      if (version === undefined) {
        return Promise.reject(
          new AdminApiError(404, "plugin_version_not_found", "plugin version not found")
        );
      }
      if (
        typeof request.config.notifyChannel !== "string" ||
        !request.confirmedCapabilities.includes("slack.send")
      ) {
        return Promise.reject(
          new AdminApiError(400, "invalid_config", "installation config validation failed")
        );
      }
      const result = {
        id: `installation_demo_${String(snapshot.installations.length + 1)}`,
        versionId: request.versionId,
        pluginKey: version.pluginKey,
        version: version.version,
        enabled: request.enabled,
        priority: request.priority,
        revision: 0
      };
      snapshot = {
        ...snapshot,
        installations: [
          ...snapshot.installations,
          { ...result, statusText: result.enabled ? "enabled" : "disabled" }
        ]
      };
      return Promise.resolve(result);
    },
    updateInstallationCommand: (request) => {
      const installation = snapshot.installations.find((candidate) => candidate.id === request.id);
      if (installation === undefined) {
        return Promise.reject(
          new AdminApiError(404, "installation_not_found", "installation not found")
        );
      }
      if (request.expectedRevision !== installation.revision) {
        return Promise.reject(
          new AdminApiError(409, "installation_revision_conflict", "installation changed; refresh")
        );
      }
      const enabled = request.enabled ?? installation.enabled;
      const priority = request.priority ?? installation.priority;
      const changed = enabled !== installation.enabled || priority !== installation.priority;
      const updated = {
        id: installation.id,
        enabled,
        priority,
        revision: changed ? installation.revision + 1 : installation.revision
      };
      snapshot = {
        ...snapshot,
        installations: snapshot.installations.map((candidate) =>
          candidate.id === updated.id
            ? { ...candidate, ...updated, statusText: updated.enabled ? "enabled" : "disabled" }
            : candidate
        )
      };
      return Promise.resolve(updated);
    },
    rollbackInstallation: (request) => {
      const installation = snapshot.installations.find(
        (candidate) => candidate.id === request.installationId
      );
      const target = snapshot.pluginVersions.find(
        (candidate) => candidate.id === request.targetVersionId
      );
      if (
        installation === undefined ||
        target === undefined ||
        target.pluginKey !== installation.pluginKey
      ) {
        return Promise.reject(
          new AdminApiError(404, "rollback_target_not_found", "rollback target not found")
        );
      }
      if (request.expectedRevision !== installation.revision) {
        return Promise.reject(
          new AdminApiError(409, "installation_revision_conflict", "installation changed; refresh")
        );
      }
      if (target.version === installation.version) {
        return Promise.reject(
          new AdminApiError(409, "rollback_target_is_current", "target version is already current")
        );
      }
      const completedAt = new Date();
      const result: RollbackInstallationResult = {
        installationId: installation.id,
        pluginKey: installation.pluginKey,
        fromVersion: installation.version,
        toVersion: target.version,
        revision: installation.revision + 1,
        auditId: `audit_demo_${installation.id}_${String(installation.revision + 1)}`,
        completedAt
      };
      snapshot = {
        ...snapshot,
        installations: snapshot.installations.map((candidate) =>
          candidate.id === installation.id
            ? { ...candidate, version: target.version, revision: result.revision }
            : candidate
        )
      };
      return Promise.resolve(result);
    },
    clearSession: () => undefined
  };
}

export function createUnavailableAdminApiClient(): AdminApiClient {
  const unavailable = () =>
    Promise.reject(
      new AdminApiError(503, "control_plane_not_configured", "Control Plane not configured")
    );
  return {
    resolveSession: unavailable,
    getDashboard: unavailable,
    getDashboardSection: unavailable,
    searchExecutions: unavailable,
    getExecutionDetail: unavailable,
    getInstallationPermissionReview: unavailable,
    updateInstallationCommand: unavailable,
    getInstallPreview: unavailable,
    installPlugin: unavailable,
    rollbackInstallation: unavailable,
    clearSession: () => undefined
  };
}

export function createAdminApiClient(params: {
  isDevelopment: boolean;
  demoMode: boolean;
  controlPlaneUrl?: string | undefined;
  fetcher?: typeof fetch | undefined;
}): AdminApiClient {
  // Fixture credentials must stay a local-development capability even if a deployment
  // accidentally carries the demo flag into its build environment.
  if (params.isDevelopment && params.demoMode) {
    return createDemoAdminApiClient();
  }
  if (params.controlPlaneUrl === undefined || params.controlPlaneUrl.trim() === "") {
    return createUnavailableAdminApiClient();
  }

  const sessionClient = createHttpAdminSessionClient({
    baseUrl: params.controlPlaneUrl,
    allowInsecureLoopback: params.isDevelopment,
    ...(params.fetcher === undefined ? {} : { fetcher: params.fetcher })
  });
  const dashboardUrl = apiEndpoint(
    params.controlPlaneUrl,
    "/v1/admin/dashboard",
    params.isDevelopment
  );
  const installationCommandUrl = apiEndpoint(
    params.controlPlaneUrl,
    "/v1/admin/installation-command",
    params.isDevelopment
  );
  const installPreviewUrl = apiEndpoint(
    params.controlPlaneUrl,
    "/v1/admin/install-preview",
    params.isDevelopment
  );
  const installationsUrl = apiEndpoint(
    params.controlPlaneUrl,
    "/v1/admin/installations",
    params.isDevelopment
  );
  const rollbacksUrl = apiEndpoint(
    params.controlPlaneUrl,
    "/v1/admin/rollbacks",
    params.isDevelopment
  );
  const executionDetailUrl = apiEndpoint(
    params.controlPlaneUrl,
    "/v1/admin/execution-detail",
    params.isDevelopment
  );
  const fetcher = params.fetcher ?? fetch;
  let credential: string | undefined;

  return {
    resolveSession: async (request) => {
      const session = await sessionClient.resolveSession(request);
      credential = request.token.trim();
      return session;
    },
    getDashboard: async () => {
      const payload = await fetchAdminJson(dashboardUrl, requireCredential(credential), fetcher);
      const dashboard = dashboardSchema.safeParse(payload);
      if (!dashboard.success) {
        throw invalidResponse();
      }
      return dashboardSnapshot(dashboard.data);
    },
    getDashboardSection: async (section, cursor) => {
      const url = new URL(`${dashboardUrl}/${section}`);
      url.searchParams.set("cursor", cursor);
      const payload = await fetchAdminJson(url.toString(), requireCredential(credential), fetcher);
      const page = dashboardSectionSchema.safeParse(payload);
      if (!page.success || page.data.section !== section) {
        throw invalidResponse();
      }
      return dashboardSectionPage(page.data);
    },
    searchExecutions: async (request) => {
      const url = new URL(`${dashboardUrl}/executions`);
      for (const [key, value] of Object.entries(request)) {
        if (value !== undefined && value !== "") url.searchParams.set(key, value);
      }
      const payload = await fetchAdminJson(url.toString(), requireCredential(credential), fetcher);
      const page = dashboardSectionSchema.safeParse(payload);
      if (!page.success || page.data.section !== "executions") throw invalidResponse();
      return {
        items: page.data.items,
        ...(page.data.nextCursor === undefined ? {} : { nextCursor: page.data.nextCursor })
      };
    },
    getExecutionDetail: async (id) => {
      const url = new URL(executionDetailUrl);
      url.searchParams.set("id", id);
      const payload = await fetchAdminJson(url.toString(), requireCredential(credential), fetcher);
      const detail = executionDetailSchema.safeParse(payload);
      if (!detail.success || detail.data.id !== id) throw invalidResponse();
      const { errorCode, ...safeDetail } = detail.data;
      return errorCode === undefined ? safeDetail : { ...safeDetail, errorCode };
    },
    getInstallationPermissionReview: async (id) => {
      const url = new URL("/v1/admin/installation-review", dashboardUrl);
      url.searchParams.set("id", id);
      const payload = await fetchAdminJson(url.toString(), requireCredential(credential), fetcher);
      const detail = installationPermissionReviewSchema.safeParse(payload);
      if (!detail.success) throw invalidResponse();
      return detail.data;
    },
    updateInstallationCommand: async (request) => {
      const payload = await fetchAdminJson(
        installationCommandUrl,
        requireCredential(credential),
        fetcher,
        { method: "PATCH", body: JSON.stringify(request) }
      );
      const result = installationCommandResultSchema.safeParse(payload);
      if (!result.success || result.data.id !== request.id) throw invalidResponse();
      return result.data;
    },
    getInstallPreview: async (versionId) => {
      const url = new URL(installPreviewUrl);
      url.searchParams.set("versionId", versionId);
      const payload = await fetchAdminJson(url.toString(), requireCredential(credential), fetcher);
      const preview = installPreviewSchema.safeParse(payload);
      if (!preview.success || preview.data.versionId !== versionId) throw invalidResponse();
      return preview.data;
    },
    installPlugin: async (request) => {
      const payload = await fetchAdminJson(
        installationsUrl,
        requireCredential(credential),
        fetcher,
        { method: "POST", body: JSON.stringify(request) }
      );
      const installed = installPluginResultSchema.safeParse(payload);
      if (!installed.success || installed.data.versionId !== request.versionId) {
        throw invalidResponse();
      }
      return installed.data;
    },
    rollbackInstallation: async (request) => {
      const payload = await fetchAdminJson(rollbacksUrl, requireCredential(credential), fetcher, {
        method: "POST",
        body: JSON.stringify(request)
      });
      const rollback = rollbackInstallationResultSchema.safeParse(payload);
      if (!rollback.success || rollback.data.installationId !== request.installationId) {
        throw invalidResponse();
      }
      return { ...rollback.data, completedAt: new Date(rollback.data.completedAt) };
    },
    clearSession: () => {
      credential = undefined;
    }
  };
}

export function createHttpAdminSessionClient(params: {
  baseUrl: string;
  allowInsecureLoopback?: boolean;
  fetcher?: typeof fetch;
}): AdminSessionClient {
  const sessionUrl = sessionEndpoint(params.baseUrl, params.allowInsecureLoopback ?? false);
  const fetcher = params.fetcher ?? fetch;

  return {
    resolveSession: async ({ token }) => {
      const credential = token.trim();
      if (credential.length === 0) {
        throw new AdminApiError(401, "unauthorized", "valid bearer token required");
      }

      let response: Response;
      try {
        response = await fetcher(sessionUrl, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${credential}`
          },
          cache: "no-store",
          credentials: "omit"
        });
      } catch {
        // Browser/network errors can include implementation details. Keep the UI contract
        // stable and avoid surfacing provider diagnostics or request metadata to users.
        throw new AdminApiError(0, "network_error", "control-plane is unreachable");
      }
      const payload = await readJson(response);

      if (!response.ok) {
        const envelope = errorEnvelopeSchema.safeParse(payload);
        if (envelope.success) {
          throw new AdminApiError(
            response.status,
            envelope.data.error.code,
            envelope.data.error.message
          );
        }
        throw new AdminApiError(response.status, "http_error", "control-plane request failed");
      }

      const identity = sessionSchema.safeParse(payload);
      if (!identity.success) {
        throw new AdminApiError(
          502,
          "invalid_response",
          "control-plane returned an invalid response"
        );
      }

      // Credential ownership stops at the transport boundary. UI components receive identity
      // only, reducing the chance that later screens accidentally render or log the token.
      return identity.data;
    }
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function sessionEndpoint(baseUrl: string, allowInsecureLoopback: boolean): string {
  return apiEndpoint(baseUrl, "/v1/session", allowInsecureLoopback);
}

function apiEndpoint(baseUrl: string, path: string, allowInsecureLoopback: boolean): string {
  const base = new URL(baseUrl);
  if (
    base.protocol !== "https:" &&
    !(allowInsecureLoopback && base.protocol === "http:" && isLoopbackHost(base.hostname))
  ) {
    throw new Error("control-plane URL must use https except for loopback development");
  }
  if (base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "") {
    throw new Error("control-plane URL must not contain credentials, query, or fragment");
  }
  return new URL(path, base).toString();
}

async function fetchAdminJson(
  url: string,
  credential: string,
  fetcher: typeof fetch,
  init: { method: "GET" | "PATCH" | "POST"; body?: string } = { method: "GET" }
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: init.method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credential}`,
        ...(init.method === "PATCH" ? { "Content-Type": "application/json" } : {})
      },
      cache: "no-store",
      credentials: "omit",
      ...(init.body === undefined ? {} : { body: init.body })
    });
  } catch {
    throw new AdminApiError(0, "network_error", "control-plane is unreachable");
  }

  const payload = await readJson(response);
  if (!response.ok) {
    const envelope = errorEnvelopeSchema.safeParse(payload);
    if (envelope.success) {
      throw new AdminApiError(
        response.status,
        envelope.data.error.code,
        envelope.data.error.message
      );
    }
    throw new AdminApiError(response.status, "http_error", "control-plane request failed");
  }
  return payload;
}

function requireCredential(credential: string | undefined): string {
  if (credential === undefined) {
    throw new AdminApiError(401, "session_required", "Admin session required");
  }
  return credential;
}

function invalidResponse(): AdminApiError {
  return new AdminApiError(502, "invalid_response", "control-plane returned an invalid response");
}

function dashboardSnapshot(data: z.infer<typeof dashboardSchema>): DashboardSnapshot {
  return {
    installations: data.installations.items.map(installationView),
    pluginVersions: data.pluginVersions.items,
    approvals: data.approvals.items,
    executions: data.executions.items,
    usage: data.usage,
    cursors: {
      ...(data.installations.nextCursor === undefined
        ? {}
        : { installations: data.installations.nextCursor }),
      ...(data.pluginVersions.nextCursor === undefined
        ? {}
        : { pluginVersions: data.pluginVersions.nextCursor }),
      ...(data.approvals.nextCursor === undefined ? {} : { approvals: data.approvals.nextCursor }),
      ...(data.executions.nextCursor === undefined
        ? {}
        : { executions: data.executions.nextCursor })
    }
  };
}

function dashboardSectionPage(data: z.infer<typeof dashboardSectionSchema>): DashboardSectionPage {
  switch (data.section) {
    case "installations":
      return {
        section: data.section,
        items: data.items.map(installationView),
        ...(data.nextCursor === undefined ? {} : { nextCursor: data.nextCursor })
      };
    case "pluginVersions":
    case "approvals":
    case "executions":
      return {
        section: data.section,
        items: data.items,
        ...(data.nextCursor === undefined ? {} : { nextCursor: data.nextCursor })
      } as DashboardSectionPage;
  }
}

function installationView(installation: z.infer<typeof installationSchema>): InstallationView {
  return {
    ...installation,
    statusText: installation.enabled ? "enabled" : "disabled"
  };
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
