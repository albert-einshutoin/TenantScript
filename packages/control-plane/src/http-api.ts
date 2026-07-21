import type { AuthenticatedIdentity, IdentityResolver } from "./api.js";
import type {
  AdminCursorCodec,
  AdminDashboardSection,
  AdminDashboardSectionPage,
  AdminDashboardStore,
  AdminExecutionFilters
} from "./admin-dashboard.js";
import type { AdminExecutionDetailStore } from "./admin-executions.js";
import type { AdminProviderConnectionStore } from "./admin-provider-connections.js";
import { AdminApprovalDecisionError, type AdminApprovalDecisionStore } from "./admin-approvals.js";
import type {
  AdminInstallationCommandStore,
  AdminInstallationDetailStore
} from "./admin-installations.js";
import { AdminInstallFlowError, type AdminInstallFlowStore } from "./admin-install-flow.js";
import type { AdminInstallRequestStore } from "./admin-install-requests.js";
import { AdminRollbackError, type AdminRollbackStore } from "./admin-rollbacks.js";
import type { AdminMutationFamily, AdminMutationRateLimiter } from "./admin-mutation-rate-limit.js";
import {
  canRolePerform,
  isRbacOperation,
  isSupportedRbacRole,
  normalizeRbacRole,
  type RbacOperation,
  type SupportedRbacRole
} from "./rbac.js";
import { ServiceTokenError, type ServiceTokenManager } from "./service-tokens.js";
import type { SlackOAuthInstallStartService } from "./slack-oauth-install-start.js";
import { UsageMeterQueryError, type UsageMeter } from "./usage-meter.js";
import type { TelemetryStatus } from "./telemetry.js";
import type { ControlPlaneSuccessResponseSchemaId } from "./success-response-schemas.js";

export { CONTROL_PLANE_SUCCESS_RESPONSE_SCHEMAS } from "./success-response-schemas.js";
export type {
  ControlPlaneJsonSchema,
  ControlPlaneSuccessResponseSchemaId
} from "./success-response-schemas.js";

export type AdminRole = SupportedRbacRole;

export interface TenantScopedAdminIdentity extends AuthenticatedIdentity {
  role: AdminRole;
  appId: string;
  tenantId: string;
}

export interface ControlPlaneHttpHandlerOptions {
  identityResolver?: IdentityResolver;
  dashboardStore?: AdminDashboardStore;
  providerConnectionStore?: AdminProviderConnectionStore;
  cursorCodec?: AdminCursorCodec;
  installationDetailStore?: AdminInstallationDetailStore;
  installationCommandStore?: AdminInstallationCommandStore;
  installFlowStore?: AdminInstallFlowStore;
  installRequestStore?: AdminInstallRequestStore;
  rollbackStore?: AdminRollbackStore;
  executionDetailStore?: AdminExecutionDetailStore;
  approvalDecisionStore?: AdminApprovalDecisionStore;
  serviceTokenManager?: ServiceTokenManager;
  slackOAuthInstallStartService?: SlackOAuthInstallStartService;
  adminMutationRateLimiter?: AdminMutationRateLimiter;
  usageMeter?: UsageMeter;
  telemetryStatus?: TelemetryStatus;
  allowedOrigins?: readonly string[];
  now?: () => Date;
}

export type ControlPlaneHttpHandler = (request: Request) => Promise<Response>;

interface HttpErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export function createControlPlaneHttpHandler(
  options: ControlPlaneHttpHandlerOptions
): ControlPlaneHttpHandler {
  const allowedOrigins = createAllowedOriginSet(options.allowedOrigins ?? []);

  return async (request) => {
    const origin = request.headers.get("Origin");
    if (origin !== null && !allowedOrigins.has(origin)) {
      return errorResponse(403, "origin_forbidden", "request origin is not allowed");
    }

    const corsHeaders = origin === null ? undefined : corsResponseHeaders(origin);
    const url = new URL(request.url);
    const endpoint = matchAdminHttpEndpoint(url);
    if (endpoint === null) {
      return errorResponse(404, "route_not_found", "route not found", corsHeaders);
    }
    const route = endpoint.route;

    if (request.method === "OPTIONS") {
      if (origin === null) {
        return errorResponse(403, "origin_required", "request origin is required");
      }
      return preflightResponse(corsHeaders, allowedMethods(endpoint.contract));
    }
    if (!endpoint.contract.methods.some((method) => method === request.method)) {
      const allow = allowedMethods(endpoint.contract);
      return errorResponse(405, "method_not_allowed", "method not allowed", {
        ...corsHeaders,
        Allow: allow
      });
    }
    if (route === "installationCommand") {
      if (request.method !== "PATCH") {
        return errorResponse(405, "method_not_allowed", "method not allowed", {
          ...corsHeaders,
          Allow: "PATCH, OPTIONS"
        });
      }
      return runInstallationCommand(request, options, corsHeaders);
    }
    if (route === "installCreate") {
      if (request.method !== "POST") {
        return errorResponse(405, "method_not_allowed", "method not allowed", {
          ...corsHeaders,
          Allow: "POST, OPTIONS"
        });
      }
      return runInstall(request, options, corsHeaders);
    }
    if (route === "installRequestCreate") {
      if (request.method !== "POST") {
        return errorResponse(405, "method_not_allowed", "method not allowed", {
          ...corsHeaders,
          Allow: "POST, OPTIONS"
        });
      }
      return runInstallRequest(request, options, corsHeaders);
    }
    if (route === "rollbackCreate") {
      if (request.method !== "POST") {
        return errorResponse(405, "method_not_allowed", "method not allowed", {
          ...corsHeaders,
          Allow: "POST, OPTIONS"
        });
      }
      return runRollback(request, options, corsHeaders);
    }
    if (route === "approvalDecisionCreate") {
      if (request.method !== "POST") {
        return errorResponse(405, "method_not_allowed", "method not allowed", {
          ...corsHeaders,
          Allow: "POST, OPTIONS"
        });
      }
      return runApprovalDecision(request, options, corsHeaders);
    }
    if (route === "serviceTokenCollection") {
      if (request.method === "POST") {
        return runServiceTokenIssue(request, options, corsHeaders);
      }
      if (request.method === "DELETE") {
        return runServiceTokenRevoke(request, url, options, corsHeaders);
      }
      return errorResponse(405, "method_not_allowed", "method not allowed", {
        ...corsHeaders,
        Allow: "POST, DELETE, OPTIONS"
      });
    }
    if (route === "slackOAuthInstallStart") {
      if (request.method !== "POST") {
        return errorResponse(405, "method_not_allowed", "method not allowed", {
          ...corsHeaders,
          Allow: "POST, OPTIONS"
        });
      }
      return runSlackOAuthInstallStart(request, url, options, corsHeaders);
    }
    if (request.method !== "GET") {
      return errorResponse(405, "method_not_allowed", "method not allowed", {
        ...corsHeaders,
        Allow: "GET, OPTIONS"
      });
    }

    if (route === "session") {
      return resolveSession(request, options.identityResolver, corsHeaders);
    }
    if (route === "installPreview") {
      return resolveInstallPreview(request, url, options, corsHeaders);
    }
    if (route === "executionDetail") {
      return resolveExecutionDetail(request, url, options, corsHeaders);
    }
    if (route === "usage") {
      return resolveUsage(request, url, options, corsHeaders);
    }
    if (route === "providerConnections") {
      return resolveProviderConnections(request, options, corsHeaders);
    }
    if (typeof route === "object") {
      return resolveInstallationDetail(request, route.id, options, corsHeaders);
    }
    return resolveDashboard(request, route, url, options, corsHeaders);
  };
}

export type AdminRoute =
  | "session"
  | "dashboard"
  | "operations"
  | "providerConnections"
  | "installationCommand"
  | "installPreview"
  | "installCreate"
  | "installRequestCreate"
  | "rollbackCreate"
  | "executionDetail"
  | "usage"
  | "approvalDecisionCreate"
  | "serviceTokenCollection"
  | "slackOAuthInstallStart"
  | AdminDashboardSection
  | { id: string };

export type AdminHttpEndpointId =
  | "session"
  | "dashboard"
  | "dashboardOperations"
  | "dashboardInstallations"
  | "dashboardPluginVersions"
  | "dashboardApprovals"
  | "dashboardExecutions"
  | "dashboardAuditEvents"
  | "providerConnections"
  | "installationReview"
  | "installationCommand"
  | "installPreview"
  | "installCreate"
  | "installRequestCreate"
  | "rollbackCreate"
  | "executionDetail"
  | "usage"
  | "approvalDecisionCreate"
  | "serviceTokenCollection"
  | "slackOAuthInstallStart";

export type AdminHttpIsolation =
  | "identity"
  | "tenant-collection"
  | "tenant-resource"
  | "tenant-mutation";

export type AdminHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type AdminHttpSuccessResponseContract =
  | {
      status: 200 | 201;
      body: "json";
      schema: ControlPlaneSuccessResponseSchemaId;
    }
  | { status: 204; body: "none" };

export interface AdminHttpEndpointContract {
  id: AdminHttpEndpointId;
  path: string;
  methods: readonly AdminHttpMethod[];
  isolation: AdminHttpIsolation;
  route: Exclude<AdminRoute, { id: string }> | "installationReview";
  success: Readonly<Partial<Record<AdminHttpMethod, AdminHttpSuccessResponseContract>>>;
}

export const ADMIN_HTTP_ENDPOINT_CONTRACTS = [
  {
    id: "session",
    path: "/v1/session",
    methods: ["GET"],
    isolation: "identity",
    route: "session",
    success: { GET: { status: 200, body: "json", schema: "session" } }
  },
  {
    id: "dashboard",
    path: "/v1/admin/dashboard",
    methods: ["GET"],
    isolation: "tenant-collection",
    route: "dashboard",
    success: { GET: { status: 200, body: "json", schema: "dashboard" } }
  },
  {
    id: "dashboardOperations",
    path: "/v1/admin/dashboard/operations",
    methods: ["GET"],
    isolation: "tenant-collection",
    route: "operations",
    success: { GET: { status: 200, body: "json", schema: "dashboardOperations" } }
  },
  {
    id: "dashboardInstallations",
    path: "/v1/admin/dashboard/installations",
    methods: ["GET"],
    isolation: "tenant-collection",
    route: "installations",
    success: { GET: { status: 200, body: "json", schema: "dashboardInstallations" } }
  },
  {
    id: "dashboardPluginVersions",
    path: "/v1/admin/dashboard/pluginVersions",
    methods: ["GET"],
    isolation: "tenant-collection",
    route: "pluginVersions",
    success: { GET: { status: 200, body: "json", schema: "dashboardPluginVersions" } }
  },
  {
    id: "dashboardApprovals",
    path: "/v1/admin/dashboard/approvals",
    methods: ["GET"],
    isolation: "tenant-collection",
    route: "approvals",
    success: { GET: { status: 200, body: "json", schema: "dashboardApprovals" } }
  },
  {
    id: "dashboardExecutions",
    path: "/v1/admin/dashboard/executions",
    methods: ["GET"],
    isolation: "tenant-collection",
    route: "executions",
    success: { GET: { status: 200, body: "json", schema: "dashboardExecutions" } }
  },
  {
    id: "dashboardAuditEvents",
    path: "/v1/admin/dashboard/auditEvents",
    methods: ["GET"],
    isolation: "tenant-collection",
    route: "auditEvents",
    success: { GET: { status: 200, body: "json", schema: "dashboardAuditEvents" } }
  },
  {
    id: "providerConnections",
    path: "/v1/admin/provider-connections",
    methods: ["GET"],
    isolation: "tenant-collection",
    route: "providerConnections",
    success: { GET: { status: 200, body: "json", schema: "providerConnections" } }
  },
  {
    id: "slackOAuthInstallStart",
    path: "/v1/admin/provider-connections/slack/oauth/start",
    methods: ["POST"],
    isolation: "tenant-mutation",
    route: "slackOAuthInstallStart",
    success: { POST: { status: 201, body: "json", schema: "slackOAuthInstallStart" } }
  },
  {
    id: "installationReview",
    path: "/v1/admin/installation-review",
    methods: ["GET"],
    isolation: "tenant-resource",
    route: "installationReview",
    success: { GET: { status: 200, body: "json", schema: "installationReview" } }
  },
  {
    id: "installationCommand",
    path: "/v1/admin/installation-command",
    methods: ["PATCH"],
    isolation: "tenant-mutation",
    route: "installationCommand",
    success: { PATCH: { status: 200, body: "json", schema: "installationCommand" } }
  },
  {
    id: "installPreview",
    path: "/v1/admin/install-preview",
    methods: ["GET"],
    isolation: "tenant-resource",
    route: "installPreview",
    success: { GET: { status: 200, body: "json", schema: "installPreview" } }
  },
  {
    id: "installCreate",
    path: "/v1/admin/installations",
    methods: ["POST"],
    isolation: "tenant-mutation",
    route: "installCreate",
    success: { POST: { status: 201, body: "json", schema: "installCreate" } }
  },
  {
    id: "installRequestCreate",
    path: "/v1/admin/installation-requests",
    methods: ["POST"],
    isolation: "tenant-mutation",
    route: "installRequestCreate",
    success: { POST: { status: 201, body: "json", schema: "installRequestCreate" } }
  },
  {
    id: "rollbackCreate",
    path: "/v1/admin/rollbacks",
    methods: ["POST"],
    isolation: "tenant-mutation",
    route: "rollbackCreate",
    success: { POST: { status: 200, body: "json", schema: "rollbackCreate" } }
  },
  {
    id: "executionDetail",
    path: "/v1/admin/execution-detail",
    methods: ["GET"],
    isolation: "tenant-resource",
    route: "executionDetail",
    success: { GET: { status: 200, body: "json", schema: "executionDetail" } }
  },
  {
    id: "usage",
    path: "/v1/admin/usage",
    methods: ["GET"],
    isolation: "tenant-collection",
    route: "usage",
    success: { GET: { status: 200, body: "json", schema: "usage" } }
  },
  {
    id: "approvalDecisionCreate",
    path: "/v1/admin/approval-decisions",
    methods: ["POST"],
    isolation: "tenant-mutation",
    route: "approvalDecisionCreate",
    success: { POST: { status: 200, body: "json", schema: "approvalDecisionCreate" } }
  },
  {
    id: "serviceTokenCollection",
    path: "/v1/admin/service-tokens",
    methods: ["POST", "DELETE"],
    isolation: "tenant-mutation",
    route: "serviceTokenCollection",
    success: {
      POST: { status: 201, body: "json", schema: "serviceTokenIssue" },
      DELETE: { status: 204, body: "none" }
    }
  }
] as const satisfies readonly AdminHttpEndpointContract[];

export interface AdminHttpEndpointMatch {
  contract: (typeof ADMIN_HTTP_ENDPOINT_CONTRACTS)[number];
  route: AdminRoute;
}

export function matchAdminHttpEndpoint(url: URL): AdminHttpEndpointMatch | null {
  const contract = ADMIN_HTTP_ENDPOINT_CONTRACTS.find(({ path }) => path === url.pathname);
  if (contract === undefined) return null;
  if (contract.route === "installationReview") {
    const id = url.searchParams.get("id");
    return id === null || id.length === 0 ? null : { contract, route: { id } };
  }
  return { contract, route: contract.route };
}

const maximumCommandBodyBytes = 16 * 1024;
const maximumInstallBodyBytes = 64 * 1024;

async function runInstallRequest(
  request: Request,
  options: ControlPlaneHttpHandlerOptions,
  corsHeaders: Record<string, string> | undefined
): Promise<Response> {
  if (options.installRequestStore === undefined) {
    return errorResponse(
      503,
      "install_request_store_unavailable",
      "installation request service unavailable",
      corsHeaders
    );
  }
  const identity = await resolveAdminIdentity(request, options.identityResolver, corsHeaders);
  if (identity instanceof Response) return identity;
  const forbidden = requireRbac(
    identity,
    "installation:request",
    "installation_request_forbidden",
    corsHeaders
  );
  if (forbidden !== null) return forbidden;
  const command = await parseInstallRequest(request, corsHeaders);
  if (command instanceof Response) return command;
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (!isIdempotencyKey(idempotencyKey)) {
    return errorResponse(
      400,
      "invalid_idempotency_key",
      "valid Idempotency-Key header required",
      corsHeaders
    );
  }
  const rateLimitResponse = await reserveAdminMutation(
    options.adminMutationRateLimiter,
    identity,
    "installation-request",
    corsHeaders
  );
  if (rateLimitResponse !== null) return rateLimitResponse;
  try {
    const result = await options.installRequestStore.requestInstallation({
      appId: identity.appId,
      tenantId: identity.tenantId,
      actor: identity.subject,
      idempotencyKey,
      ...command
    });
    return result === null
      ? errorResponse(404, "plugin_version_not_found", "plugin version not found", corsHeaders)
      : jsonResponse(201, result, corsHeaders);
  } catch (error) {
    if (error instanceof AdminInstallFlowError) {
      return errorResponse(
        error.code === "idempotency_key_reused" ? 409 : 400,
        error.code,
        error.code === "idempotency_key_reused"
          ? "idempotency key was already used"
          : "installation request validation failed",
        corsHeaders
      );
    }
    return errorResponse(500, "internal_error", "internal control-plane error", corsHeaders);
  }
}

async function runServiceTokenIssue(
  request: Request,
  options: ControlPlaneHttpHandlerOptions,
  corsHeaders: Record<string, string> | undefined
): Promise<Response> {
  if (options.serviceTokenManager === undefined) {
    return errorResponse(
      503,
      "service_token_service_unavailable",
      "service token service unavailable",
      corsHeaders
    );
  }
  const identity = await resolveAdminIdentity(request, options.identityResolver, corsHeaders);
  if (identity instanceof Response) return identity;
  const forbidden = requireRbac(
    identity,
    "service-token:issue",
    "service_token_issue_forbidden",
    corsHeaders
  );
  if (forbidden !== null) return forbidden;
  const input = await parseServiceTokenIssue(request, corsHeaders);
  if (input instanceof Response) return input;
  const rateLimitResponse = await reserveAdminMutation(
    options.adminMutationRateLimiter,
    identity,
    "service-token-issue",
    corsHeaders
  );
  if (rateLimitResponse !== null) return rateLimitResponse;
  try {
    return jsonResponse(
      201,
      await options.serviceTokenManager.issue({
        appId: identity.appId,
        tenantId: identity.tenantId,
        actor: identity.subject,
        actorRole: identity.role,
        ...input
      }),
      corsHeaders
    );
  } catch (error) {
    if (error instanceof ServiceTokenError) {
      return errorResponse(
        error.code === "invalid_service_token" ? 400 : 403,
        error.code,
        error.code === "invalid_service_token"
          ? "invalid service token request"
          : "service token grant not permitted",
        corsHeaders
      );
    }
    return errorResponse(500, "internal_error", "internal control-plane error", corsHeaders);
  }
}

async function runServiceTokenRevoke(
  request: Request,
  url: URL,
  options: ControlPlaneHttpHandlerOptions,
  corsHeaders: Record<string, string> | undefined
): Promise<Response> {
  if (options.serviceTokenManager === undefined) {
    return errorResponse(
      503,
      "service_token_service_unavailable",
      "service token service unavailable",
      corsHeaders
    );
  }
  const identity = await resolveAdminIdentity(request, options.identityResolver, corsHeaders);
  if (identity instanceof Response) return identity;
  const forbidden = requireRbac(
    identity,
    "service-token:revoke",
    "service_token_revoke_forbidden",
    corsHeaders
  );
  if (forbidden !== null) return forbidden;
  const id = url.searchParams.get("id");
  if (
    !isBoundedFilter(id) ||
    url.searchParams.getAll("id").length !== 1 ||
    [...url.searchParams.keys()].some((key) => key !== "id")
  ) {
    return errorResponse(
      400,
      "invalid_service_token",
      "valid service token id required",
      corsHeaders
    );
  }
  const rateLimitResponse = await reserveAdminMutation(
    options.adminMutationRateLimiter,
    identity,
    "service-token-revoke",
    corsHeaders
  );
  if (rateLimitResponse !== null) return rateLimitResponse;
  try {
    const revoked = await options.serviceTokenManager.revoke({
      id,
      appId: identity.appId,
      tenantId: identity.tenantId,
      actor: identity.subject,
      actorRole: identity.role
    });
    if (!revoked) {
      return errorResponse(404, "service_token_not_found", "service token not found", corsHeaders);
    }
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store", ...corsHeaders }
    });
  } catch (error) {
    if (error instanceof ServiceTokenError) {
      return errorResponse(403, error.code, "service token revocation not permitted", corsHeaders);
    }
    return errorResponse(500, "internal_error", "internal control-plane error", corsHeaders);
  }
}

async function parseServiceTokenIssue(
  request: Request,
  corsHeaders: Record<string, string> | undefined
): Promise<
  | {
      label: string;
      role: Exclude<SupportedRbacRole, "manager">;
      scopes: RbacOperation[];
      expiresAt: Date;
    }
  | Response
> {
  const contentType = request.headers.get("Content-Type");
  if (
    contentType === null ||
    contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return errorResponse(
      415,
      "unsupported_media_type",
      "application/json body required",
      corsHeaders
    );
  }
  try {
    const text = await readBoundedUtf8Body(request, maximumCommandBodyBytes);
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error();
    const role = typeof parsed.role === "string" ? normalizeRbacRole(parsed.role) : null;
    const expiresAt = typeof parsed.expiresAt === "string" ? new Date(parsed.expiresAt) : null;
    if (
      Object.keys(parsed).length !== 4 ||
      !Object.keys(parsed).every((key) => ["label", "role", "scopes", "expiresAt"].includes(key)) ||
      typeof parsed.label !== "string" ||
      role === null ||
      role !== parsed.role ||
      !Array.isArray(parsed.scopes) ||
      !parsed.scopes.every(isRbacOperation) ||
      expiresAt === null ||
      !Number.isFinite(expiresAt.getTime())
    ) {
      throw new Error();
    }
    return { label: parsed.label, role, scopes: parsed.scopes, expiresAt };
  } catch (error) {
    return errorResponse(
      error instanceof CommandBodyTooLargeError ? 413 : 400,
      error instanceof CommandBodyTooLargeError ? "request_too_large" : "invalid_service_token",
      error instanceof CommandBodyTooLargeError
        ? "request body too large"
        : "invalid service token request",
      corsHeaders
    );
  }
}

async function resolveUsage(
  request: Request,
  url: URL,
  options: ControlPlaneHttpHandlerOptions,
  corsHeaders: Record<string, string> | undefined
): Promise<Response> {
  if (options.usageMeter === undefined) {
    return errorResponse(503, "usage_meter_unavailable", "usage service unavailable", corsHeaders);
  }
  const identity = await resolveAdminIdentity(request, options.identityResolver, corsHeaders);
  if (identity instanceof Response) return identity;
  const forbidden = requireRbac(identity, "usage:read", "usage_forbidden", corsHeaders);
  if (forbidden !== null) return forbidden;
  const fromDate = url.searchParams.get("fromDate");
  const toDate = url.searchParams.get("toDate");
  if (fromDate === null || toDate === null) {
    return errorResponse(400, "invalid_usage_query", "valid UTC date range required", corsHeaders);
  }
  const pluginId = url.searchParams.get("pluginId");
  try {
    const items = await options.usageMeter.getDailyUsageSummaries({
      tenantId: identity.tenantId,
      fromDate,
      toDate,
      ...(pluginId === null ? {} : { pluginId })
    });
    return jsonResponse(200, { items }, corsHeaders);
  } catch (error) {
    return error instanceof UsageMeterQueryError
      ? errorResponse(400, error.code, "valid UTC date range required", corsHeaders)
      : errorResponse(500, "internal_error", "internal control-plane error", corsHeaders);
  }
}

async function resolveInstallPreview(
  request: Request,
  url: URL,
  options: ControlPlaneHttpHandlerOptions,
  corsHeaders: Record<string, string> | undefined
): Promise<Response> {
  if (options.installFlowStore === undefined) {
    return errorResponse(
      503,
      "install_flow_store_unavailable",
      "installation service unavailable",
      corsHeaders
    );
  }
  const identity = await resolveAdminIdentity(request, options.identityResolver, corsHeaders);
  if (identity instanceof Response) return identity;
  const forbidden = requireRbac(
    identity,
    "installation:read",
    "installation_read_forbidden",
    corsHeaders
  );
  if (forbidden !== null) return forbidden;
  const versionId = url.searchParams.get("versionId");
  if (!isNonEmptyString(versionId)) {
    return errorResponse(400, "invalid_version", "versionId is required", corsHeaders);
  }
  try {
    const preview = await options.installFlowStore.readVersion({
      appId: identity.appId,
      versionId
    });
    return preview === null
      ? errorResponse(404, "plugin_version_not_found", "plugin version not found", corsHeaders)
      : jsonResponse(200, preview, corsHeaders);
  } catch {
    return errorResponse(500, "internal_error", "internal control-plane error", corsHeaders);
  }
}

async function runInstall(
  request: Request,
  options: ControlPlaneHttpHandlerOptions,
  corsHeaders: Record<string, string> | undefined
): Promise<Response> {
  if (options.installFlowStore === undefined) {
    return errorResponse(
      503,
      "install_flow_store_unavailable",
      "installation service unavailable",
      corsHeaders
    );
  }
  const identity = await resolveAdminIdentity(request, options.identityResolver, corsHeaders);
  if (identity instanceof Response) return identity;
  const forbidden = requireRbac(
    identity,
    "installation:manage",
    "installation_install_forbidden",
    corsHeaders
  );
  if (forbidden !== null) return forbidden;
  const command = await parseInstallRequest(request, corsHeaders);
  if (command instanceof Response) return command;
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (!isIdempotencyKey(idempotencyKey)) {
    return errorResponse(
      400,
      "invalid_idempotency_key",
      "valid Idempotency-Key header required",
      corsHeaders
    );
  }
  const rateLimitResponse = await reserveAdminMutation(
    options.adminMutationRateLimiter,
    identity,
    "installation-create",
    corsHeaders
  );
  if (rateLimitResponse !== null) return rateLimitResponse;
  try {
    const installed = await options.installFlowStore.install({
      appId: identity.appId,
      tenantId: identity.tenantId,
      actor: identity.subject,
      idempotencyKey,
      ...command
    });
    return installed === null
      ? errorResponse(404, "plugin_version_not_found", "plugin version not found", corsHeaders)
      : jsonResponse(201, installed, corsHeaders);
  } catch (error) {
    if (error instanceof AdminInstallFlowError || isInstallValidationError(error)) {
      const code = error.code;
      if (code === "idempotency_key_reused") {
        return errorResponse(409, code, "idempotency key was already used", corsHeaders);
      }
      return errorResponse(
        400,
        code,
        code === "invalid_config"
          ? "installation config validation failed"
          : "capability confirmation does not match manifest",
        corsHeaders
      );
    }
    return errorResponse(500, "internal_error", "internal control-plane error", corsHeaders);
  }
}

async function parseInstallRequest(
  request: Request,
  corsHeaders: Record<string, string> | undefined
): Promise<
  | {
      versionId: string;
      config: Record<string, string | number | boolean>;
      confirmedCapabilities: string[];
      enabled: boolean;
      priority: number;
    }
  | Response
> {
  const contentType = request.headers.get("Content-Type");
  if (
    contentType === null ||
    contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return errorResponse(
      415,
      "unsupported_media_type",
      "application/json body required",
      corsHeaders
    );
  }
  const contentLength = request.headers.get("Content-Length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumInstallBodyBytes)
  ) {
    return errorResponse(413, "request_too_large", "request body too large", corsHeaders);
  }
  let text: string;
  try {
    text = await readBoundedUtf8Body(request, maximumInstallBodyBytes);
  } catch (error) {
    return error instanceof CommandBodyTooLargeError
      ? errorResponse(413, "request_too_large", "request body too large", corsHeaders)
      : errorResponse(400, "invalid_install_request", "invalid installation request", corsHeaders);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isInstallRequest(parsed)) throw new Error("invalid install request");
    return parsed;
  } catch {
    return errorResponse(
      400,
      "invalid_install_request",
      "invalid installation request",
      corsHeaders
    );
  }
}

function isInstallRequest(value: unknown): value is {
  versionId: string;
  config: Record<string, string | number | boolean>;
  confirmedCapabilities: string[];
  enabled: boolean;
  priority: number;
} {
  if (!isRecord(value)) return false;
  if (
    !Object.keys(value).every(
      (key) =>
        key === "versionId" ||
        key === "config" ||
        key === "confirmedCapabilities" ||
        key === "enabled" ||
        key === "priority"
    )
  ) {
    return false;
  }
  if (!isNonEmptyString(value.versionId) || !isRecord(value.config)) return false;
  if (
    !Object.values(value.config).every(
      (entry) =>
        typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
    )
  ) {
    return false;
  }
  if (
    !Array.isArray(value.confirmedCapabilities) ||
    !value.confirmedCapabilities.every(isNonEmptyString) ||
    new Set(value.confirmedCapabilities).size !== value.confirmedCapabilities.length
  ) {
    return false;
  }
  return (
    typeof value.enabled === "boolean" &&
    typeof value.priority === "number" &&
    Number.isSafeInteger(value.priority)
  );
}

function isInstallValidationError(
  error: unknown
): error is { code: "invalid_config" | "capability_confirmation_mismatch" } {
  return (
    isRecord(error) &&
    (error.code === "invalid_config" || error.code === "capability_confirmation_mismatch")
  );
}

function isIdempotencyKey(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9._~-]{16,128}$/u.test(value);
}

async function runInstallationCommand(
  request: Request,
  options: ControlPlaneHttpHandlerOptions,
  corsHeaders: Record<string, string> | undefined
): Promise<Response> {
  if (options.installationCommandStore === undefined) {
    return errorResponse(
      503,
      "installation_command_store_unavailable",
      "installation command store unavailable",
      corsHeaders
    );
  }
  const identity = await resolveAdminIdentity(request, options.identityResolver, corsHeaders);
  if (identity instanceof Response) return identity;
  const forbidden = requireRbac(
    identity,
    "installation:manage",
    "installation_command_forbidden",
    corsHeaders
  );
  if (forbidden !== null) return forbidden;
  const command = await parseInstallationCommand(request, corsHeaders);
  if (command instanceof Response) return command;
  const rateLimitResponse = await reserveAdminMutation(
    options.adminMutationRateLimiter,
    identity,
    "installation-command",
    corsHeaders
  );
  if (rateLimitResponse !== null) return rateLimitResponse;
  try {
    const updated = await options.installationCommandStore.updateInstallation({
      appId: identity.appId,
      tenantId: identity.tenantId,
      actor: identity.subject,
      ...command
    });
    // A common 404 prevents installation enumeration across tenant, app, and corrupt relations.
    if (updated === null) {
      return errorResponse(404, "installation_not_found", "installation not found", corsHeaders);
    }
    if (updated.outcome === "conflict") {
      return errorResponse(
        409,
        "installation_revision_conflict",
        "installation changed; refresh",
        corsHeaders
      );
    }
    return jsonResponse(
      200,
      {
        id: updated.id,
        enabled: updated.enabled,
        priority: updated.priority,
        revision: updated.revision
      },
      corsHeaders
    );
  } catch {
    // Database error strings can contain SQL bindings or stored customer configuration.
    return errorResponse(500, "internal_error", "internal control-plane error", corsHeaders);
  }
}

async function runRollback(
  request: Request,
  options: ControlPlaneHttpHandlerOptions,
  corsHeaders: Record<string, string> | undefined
): Promise<Response> {
  if (options.rollbackStore === undefined) {
    return errorResponse(
      503,
      "rollback_store_unavailable",
      "rollback service unavailable",
      corsHeaders
    );
  }
  const identity = await resolveAdminIdentity(request, options.identityResolver, corsHeaders);
  if (identity instanceof Response) return identity;
  const forbidden = requireRbac(identity, "rollback:execute", "rollback_forbidden", corsHeaders);
  if (forbidden !== null) return forbidden;
  const command = await parseRollbackCommand(request, corsHeaders);
  if (command instanceof Response) return command;
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (!isIdempotencyKey(idempotencyKey)) {
    return errorResponse(
      400,
      "invalid_idempotency_key",
      "valid Idempotency-Key header required",
      corsHeaders
    );
  }
  const rateLimitResponse = await reserveAdminMutation(
    options.adminMutationRateLimiter,
    identity,
    "rollback",
    corsHeaders
  );
  if (rateLimitResponse !== null) return rateLimitResponse;
  try {
    const result = await options.rollbackStore.rollback({
      appId: identity.appId,
      tenantId: identity.tenantId,
      actor: identity.subject,
      idempotencyKey,
      ...command
    });
    // Installation, target-version, and cross-scope misses intentionally share one response.
    if (result === null) {
      return errorResponse(
        404,
        "rollback_target_not_found",
        "rollback target not found",
        corsHeaders
      );
    }
    if (result.outcome === "conflict") {
      return errorResponse(
        409,
        "installation_revision_conflict",
        "installation changed; refresh",
        corsHeaders
      );
    }
    if (result.outcome === "same_version") {
      return errorResponse(
        409,
        "rollback_target_is_current",
        "target version is already current",
        corsHeaders
      );
    }
    return jsonResponse(
      200,
      {
        installationId: result.installationId,
        pluginKey: result.pluginKey,
        fromVersion: result.fromVersion,
        toVersion: result.toVersion,
        revision: result.revision,
        auditId: result.auditId,
        completedAt: result.completedAt
      },
      corsHeaders
    );
  } catch (error) {
    if (error instanceof AdminRollbackError) {
      return errorResponse(409, error.code, "idempotency key was already used", corsHeaders);
    }
    return errorResponse(500, "internal_error", "internal control-plane error", corsHeaders);
  }
}

async function parseRollbackCommand(
  request: Request,
  corsHeaders: Record<string, string> | undefined
): Promise<
  { installationId: string; targetVersionId: string; expectedRevision: number } | Response
> {
  const contentType = request.headers.get("Content-Type");
  if (
    contentType === null ||
    contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return errorResponse(
      415,
      "unsupported_media_type",
      "application/json body required",
      corsHeaders
    );
  }
  const contentLength = request.headers.get("Content-Length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumCommandBodyBytes)
  ) {
    return errorResponse(413, "request_too_large", "request body too large", corsHeaders);
  }
  let text: string;
  try {
    text = await readBoundedUtf8Body(request, maximumCommandBodyBytes);
  } catch (error) {
    return errorResponse(
      error instanceof CommandBodyTooLargeError ? 413 : 400,
      error instanceof CommandBodyTooLargeError ? "request_too_large" : "invalid_rollback",
      error instanceof CommandBodyTooLargeError
        ? "request body too large"
        : "invalid rollback command",
      corsHeaders
    );
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).length !== 3 ||
      !Object.hasOwn(record, "installationId") ||
      !Object.hasOwn(record, "targetVersionId") ||
      !Object.hasOwn(record, "expectedRevision") ||
      !isNonEmptyString(record.installationId) ||
      !isNonEmptyString(record.targetVersionId) ||
      !Number.isSafeInteger(record.expectedRevision) ||
      (record.expectedRevision as number) < 0
    ) {
      throw new Error();
    }
    return {
      installationId: record.installationId,
      targetVersionId: record.targetVersionId,
      expectedRevision: record.expectedRevision as number
    };
  } catch {
    return errorResponse(400, "invalid_rollback", "invalid rollback command", corsHeaders);
  }
}

async function runApprovalDecision(
  request: Request,
  options: ControlPlaneHttpHandlerOptions,
  corsHeaders: Record<string, string> | undefined
): Promise<Response> {
  if (options.approvalDecisionStore === undefined) {
    return errorResponse(
      503,
      "approval_store_unavailable",
      "approval service unavailable",
      corsHeaders
    );
  }
  const identity = await resolveAdminIdentity(request, options.identityResolver, corsHeaders);
  if (identity instanceof Response) return identity;
  const forbidden = requireRbac(
    identity,
    "approval:decide",
    "approval_decision_forbidden",
    corsHeaders
  );
  if (forbidden !== null) return forbidden;
  const command = await parseApprovalDecision(request, corsHeaders);
  if (command instanceof Response) return command;
  const rateLimitResponse = await reserveAdminMutation(
    options.adminMutationRateLimiter,
    identity,
    "approval-decision",
    corsHeaders
  );
  if (rateLimitResponse !== null) return rateLimitResponse;
  try {
    return jsonResponse(
      200,
      await options.approvalDecisionStore.decide({
        appId: identity.appId,
        tenantId: identity.tenantId,
        actor: identity.subject,
        actorRole: identity.role,
        ...command
      }),
      corsHeaders
    );
  } catch (error) {
    if (error instanceof AdminApprovalDecisionError) {
      return errorResponse(
        error.status,
        error.code,
        approvalDecisionMessage(error.code),
        corsHeaders
      );
    }
    return errorResponse(500, "internal_error", "internal control-plane error", corsHeaders);
  }
}

async function parseApprovalDecision(
  request: Request,
  corsHeaders: Record<string, string> | undefined
): Promise<{ approvalId: string; decision: "approved" | "rejected"; reason?: string } | Response> {
  const contentType = request.headers.get("Content-Type");
  if (
    contentType === null ||
    contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return errorResponse(
      415,
      "unsupported_media_type",
      "application/json body required",
      corsHeaders
    );
  }
  let text: string;
  try {
    text = await readBoundedUtf8Body(request, maximumCommandBodyBytes);
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error();
    const keys = Object.keys(parsed);
    const approvalId = typeof parsed.approvalId === "string" ? parsed.approvalId : null;
    if (
      !keys.every((key) => key === "approvalId" || key === "decision" || key === "reason") ||
      !isBoundedFilter(approvalId) ||
      (parsed.decision !== "approved" && parsed.decision !== "rejected") ||
      (parsed.reason !== undefined &&
        (typeof parsed.reason !== "string" ||
          parsed.reason.length === 0 ||
          parsed.reason.length > 1000 ||
          parsed.reason.trim() !== parsed.reason))
    ) {
      throw new Error();
    }
    return {
      approvalId,
      decision: parsed.decision,
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason })
    };
  } catch (error) {
    return errorResponse(
      error instanceof CommandBodyTooLargeError ? 413 : 400,
      error instanceof CommandBodyTooLargeError ? "request_too_large" : "invalid_approval_decision",
      error instanceof CommandBodyTooLargeError
        ? "request body too large"
        : "invalid approval decision",
      corsHeaders
    );
  }
}

function approvalDecisionMessage(code: AdminApprovalDecisionError["code"]): string {
  switch (code) {
    case "approval_not_found":
      return "approval not found";
    case "approval_role_forbidden":
      return "approval role does not match";
    case "approval_expired":
      return "approval has expired";
    case "approval_already_decided":
      return "approval was already decided";
  }
}

async function parseInstallationCommand(
  request: Request,
  corsHeaders: Record<string, string> | undefined
): Promise<
  { id: string; expectedRevision: number; enabled?: boolean; priority?: number } | Response
> {
  const contentType = request.headers.get("Content-Type");
  if (
    contentType === null ||
    contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return errorResponse(
      415,
      "unsupported_media_type",
      "application/json body required",
      corsHeaders
    );
  }
  const contentLength = request.headers.get("Content-Length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumCommandBodyBytes)
  ) {
    return errorResponse(413, "request_too_large", "request body too large", corsHeaders);
  }
  let text: string;
  try {
    text = await readBoundedUtf8Body(request, maximumCommandBodyBytes);
  } catch (error) {
    if (error instanceof CommandBodyTooLargeError) {
      return errorResponse(413, "request_too_large", "request body too large", corsHeaders);
    }
    return errorResponse(400, "invalid_command", "invalid installation command", corsHeaders);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isInstallationCommand(parsed)) throw new Error("invalid command");
    return parsed;
  } catch {
    // Never include invalid body text: it may carry a secret, a claimed tenant, or a bearer copy.
    return errorResponse(400, "invalid_command", "invalid installation command", corsHeaders);
  }
}

function isInstallationCommand(
  value: unknown
): value is { id: string; expectedRevision: number; enabled?: boolean; priority?: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    !keys.every(
      (key) => key === "id" || key === "expectedRevision" || key === "enabled" || key === "priority"
    )
  ) {
    return false;
  }
  if (!isNonEmptyString(record.id)) return false;
  if (!Number.isSafeInteger(record.expectedRevision) || (record.expectedRevision as number) < 0) {
    return false;
  }
  const hasEnabled = Object.hasOwn(record, "enabled");
  const hasPriority = Object.hasOwn(record, "priority");
  if (!hasEnabled && !hasPriority) return false;
  if (hasEnabled && typeof record.enabled !== "boolean") return false;
  if (
    hasPriority &&
    (typeof record.priority !== "number" ||
      !Number.isFinite(record.priority) ||
      !Number.isSafeInteger(record.priority))
  ) {
    return false;
  }
  return true;
}

async function readBoundedUtf8Body(request: Request, maximumBytes: number): Promise<string> {
  const body = request.body;
  if (body === null) throw new Error("missing request body");
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new CommandBodyTooLargeError();
      }
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

class CommandBodyTooLargeError extends Error {}

async function resolveInstallationDetail(
  request: Request,
  id: string,
  options: ControlPlaneHttpHandlerOptions,
  corsHeaders: Record<string, string> | undefined
): Promise<Response> {
  if (options.installationDetailStore === undefined) {
    return errorResponse(
      503,
      "installation_store_unavailable",
      "installation store unavailable",
      corsHeaders
    );
  }
  const identity = await resolveAdminIdentity(request, options.identityResolver, corsHeaders);
  if (identity instanceof Response) return identity;
  const forbidden = requireRbac(
    identity,
    "installation:read",
    "installation_read_forbidden",
    corsHeaders
  );
  if (forbidden !== null) return forbidden;
  try {
    const detail = await options.installationDetailStore.readInstallation({
      appId: identity.appId,
      tenantId: identity.tenantId,
      id
    });
    // A common 404 avoids revealing whether an ID belongs to another tenant or does not exist.
    if (detail === null) {
      return errorResponse(404, "installation_not_found", "installation not found", corsHeaders);
    }
    return jsonResponse(200, detail, corsHeaders);
  } catch {
    return errorResponse(500, "internal_error", "internal control-plane error", corsHeaders);
  }
}

async function resolveSession(
  request: Request,
  identityResolver: IdentityResolver | undefined,
  corsHeaders: Record<string, string> | undefined
): Promise<Response> {
  if (identityResolver === undefined) {
    return errorResponse(
      503,
      "identity_resolver_unavailable",
      "identity service unavailable",
      corsHeaders
    );
  }

  const token = bearerToken(request.headers.get("Authorization"));
  if (token === null) {
    return unauthorizedResponse(corsHeaders);
  }

  try {
    const identity = await identityResolver.resolveToken(token);
    if (identity === null) {
      return unauthorizedResponse(corsHeaders);
    }
    if (!isTenantScopedAdminIdentity(identity)) {
      return errorResponse(
        403,
        "admin_scope_forbidden",
        "tenant-scoped admin access required",
        corsHeaders
      );
    }
    const forbidden = requireRbac(identity, "session:read", "admin_scope_forbidden", corsHeaders);
    if (forbidden !== null) return forbidden;

    // Scope comes only from the trusted token claim. Request query/body values must never
    // select another app or tenant because every later admin read will inherit this identity.
    return jsonResponse(
      200,
      {
        subject: identity.subject,
        role: identity.role,
        appId: identity.appId,
        tenantId: identity.tenantId
      },
      corsHeaders
    );
  } catch {
    // Provider errors may contain tokens or upstream details, so HTTP responses stay redacted.
    return errorResponse(500, "internal_error", "internal control-plane error", corsHeaders);
  }
}

async function runSlackOAuthInstallStart(
  request: Request,
  url: URL,
  options: ControlPlaneHttpHandlerOptions,
  corsHeaders: Record<string, string> | undefined
): Promise<Response> {
  const identity = await resolveAdminIdentity(request, options.identityResolver, corsHeaders);
  if (identity instanceof Response) return identity;
  const forbidden = requireRbac(
    identity,
    "provider-connection:manage",
    "slack_oauth_install_start_forbidden",
    corsHeaders
  );
  if (forbidden !== null) return forbidden;
  if (
    url.search !== "" ||
    request.body !== null ||
    ![null, "0"].includes(request.headers.get("Content-Length"))
  ) {
    return errorResponse(
      400,
      "slack_oauth_install_start_invalid_request",
      "invalid Slack OAuth install-start request",
      corsHeaders
    );
  }
  if (options.slackOAuthInstallStartService === undefined) {
    return errorResponse(
      503,
      "slack_oauth_install_start_unavailable",
      "Slack OAuth install-start unavailable",
      corsHeaders
    );
  }
  const reservation = await reserveAdminMutation(
    options.adminMutationRateLimiter,
    identity,
    "provider-oauth-start",
    corsHeaders
  );
  if (reservation !== null) return reservation;
  try {
    // Authentication and RBAC must complete before state issuance. Otherwise an unauthenticated
    // caller could allocate state or choose the tenant authority later restored by the callback.
    const result = await options.slackOAuthInstallStartService.start({
      appId: identity.appId,
      tenantId: identity.tenantId,
      actorSubject: identity.subject
    });
    return jsonResponse(
      201,
      {
        authorizationUrl: result.authorizationUrl,
        expiresAt: result.expiresAt.toISOString()
      },
      { ...corsHeaders, "Set-Cookie": result.browserBindingCookie }
    );
  } catch {
    return errorResponse(
      503,
      "slack_oauth_install_start_unavailable",
      "Slack OAuth install-start unavailable",
      corsHeaders
    );
  }
}

async function resolveDashboard(
  request: Request,
  route: Exclude<
    AdminRoute,
    | "session"
    | "installationCommand"
    | "installPreview"
    | "installCreate"
    | "installRequestCreate"
    | "rollbackCreate"
    | "approvalDecisionCreate"
    | "serviceTokenCollection"
    | "slackOAuthInstallStart"
    | "executionDetail"
    | "usage"
    | "providerConnections"
    | { id: string }
  >,
  url: URL,
  options: ControlPlaneHttpHandlerOptions,
  corsHeaders: Record<string, string> | undefined
): Promise<Response> {
  if (options.dashboardStore === undefined) {
    return errorResponse(
      503,
      "dashboard_store_unavailable",
      "dashboard store unavailable",
      corsHeaders
    );
  }
  const dashboardStore = options.dashboardStore;

  const limit = dashboardLimit(url.searchParams.get("limit"));
  if (limit === null) {
    return errorResponse(400, "invalid_limit", "limit must be a positive integer", corsHeaders);
  }
  const identity = await resolveAdminIdentity(request, options.identityResolver, corsHeaders);
  if (identity instanceof Response) {
    return identity;
  }
  const forbidden = requireRbac(identity, "dashboard:read", "dashboard_forbidden", corsHeaders);
  if (forbidden !== null) return forbidden;

  try {
    if (route === "operations") {
      if (dashboardStore.readOperationalHealth === undefined) {
        return errorResponse(
          503,
          "dashboard_store_unavailable",
          "dashboard store unavailable",
          corsHeaders
        );
      }
      return jsonResponse(
        200,
        await dashboardStore.readOperationalHealth({
          appId: identity.appId,
          tenantId: identity.tenantId,
          date: (options.now?.() ?? new Date()).toISOString().slice(0, 10)
        }),
        corsHeaders
      );
    }
    if (options.cursorCodec === undefined) {
      return errorResponse(
        503,
        "cursor_service_unavailable",
        "dashboard cursor service unavailable",
        corsHeaders
      );
    }
    const cursorCodec = options.cursorCodec;
    if (route === "dashboard") {
      const sections: readonly AdminDashboardSection[] = [
        "installations",
        "pluginVersions",
        "approvals",
        "executions"
      ];
      const [pages, usage, schemaMigrations] = await Promise.all([
        Promise.all(
          sections.map((section) =>
            dashboardStore.readSection({
              appId: identity.appId,
              tenantId: identity.tenantId,
              section,
              limit
            })
          )
        ),
        dashboardStore.readUsageSummary({
          appId: identity.appId,
          tenantId: identity.tenantId,
          date: (options.now?.() ?? new Date()).toISOString().slice(0, 10)
        }),
        canReadAppWideSchemaMigrations(identity) &&
        dashboardStore.readSchemaMigrations !== undefined
          ? dashboardStore.readSchemaMigrations({ appId: identity.appId })
          : Promise.resolve([])
      ]);
      const serialized = await Promise.all(
        pages.map((page) => serializeSectionPage(page, identity, cursorCodec))
      );
      return jsonResponse(
        200,
        {
          installations: requireSerializedSection(serialized, "installations"),
          pluginVersions: requireSerializedSection(serialized, "pluginVersions"),
          approvals: requireSerializedSection(serialized, "approvals"),
          executions: requireSerializedSection(serialized, "executions"),
          usage,
          schemaMigrations,
          telemetry: options.telemetryStatus ?? {
            enabled: false,
            mode: "disabled",
            schemaVersion: 1
          }
        },
        corsHeaders
      );
    }

    const filters = route === "executions" ? executionFilters(url) : {};
    if (filters === null) {
      return errorResponse(
        400,
        "invalid_execution_filter",
        "invalid execution filter",
        corsHeaders
      );
    }
    const query = executionFilterQuery(filters);

    const cursor = url.searchParams.get("cursor");
    let position: string | undefined;
    if (cursor !== null) {
      const payload = await cursorCodec.decode(cursor);
      if (
        payload.appId !== identity.appId ||
        payload.tenantId !== identity.tenantId ||
        payload.section !== route ||
        payload.query !== query
      ) {
        return errorResponse(400, "invalid_cursor", "invalid dashboard cursor", corsHeaders);
      }
      position = payload.position;
    }
    const page = await dashboardStore.readSection({
      appId: identity.appId,
      tenantId: identity.tenantId,
      section: route,
      limit,
      ...(route === "executions" && Object.keys(filters).length > 0 ? { filters } : {}),
      ...(position === undefined ? {} : { position })
    });
    return jsonResponse(
      200,
      await serializeSectionPage(page, identity, cursorCodec, query),
      corsHeaders
    );
  } catch (error) {
    if (error instanceof Error && error.message === "invalid Admin dashboard cursor") {
      return errorResponse(400, "invalid_cursor", "invalid dashboard cursor", corsHeaders);
    }
    // Store and cursor-provider failures can include SQL, bindings, or customer data.
    return errorResponse(500, "internal_error", "internal control-plane error", corsHeaders);
  }
}

async function resolveProviderConnections(
  request: Request,
  options: ControlPlaneHttpHandlerOptions,
  corsHeaders: Record<string, string> | undefined
): Promise<Response> {
  if (options.providerConnectionStore === undefined) {
    return errorResponse(
      503,
      "provider_connection_store_unavailable",
      "provider connection store unavailable",
      corsHeaders
    );
  }
  const identity = await resolveAdminIdentity(request, options.identityResolver, corsHeaders);
  if (identity instanceof Response) return identity;
  const forbidden = requireRbac(
    identity,
    "dashboard:read",
    "provider_connections_forbidden",
    corsHeaders
  );
  if (forbidden !== null) return forbidden;
  try {
    return jsonResponse(
      200,
      {
        items: await options.providerConnectionStore.readConnections({
          appId: identity.appId,
          tenantId: identity.tenantId
        })
      },
      corsHeaders
    );
  } catch {
    // Storage failures may contain provider metadata or SQL details and remain server-side only.
    return errorResponse(500, "internal_error", "internal control-plane error", corsHeaders);
  }
}

async function resolveExecutionDetail(
  request: Request,
  url: URL,
  options: ControlPlaneHttpHandlerOptions,
  corsHeaders: Record<string, string> | undefined
): Promise<Response> {
  if (options.executionDetailStore === undefined) {
    return errorResponse(
      503,
      "execution_store_unavailable",
      "execution service unavailable",
      corsHeaders
    );
  }
  const identity = await resolveAdminIdentity(request, options.identityResolver, corsHeaders);
  if (identity instanceof Response) return identity;
  const forbidden = requireRbac(
    identity,
    "execution:read",
    "execution_read_forbidden",
    corsHeaders
  );
  if (forbidden !== null) return forbidden;
  const id = url.searchParams.get("id");
  if (
    !isBoundedFilter(id) ||
    url.searchParams.getAll("id").length !== 1 ||
    [...url.searchParams.keys()].some((key) => key !== "id")
  ) {
    return errorResponse(400, "invalid_execution_id", "execution id is required", corsHeaders);
  }
  try {
    const detail = await options.executionDetailStore.readExecution({
      appId: identity.appId,
      tenantId: identity.tenantId,
      id
    });
    return detail === null
      ? errorResponse(404, "execution_not_found", "execution not found", corsHeaders)
      : jsonResponse(200, detail, corsHeaders);
  } catch {
    return errorResponse(500, "internal_error", "internal control-plane error", corsHeaders);
  }
}

async function resolveAdminIdentity(
  request: Request,
  identityResolver: IdentityResolver | undefined,
  corsHeaders: Record<string, string> | undefined
): Promise<TenantScopedAdminIdentity | Response> {
  if (identityResolver === undefined) {
    return errorResponse(
      503,
      "identity_resolver_unavailable",
      "identity service unavailable",
      corsHeaders
    );
  }
  const token = bearerToken(request.headers.get("Authorization"));
  if (token === null) {
    return unauthorizedResponse(corsHeaders);
  }
  try {
    const identity = await identityResolver.resolveToken(token);
    if (identity === null) {
      return unauthorizedResponse(corsHeaders);
    }
    if (!isTenantScopedAdminIdentity(identity)) {
      return errorResponse(
        403,
        "admin_scope_forbidden",
        "tenant-scoped admin access required",
        corsHeaders
      );
    }
    return identity;
  } catch {
    return errorResponse(500, "internal_error", "internal control-plane error", corsHeaders);
  }
}

async function serializeSectionPage(
  page: AdminDashboardSectionPage,
  identity: TenantScopedAdminIdentity,
  cursorCodec: AdminCursorCodec,
  query?: string
) {
  const nextCursor =
    page.nextPosition === undefined
      ? undefined
      : await cursorCodec.encode({
          appId: identity.appId,
          tenantId: identity.tenantId,
          section: page.section,
          position: page.nextPosition,
          ...(query === undefined ? {} : { query })
        });
  return {
    section: page.section,
    items: page.items,
    ...(nextCursor === undefined ? {} : { nextCursor })
  };
}

function executionFilters(url: URL): AdminExecutionFilters | null {
  const allowed = new Set(["cursor", "limit", "pluginId", "hookName", "status"]);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return null;
  for (const key of allowed) {
    if (url.searchParams.getAll(key).length > 1) return null;
  }
  const pluginId = url.searchParams.get("pluginId");
  const hookName = url.searchParams.get("hookName");
  const status = url.searchParams.get("status");
  if (
    (pluginId !== null && !isBoundedFilter(pluginId)) ||
    (hookName !== null && !isBoundedFilter(hookName)) ||
    (status !== null && !isExecutionStatus(status))
  ) {
    return null;
  }
  return {
    ...(pluginId === null ? {} : { pluginId }),
    ...(hookName === null ? {} : { hookName }),
    ...(status === null ? {} : { status })
  };
}

function executionFilterQuery(filters: AdminExecutionFilters): string | undefined {
  return Object.keys(filters).length === 0
    ? undefined
    : JSON.stringify({
        pluginId: filters.pluginId ?? "",
        hookName: filters.hookName ?? "",
        status: filters.status ?? ""
      });
}

function isBoundedFilter(value: string | null): value is string {
  return value !== null && value.length > 0 && value.length <= 256 && value.trim() === value;
}

function isExecutionStatus(value: string): value is NonNullable<AdminExecutionFilters["status"]> {
  return (
    value === "success" ||
    value === "error" ||
    value === "timeout" ||
    value === "egress_denied" ||
    value === "budget_exceeded"
  );
}

function requireSerializedSection(
  pages: readonly SerializedSectionPage[],
  section: AdminDashboardSection
): Omit<SerializedSectionPage, "section"> {
  const page = pages.find((candidate) => candidate.section === section);
  if (page === undefined) {
    throw new Error(`dashboard section ${section} was not returned`);
  }
  return {
    items: page.items,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor })
  };
}

interface SerializedSectionPage {
  section: AdminDashboardSection;
  items: readonly unknown[];
  nextCursor?: string;
}

function dashboardLimit(value: string | null): number | null {
  if (value === null) {
    return 20;
  }
  if (!/^\d+$/u.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return parsed > 0 ? Math.min(parsed, 50) : null;
}

function canReadAppWideSchemaMigrations(identity: TenantScopedAdminIdentity): boolean {
  const role = normalizeRbacRole(identity.role);
  return role === "owner" || role === "admin";
}

function bearerToken(authorization: string | null): string | null {
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  return match?.[1] ?? null;
}

function isTenantScopedAdminIdentity(
  identity: AuthenticatedIdentity
): identity is TenantScopedAdminIdentity {
  const candidate = identity as Partial<TenantScopedAdminIdentity>;
  return (
    isSupportedRbacRole(candidate.role) &&
    isNonEmptyString(candidate.subject) &&
    isNonEmptyString(candidate.appId) &&
    isNonEmptyString(candidate.tenantId) &&
    (candidate.allowedOperations === undefined ||
      (Array.isArray(candidate.allowedOperations) &&
        candidate.allowedOperations.length > 0 &&
        candidate.allowedOperations.every(isRbacOperation) &&
        new Set(candidate.allowedOperations).size === candidate.allowedOperations.length &&
        candidate.allowedOperations.every((operation) =>
          canRolePerform(candidate.role as string, operation)
        )))
  );
}

function requireRbac(
  identity: TenantScopedAdminIdentity,
  operation: RbacOperation,
  errorCode: string,
  corsHeaders: Record<string, string> | undefined
): Response | null {
  return canRolePerform(identity.role, operation) &&
    (identity.allowedOperations === undefined || identity.allowedOperations.includes(operation))
    ? null
    : errorResponse(403, errorCode, "operation not permitted", corsHeaders);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function unauthorizedResponse(corsHeaders: Record<string, string> | undefined): Response {
  return errorResponse(401, "unauthorized", "valid bearer token required", {
    ...corsHeaders,
    "WWW-Authenticate": "Bearer"
  });
}

function preflightResponse(
  corsHeaders: Record<string, string> | undefined,
  methods: string
): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders,
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key",
      "Access-Control-Allow-Methods": methods,
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store"
    }
  });
}

function allowedMethods(contract: AdminHttpEndpointContract): string {
  return [...contract.methods, "OPTIONS"].join(", ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function reserveAdminMutation(
  limiter: AdminMutationRateLimiter | undefined,
  identity: TenantScopedAdminIdentity,
  family: AdminMutationFamily,
  corsHeaders: Record<string, string> | undefined
): Promise<Response | null> {
  if (limiter === undefined) {
    return errorResponse(
      503,
      "admin_mutation_rate_limit_unavailable",
      "admin mutation protection unavailable",
      corsHeaders
    );
  }
  try {
    const result = await limiter.reserve({
      appId: identity.appId,
      tenantId: identity.tenantId,
      actor: identity.subject,
      family
    });
    if (result.allowed) return null;
    return errorResponse(429, "admin_mutation_rate_limited", "too many admin changes", {
      ...corsHeaders,
      "Retry-After": String(result.retryAfterSeconds)
    });
  } catch {
    // Privileged mutations fail closed. Durable Object errors may contain object IDs or
    // deployment details, so the public response is stable and deliberately redacted.
    return errorResponse(
      503,
      "admin_mutation_rate_limit_unavailable",
      "admin mutation protection unavailable",
      corsHeaders
    );
  }
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>
): Response {
  const body: HttpErrorBody = { error: { code, message } };
  return jsonResponse(status, body, headers);
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function corsResponseHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin"
  };
}

function createAllowedOriginSet(origins: readonly string[]): ReadonlySet<string> {
  const normalized = origins.map((origin) => {
    if (origin === "*") {
      throw new Error("wildcard origins are not allowed for the Admin API");
    }
    const url = new URL(origin);
    if (url.origin !== origin) {
      throw new Error(`invalid Admin API origin: ${origin}`);
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
      throw new Error("Admin API origins must use https except for loopback development");
    }
    return origin;
  });
  return new Set(normalized);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
