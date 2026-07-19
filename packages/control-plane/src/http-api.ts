import type { AuthenticatedIdentity, IdentityResolver } from "./api.js";
import type {
  AdminCursorCodec,
  AdminDashboardSection,
  AdminDashboardSectionPage,
  AdminDashboardStore,
  AdminExecutionFilters
} from "./admin-dashboard.js";
import type { AdminExecutionDetailStore } from "./admin-executions.js";
import type {
  AdminInstallationCommandStore,
  AdminInstallationDetailStore
} from "./admin-installations.js";
import { AdminInstallFlowError, type AdminInstallFlowStore } from "./admin-install-flow.js";
import type { AdminRollbackStore } from "./admin-rollbacks.js";

export type AdminRole = "manager" | "viewer";

export interface TenantScopedAdminIdentity extends AuthenticatedIdentity {
  role: AdminRole;
  appId: string;
  tenantId: string;
}

export interface ControlPlaneHttpHandlerOptions {
  identityResolver?: IdentityResolver;
  dashboardStore?: AdminDashboardStore;
  cursorCodec?: AdminCursorCodec;
  installationDetailStore?: AdminInstallationDetailStore;
  installationCommandStore?: AdminInstallationCommandStore;
  installFlowStore?: AdminInstallFlowStore;
  rollbackStore?: AdminRollbackStore;
  executionDetailStore?: AdminExecutionDetailStore;
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
    const route = adminRoute(url);
    if (route === null) {
      return errorResponse(404, "route_not_found", "route not found", corsHeaders);
    }

    if (request.method === "OPTIONS") {
      if (origin === null) {
        return errorResponse(403, "origin_required", "request origin is required");
      }
      return preflightResponse(corsHeaders, allowedMethods(route));
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
    if (route === "rollbackCreate") {
      if (request.method !== "POST") {
        return errorResponse(405, "method_not_allowed", "method not allowed", {
          ...corsHeaders,
          Allow: "POST, OPTIONS"
        });
      }
      return runRollback(request, options, corsHeaders);
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
    if (typeof route === "object") {
      return resolveInstallationDetail(request, route.id, options, corsHeaders);
    }
    return resolveDashboard(request, route, url, options, corsHeaders);
  };
}

type AdminRoute =
  | "session"
  | "dashboard"
  | "installationCommand"
  | "installPreview"
  | "installCreate"
  | "rollbackCreate"
  | "executionDetail"
  | AdminDashboardSection
  | { id: string };

function adminRoute(url: URL): AdminRoute | null {
  const path = url.pathname;
  if (path === "/v1/session") {
    return "session";
  }
  if (path === "/v1/admin/dashboard") {
    return "dashboard";
  }
  if (path === "/v1/admin/installation-review") {
    const id = url.searchParams.get("id");
    return id === null || id.length === 0 ? null : { id };
  }
  if (path === "/v1/admin/installation-command") {
    return "installationCommand";
  }
  if (path === "/v1/admin/install-preview") {
    return "installPreview";
  }
  if (path === "/v1/admin/installations") {
    return "installCreate";
  }
  if (path === "/v1/admin/rollbacks") {
    return "rollbackCreate";
  }
  if (path === "/v1/admin/execution-detail") {
    return "executionDetail";
  }
  const section = path.slice("/v1/admin/dashboard/".length);
  if (path.startsWith("/v1/admin/dashboard/") && isDashboardSection(section)) {
    return section;
  }
  return null;
}

const maximumCommandBodyBytes = 16 * 1024;
const maximumInstallBodyBytes = 64 * 1024;

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
  if (identity.role !== "manager") {
    return errorResponse(
      403,
      "installation_install_forbidden",
      "manager role required",
      corsHeaders
    );
  }
  const command = await parseInstallRequest(request, corsHeaders);
  if (command instanceof Response) return command;
  try {
    const installed = await options.installFlowStore.install({
      appId: identity.appId,
      tenantId: identity.tenantId,
      actor: identity.subject,
      ...command
    });
    return installed === null
      ? errorResponse(404, "plugin_version_not_found", "plugin version not found", corsHeaders)
      : jsonResponse(201, installed, corsHeaders);
  } catch (error) {
    if (error instanceof AdminInstallFlowError || isInstallValidationError(error)) {
      const code = error.code;
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
  if (identity.role !== "manager") {
    return errorResponse(
      403,
      "installation_command_forbidden",
      "manager role required",
      corsHeaders
    );
  }
  const command = await parseInstallationCommand(request, corsHeaders);
  if (command instanceof Response) return command;
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
  if (identity.role !== "manager") {
    return errorResponse(403, "rollback_forbidden", "manager role required", corsHeaders);
  }
  const command = await parseRollbackCommand(request, corsHeaders);
  if (command instanceof Response) return command;
  try {
    const result = await options.rollbackStore.rollback({
      appId: identity.appId,
      tenantId: identity.tenantId,
      actor: identity.subject,
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
  } catch {
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

async function resolveDashboard(
  request: Request,
  route: Exclude<
    AdminRoute,
    | "session"
    | "installationCommand"
    | "installPreview"
    | "installCreate"
    | "rollbackCreate"
    | "executionDetail"
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
  if (options.cursorCodec === undefined) {
    return errorResponse(
      503,
      "cursor_service_unavailable",
      "dashboard cursor service unavailable",
      corsHeaders
    );
  }
  const dashboardStore = options.dashboardStore;
  const cursorCodec = options.cursorCodec;

  const limit = dashboardLimit(url.searchParams.get("limit"));
  if (limit === null) {
    return errorResponse(400, "invalid_limit", "limit must be a positive integer", corsHeaders);
  }
  const identity = await resolveAdminIdentity(request, options.identityResolver, corsHeaders);
  if (identity instanceof Response) {
    return identity;
  }

  try {
    if (route === "dashboard") {
      const sections: readonly AdminDashboardSection[] = [
        "installations",
        "pluginVersions",
        "approvals",
        "executions"
      ];
      const [pages, usage] = await Promise.all([
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
        })
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
          usage
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

function isDashboardSection(value: string): value is AdminDashboardSection {
  return (
    value === "installations" ||
    value === "pluginVersions" ||
    value === "approvals" ||
    value === "executions"
  );
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
    (candidate.role === "manager" || candidate.role === "viewer") &&
    isNonEmptyString(candidate.subject) &&
    isNonEmptyString(candidate.appId) &&
    isNonEmptyString(candidate.tenantId)
  );
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
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": methods,
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store"
    }
  });
}

function allowedMethods(route: AdminRoute): string {
  if (route === "installationCommand") return "PATCH, OPTIONS";
  if (route === "installCreate" || route === "rollbackCreate") return "POST, OPTIONS";
  return "GET, OPTIONS";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
