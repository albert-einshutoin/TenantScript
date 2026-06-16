import { z } from "zod";
import type {
  ApprovalRecord,
  AuthenticatedIdentity,
  ControlPlaneExecutionRecord,
  InstallationRecord,
  PluginVersionRecord
} from "@tenantscript/control-plane";

export type AdminRole = "manager" | "viewer";

export interface AdminSession extends AuthenticatedIdentity {
  token: string;
  role: AdminRole;
}

export interface InstallationView extends InstallationRecord {
  pluginKey: string;
  version: string;
  statusText: "enabled" | "disabled";
}

export type PluginVersionView = Pick<
  PluginVersionRecord,
  "id" | "pluginId" | "version" | "artifactHash"
> & {
  manifest: unknown;
};

export interface DailyUsageSummaryView {
  tenantId: string;
  pluginId: string;
  date: string;
  executions: number;
  cpuMs: number;
  subrequests: number;
  workflowRuns: number;
}

export type ApprovalView = Omit<ApprovalRecord, "decidedBy" | "decisionReason" | "decidedAt"> & {
  decidedBy?: string | undefined;
  decisionReason?: string | undefined;
  decidedAt?: Date | undefined;
};

export type ExecutionView = Omit<ControlPlaneExecutionRecord, "error"> & {
  error?: string | undefined;
};

export interface DashboardSnapshot {
  installations: readonly InstallationView[];
  pluginVersions: readonly PluginVersionView[];
  approvals: readonly ApprovalView[];
  executions: readonly ExecutionView[];
  usage: readonly DailyUsageSummaryView[];
}

export interface AdminApiClient {
  resolveSession: (request: { token: string }) => Promise<AdminSession>;
  getDashboard: (session: AdminSession) => Promise<DashboardSnapshot>;
}

const roleSchema = z.enum(["manager", "viewer"]);

const sessionSchema = z.object({
  token: z.string().min(1),
  subject: z.string().min(1),
  role: roleSchema
});

const installationSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  pluginVersionId: z.string(),
  enabled: z.boolean(),
  priority: z.number(),
  config: z.record(z.string(), z.unknown()),
  grants: z.record(z.string(), z.unknown()),
  pluginKey: z.string(),
  version: z.string(),
  statusText: z.enum(["enabled", "disabled"])
});

const pluginVersionSchema = z.object({
  id: z.string(),
  pluginId: z.string(),
  version: z.string(),
  artifactHash: z.string(),
  manifest: z.unknown()
});

const approvalSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  pluginId: z.string(),
  role: z.string(),
  subject: z.record(z.string(), z.unknown()),
  resumeHook: z.string(),
  state: z.enum(["pending", "approved", "rejected", "expired"]),
  expiresAt: z.coerce.date(),
  createdAt: z.coerce.date(),
  decidedBy: z.string().optional(),
  decisionReason: z.string().optional(),
  decidedAt: z.coerce.date().optional()
});

const executionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  pluginId: z.string(),
  hookName: z.string(),
  version: z.string(),
  status: z.enum(["success", "error", "timeout", "egress_denied", "budget_exceeded"]),
  durationMs: z.number(),
  error: z.string().optional(),
  capabilityCalls: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["success", "denied", "error"])
    })
  ),
  createdAt: z.coerce.date()
});

const usageSummarySchema = z.object({
  tenantId: z.string(),
  pluginId: z.string(),
  date: z.string(),
  executions: z.number(),
  cpuMs: z.number(),
  subrequests: z.number(),
  workflowRuns: z.number()
});

const dashboardSchema = z.object({
  installations: z.array(installationSchema),
  pluginVersions: z.array(pluginVersionSchema),
  approvals: z.array(approvalSchema),
  executions: z.array(executionSchema),
  usage: z.array(usageSummarySchema)
});

const demoSessionList: readonly AdminSession[] = [
  { token: "manager-token", subject: "ops-manager", role: "manager" },
  { token: "viewer-token", subject: "support-viewer", role: "viewer" }
];

const demoSessions = new Map<string, AdminSession>(
  demoSessionList.map((session) => [session.token, session])
);

const dashboardFixture: DashboardSnapshot = dashboardSchema.parse({
  installations: [
    {
      id: "inst_large_invoice",
      tenantId: "tenant_acme",
      pluginVersionId: "version_large_invoice_1_3_0",
      enabled: true,
      priority: 10,
      config: { notifyChannel: "C123" },
      grants: { "slack.send": { channel: "C123" } },
      pluginKey: "large-invoice-notify",
      version: "1.3.0",
      statusText: "enabled"
    },
    {
      id: "inst_payload_transformer",
      tenantId: "tenant_acme",
      pluginVersionId: "version_payload_transformer_0_9_1",
      enabled: true,
      priority: 20,
      config: {},
      grants: {},
      pluginKey: "payload-transformer",
      version: "0.9.1",
      statusText: "enabled"
    }
  ],
  pluginVersions: [
    {
      id: "version_large_invoice_1_3_0",
      pluginId: "plugin_large_invoice",
      version: "1.3.0",
      artifactHash: "sha256:large-invoice-130",
      manifest: { name: "large-invoice-notify", version: "1.3.0" }
    },
    {
      id: "version_large_invoice_1_2_2",
      pluginId: "plugin_large_invoice",
      version: "1.2.2",
      artifactHash: "sha256:large-invoice-122",
      manifest: { name: "large-invoice-notify", version: "1.2.2" }
    }
  ],
  approvals: [
    {
      id: "approval_1",
      tenantId: "tenant_acme",
      pluginId: "plugin_large_invoice",
      role: "manager",
      subject: { invoiceId: "inv_1001", amountCents: 275000 },
      resumeHook: "invoice.approval.decided",
      state: "pending",
      expiresAt: "2026-06-17T00:00:00.000Z",
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  executions: [
    {
      id: "exec_1",
      tenantId: "tenant_acme",
      pluginId: "plugin_large_invoice",
      hookName: "invoice.created",
      version: "1.3.0",
      status: "success",
      durationMs: 18,
      capabilityCalls: [{ name: "slack.send", status: "success" }],
      createdAt: "2026-06-16T00:05:00.000Z"
    },
    {
      id: "exec_2",
      tenantId: "tenant_acme",
      pluginId: "plugin_payload_transformer",
      hookName: "webhook.outbound",
      version: "0.9.1",
      status: "success",
      durationMs: 11,
      capabilityCalls: [],
      createdAt: "2026-06-16T00:06:00.000Z"
    }
  ],
  usage: [
    {
      tenantId: "tenant_acme",
      pluginId: "plugin_large_invoice",
      date: "2026-06-16",
      executions: 34,
      cpuMs: 742,
      subrequests: 34,
      workflowRuns: 2
    }
  ]
});

export function createDemoAdminApiClient(): AdminApiClient {
  return {
    resolveSession: ({ token }) => {
      const session = demoSessions.get(token.trim());
      if (session === undefined) {
        return Promise.reject(new Error("invalid_token"));
      }
      return Promise.resolve(sessionSchema.parse(session));
    },
    getDashboard: () => Promise.resolve(dashboardFixture)
  };
}
