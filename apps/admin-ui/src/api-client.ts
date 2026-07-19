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
  statusText: "enabled" | "disabled";
}

export interface PluginVersionView {
  id: string;
  pluginId: string;
  version: string;
  artifactHash: string;
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
  clearSession: () => void;
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
    priority: z.number()
  })
  .strict();

const pluginVersionSchema = z
  .object({
    id: z.string(),
    pluginId: z.string(),
    version: z.string(),
    artifactHash: z.string()
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
      pluginKey: "large-invoice-notify",
      version: "1.3.0",
      statusText: "enabled"
    },
    {
      id: "inst_payload_transformer",
      enabled: true,
      priority: 20,
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
      artifactHash: "sha256:large-invoice-130"
    },
    {
      id: "version_large_invoice_1_2_2",
      pluginId: "plugin_large_invoice",
      version: "1.2.2",
      artifactHash: "sha256:large-invoice-122"
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

export function createDemoAdminApiClient(): AdminApiClient {
  return {
    resolveSession: ({ token }) => {
      const session = demoSessions.get(token.trim());
      if (session === undefined) {
        return Promise.reject(new Error("invalid_token"));
      }
      return Promise.resolve(session);
    },
    getDashboard: () => Promise.resolve(dashboardFixture),
    getDashboardSection: () =>
      Promise.reject(new AdminApiError(404, "no_more_results", "No more demo results")),
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
  fetcher: typeof fetch
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credential}`
      },
      cache: "no-store",
      credentials: "omit"
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
