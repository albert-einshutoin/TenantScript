import {
  createSlackWorkspaceConnector,
  createStaticTokenIdentityResolver,
  type AuthenticatedIdentity,
  type IdentityResolver
} from "./api.js";
import { createAdminCursorCodec, createD1AdminDashboardStore } from "./admin-dashboard.js";
import {
  createD1AdminInstallationCommandStore,
  createD1AdminInstallationDetailStore
} from "./admin-installations.js";
import { createD1AdminInstallFlowStore } from "./admin-install-flow.js";
import { createD1AdminInstallRequestStore } from "./admin-install-requests.js";
import { createD1AdminRollbackStore } from "./admin-rollbacks.js";
import { createD1AdminExecutionDetailStore } from "./admin-executions.js";
import { createD1AdminApprovalDecisionStore } from "./admin-approvals.js";
import { createD1AdminProviderConnectionStore } from "./admin-provider-connections.js";
import {
  createAdminMutationRateLimiter,
  createDurableObjectAdminMutationRateLimitStore,
  evaluateFixedWindowReservation,
  parseAdminMutationRateLimitConfiguration
} from "./admin-mutation-rate-limit.js";
import { createAppDatabaseRouterFromBindings } from "./app-database-router.js";
import { createControlPlaneHttpHandler, matchAdminHttpEndpoint } from "./http-api.js";
import { parsePublishedHookSchemaCatalog } from "./schema-migrations.js";
import {
  createD1TelemetrySnapshotSource,
  createHttpTelemetrySink,
  parseTelemetryConfiguration,
  publicTelemetryStatus,
  runTelemetrySchedule,
  type TelemetryScheduleResult
} from "./telemetry.js";
import {
  createD1ServiceTokenStore,
  createServiceTokenAwareIdentityResolver,
  createServiceTokenIdentityResolver,
  createServiceTokenManager
} from "./service-tokens.js";
import { createD1R2ExecutionArchiveStore } from "./execution-archive.js";
import type { ArchiveExpiredExecutionsRequest } from "./execution-archive.js";
import {
  createD1ControlPlaneStore,
  createD1SlackConnectionStore,
  type D1DatabaseLike,
  type R2BucketLike
} from "./storage.js";
import {
  createAnalyticsEngineUsageSink,
  createD1DailyUsageSummaryStore,
  createUsageMeter,
  type AnalyticsEngineDatasetLike
} from "./usage-meter.js";
import { createDurableObjectNamespaceOAuthStateStore } from "./oauth-state-store.js";
import {
  createDurableObjectNamespaceSecretStore,
  validateProviderSecretKeyringConfiguration
} from "./provider-secret-store-do.js";
import { createSlackOAuthCallbackService } from "./slack-oauth-callback.js";
import {
  SLACK_OAUTH_CALLBACK_PATH,
  slackOAuthCallbackUnavailableResponse,
  type SlackOAuthCallbackHttpConfiguration
} from "./slack-oauth-callback-http.js";
import { createSlackOAuthClient } from "./slack-oauth-client.js";
import { createSlackOAuthInstallStartService } from "./slack-oauth-install-start.js";
export { ProviderSecretStoreDurableObject } from "./provider-secret-store-do.js";
export { OAuthStateStoreDurableObject } from "./oauth-state-store.js";

const SCHEDULED_RETENTION_SCOPE_LIMIT = 50;

interface ControlPlaneWorkerEnv {
  ADMIN_ALLOWED_ORIGINS?: string;
  ADMIN_CURSOR_SECRET?: string;
  ADMIN_IDENTITIES_JSON?: string;
  ADMIN_HOOK_SCHEMA_CATALOG_JSON?: string;
  ADMIN_MUTATION_RATE_LIMIT?: string;
  ADMIN_MUTATION_RATE_WINDOW_SECONDS?: string;
  ADMIN_MUTATION_RATE_LIMITER_DO?: DurableObjectNamespace;
  APP_DATABASE_ROUTES_JSON?: string;
  EXECUTION_ARCHIVE?: R2BucketLike;
  EXECUTION_ARCHIVE_HOT_RETENTION_DAYS?: string;
  PROVIDER_SECRET_KEYRING_JSON?: string;
  PROVIDER_SECRET_STORE_DO?: DurableObjectNamespace;
  OAUTH_STATE_STORE_DO?: DurableObjectNamespace;
  SLACK_OAUTH_CLIENT_ID?: string;
  SLACK_OAUTH_CLIENT_SECRET?: string;
  SLACK_OAUTH_FAILURE_REDIRECT_URI?: string;
  SLACK_OAUTH_REDIRECT_URI?: string;
  SLACK_OAUTH_SCOPES?: string;
  SLACK_OAUTH_SUCCESS_REDIRECT_URI?: string;
  TENANTSCRIPT_TELEMETRY_ENABLED?: string;
  TENANTSCRIPT_TELEMETRY_ENDPOINT?: string;
  TENANTSCRIPT_PRODUCT_VERSION?: string;
  TENANTSCRIPT_RUNTIME_PRIMITIVE?: string;
  USAGE_ANALYTICS?: AnalyticsEngineDatasetLike;
  DB?: D1DatabaseLike;
  [binding: string]: unknown;
}

export class ProbeDurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch() {
    const count = (await this.state.storage.get<number>("count")) ?? 0;
    const nextCount = count + 1;
    await this.state.storage.put("count", nextCount);
    return new Response(String(nextCount));
  }
}

export class AdminMutationRateLimitDurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/reserve") {
      return new Response(null, { status: 404 });
    }
    try {
      const input: unknown = await request.json();
      if (!isRateLimitReservationInput(input)) return new Response(null, { status: 400 });
      // Storage transactions protect the persisted record, while blockConcurrencyWhile also keeps
      // separate fetch events from interleaving their reservation critical sections in one DO.
      const result = await this.state.blockConcurrencyWhile(() =>
        this.state.storage.transaction(async (transaction) => {
          const current = await transaction.get<{ windowStartedAt: number; count: number }>(
            "window"
          );
          const evaluated = evaluateFixedWindowReservation({ current, ...input });
          await transaction.put("window", evaluated.record);
          return {
            count: evaluated.count,
            windowStartedAt: evaluated.record.windowStartedAt
          };
        })
      );
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return new Response(null, { status: 500 });
    }
  }
}

export default {
  async fetch(request: Request, env: ControlPlaneWorkerEnv) {
    const identities = parseIdentityConfiguration(env.ADMIN_IDENTITIES_JSON);
    const allowedOrigins = parseAllowedOrigins(env.ADMIN_ALLOWED_ORIGINS);
    const serviceTokenStore = env.DB === undefined ? undefined : createD1ServiceTokenStore(env.DB);
    const bootstrapIdentityResolver =
      identities === undefined ? undefined : createStaticTokenIdentityResolver(identities);
    const identityResolver =
      serviceTokenStore === undefined
        ? bootstrapIdentityResolver
        : createServiceTokenAwareIdentityResolver({
            serviceTokens: createServiceTokenIdentityResolver(serviceTokenStore),
            ...(bootstrapIdentityResolver === undefined
              ? {}
              : { bootstrap: bootstrapIdentityResolver })
          });
    let requestDatabase = env.DB;
    let resolveAppDatabase: (appId: string) => D1DatabaseLike | null = () => env.DB ?? null;
    try {
      if (env.APP_DATABASE_ROUTES_JSON !== undefined) {
        const router = createAppDatabaseRouterFromBindings({
          serializedRoutes: env.APP_DATABASE_ROUTES_JSON,
          bindings: env
        });
        resolveAppDatabase = router.resolve;
        const routed = await resolveRequestDatabase({
          request,
          identityResolver,
          allowedOrigins,
          resolveDatabase: router.resolve
        });
        if (routed instanceof Response) return routed;
        requestDatabase = routed;
      }
    } catch {
      return configurationUnavailableResponseForRequest(request);
    }
    const installationDetailStore =
      requestDatabase === undefined
        ? undefined
        : createD1AdminInstallationDetailStore(requestDatabase);
    const installationCommandStore =
      requestDatabase === undefined
        ? undefined
        : createD1AdminInstallationCommandStore(requestDatabase);
    const installFlowStore =
      requestDatabase === undefined ? undefined : createD1AdminInstallFlowStore(requestDatabase);
    const installRequestStore =
      requestDatabase === undefined ? undefined : createD1AdminInstallRequestStore(requestDatabase);
    const rollbackStore =
      requestDatabase === undefined ? undefined : createD1AdminRollbackStore(requestDatabase);
    const executionDetailStore =
      requestDatabase === undefined
        ? undefined
        : createD1AdminExecutionDetailStore(requestDatabase);
    const approvalDecisionStore =
      requestDatabase === undefined
        ? undefined
        : createD1AdminApprovalDecisionStore(requestDatabase);
    const providerConnectionStore =
      requestDatabase === undefined
        ? undefined
        : createD1AdminProviderConnectionStore(requestDatabase);
    let handler;
    try {
      const telemetryConfiguration = parseWorkerTelemetryConfiguration(env);
      const schemaCatalog = parseSchemaCatalogConfiguration(env.ADMIN_HOOK_SCHEMA_CATALOG_JSON);
      const dashboardStore =
        requestDatabase === undefined
          ? undefined
          : createD1AdminDashboardStore(requestDatabase, schemaCatalog);
      const cursorCodec =
        env.ADMIN_CURSOR_SECRET === undefined
          ? undefined
          : createAdminCursorCodec(env.ADMIN_CURSOR_SECRET);
      const rateLimiter =
        env.ADMIN_MUTATION_RATE_LIMITER_DO === undefined
          ? undefined
          : createAdminMutationRateLimiter({
              store: createDurableObjectAdminMutationRateLimitStore(
                env.ADMIN_MUTATION_RATE_LIMITER_DO
              ),
              ...parseAdminMutationRateLimitConfiguration({
                ...(env.ADMIN_MUTATION_RATE_LIMIT === undefined
                  ? {}
                  : { limit: env.ADMIN_MUTATION_RATE_LIMIT }),
                ...(env.ADMIN_MUTATION_RATE_WINDOW_SECONDS === undefined
                  ? {}
                  : { windowSeconds: env.ADMIN_MUTATION_RATE_WINDOW_SECONDS })
              })
            });
      const usageMeter =
        requestDatabase === undefined
          ? undefined
          : createUsageMeter({
              summaries: createD1DailyUsageSummaryStore(requestDatabase),
              ...(env.USAGE_ANALYTICS === undefined
                ? {}
                : { sink: createAnalyticsEngineUsageSink(env.USAGE_ANALYTICS) })
            });
      const slackOAuthInstallStartService = createWorkerSlackOAuthInstallStartService(env);
      const slackOAuthCallback = await createWorkerSlackOAuthCallbackConfiguration(
        env,
        resolveAppDatabase
      );
      handler = createControlPlaneHttpHandler({
        ...(identityResolver === undefined ? {} : { identityResolver }),
        ...(dashboardStore === undefined ? {} : { dashboardStore }),
        ...(providerConnectionStore === undefined ? {} : { providerConnectionStore }),
        ...(installationDetailStore === undefined ? {} : { installationDetailStore }),
        ...(installationCommandStore === undefined ? {} : { installationCommandStore }),
        ...(installFlowStore === undefined ? {} : { installFlowStore }),
        ...(installRequestStore === undefined ? {} : { installRequestStore }),
        ...(rollbackStore === undefined ? {} : { rollbackStore }),
        ...(executionDetailStore === undefined ? {} : { executionDetailStore }),
        ...(approvalDecisionStore === undefined ? {} : { approvalDecisionStore }),
        ...(serviceTokenStore === undefined
          ? {}
          : { serviceTokenManager: createServiceTokenManager({ store: serviceTokenStore }) }),
        ...(rateLimiter === undefined ? {} : { adminMutationRateLimiter: rateLimiter }),
        ...(usageMeter === undefined ? {} : { usageMeter }),
        ...(slackOAuthCallback === undefined ? {} : { slackOAuthCallback }),
        ...(slackOAuthInstallStartService === undefined ? {} : { slackOAuthInstallStartService }),
        ...(cursorCodec === undefined ? {} : { cursorCodec }),
        telemetryStatus: publicTelemetryStatus(telemetryConfiguration),
        allowedOrigins
      });
    } catch {
      // Binding errors can contain deployment values. Return a stable response without
      // reflecting invalid origin or secret configuration into the public Worker response.
      return configurationUnavailableResponseForRequest(request);
    }
    return handler(request);
  },

  scheduled(
    _controller: ScheduledController,
    env: ControlPlaneWorkerEnv,
    context: ExecutionContext
  ): void {
    scheduleMaintenanceTasks(env, (task) => {
      context.waitUntil(task);
    });
  }
};

function createWorkerSlackOAuthInstallStartService(env: ControlPlaneWorkerEnv) {
  const providerValues = [
    env.SLACK_OAUTH_CLIENT_ID,
    env.SLACK_OAUTH_REDIRECT_URI,
    env.SLACK_OAUTH_SCOPES
  ];
  // The state namespace is shared platform infrastructure and may be deployed before any provider.
  // Only provider-specific intent activates Slack's all-or-nothing configuration requirement.
  if (providerValues.every((value) => value === undefined)) return undefined;
  if (
    env.OAUTH_STATE_STORE_DO === undefined ||
    providerValues.some((value) => value === undefined)
  ) {
    throw new Error("Slack OAuth install-start configuration is incomplete");
  }
  const scopes = (env.SLACK_OAUTH_SCOPES as string).split(",");
  return createSlackOAuthInstallStartService({
    stateStore: createDurableObjectNamespaceOAuthStateStore(env.OAUTH_STATE_STORE_DO),
    clientId: env.SLACK_OAUTH_CLIENT_ID as string,
    redirectUri: env.SLACK_OAUTH_REDIRECT_URI as string,
    scopes
  });
}

const validatedCallbackKeyringEnvironments = new WeakSet();

async function createWorkerSlackOAuthCallbackConfiguration(
  env: ControlPlaneWorkerEnv,
  resolveAppDatabase: (appId: string) => D1DatabaseLike | null
): Promise<SlackOAuthCallbackHttpConfiguration | undefined> {
  const callbackValues = [
    env.SLACK_OAUTH_CLIENT_SECRET,
    env.SLACK_OAUTH_SUCCESS_REDIRECT_URI,
    env.SLACK_OAUTH_FAILURE_REDIRECT_URI
  ];
  if (callbackValues.every((value) => value === undefined)) return undefined;
  if (
    env.OAUTH_STATE_STORE_DO === undefined ||
    env.PROVIDER_SECRET_STORE_DO === undefined ||
    env.PROVIDER_SECRET_KEYRING_JSON === undefined ||
    env.SLACK_OAUTH_CLIENT_ID === undefined ||
    env.SLACK_OAUTH_REDIRECT_URI === undefined ||
    callbackValues.some((value) => value === undefined) ||
    (env.DB === undefined && env.APP_DATABASE_ROUTES_JSON === undefined)
  ) {
    throw new Error("Slack OAuth callback configuration is incomplete");
  }
  if (!validatedCallbackKeyringEnvironments.has(env)) {
    // Import the configured non-extractable keys before any one-shot code can be exchanged. The
    // Worker environment is deployment-immutable, so a WeakSet avoids repeating crypto imports
    // without retaining the secret configuration string as a cache key.
    await validateProviderSecretKeyringConfiguration(env.PROVIDER_SECRET_KEYRING_JSON);
    validatedCallbackKeyringEnvironments.add(env);
  }
  const slackOAuth = createSlackOAuthClient({
    clientId: env.SLACK_OAUTH_CLIENT_ID,
    clientSecret: env.SLACK_OAUTH_CLIENT_SECRET as string,
    allowedRedirectUris: [env.SLACK_OAUTH_REDIRECT_URI]
  });
  const secretStore = createDurableObjectNamespaceSecretStore(env.PROVIDER_SECRET_STORE_DO);
  const service = createSlackOAuthCallbackService({
    stateStore: createDurableObjectNamespaceOAuthStateStore(env.OAUTH_STATE_STORE_DO),
    connectSlackWorkspace: (request) => {
      const database = resolveAppDatabase(request.appId);
      if (database === null) throw new Error("Slack OAuth callback app database unavailable");
      // State is consumed before this resolver runs, so the server-restored app ID—not callback
      // input—selects the tenant database used for connection metadata and tenant validation.
      return createSlackWorkspaceConnector({
        store: createD1ControlPlaneStore(database),
        secretStore,
        slackConnections: createD1SlackConnectionStore(database),
        slackOAuth
      })(request);
    }
  });
  return {
    service,
    successRedirectUri: env.SLACK_OAUTH_SUCCESS_REDIRECT_URI as string,
    failureRedirectUri: env.SLACK_OAUTH_FAILURE_REDIRECT_URI as string
  };
}

async function resolveRequestDatabase(params: {
  request: Request;
  identityResolver: IdentityResolver | undefined;
  allowedOrigins: readonly string[];
  resolveDatabase: (appId: string) => D1DatabaseLike | null;
}): Promise<D1DatabaseLike | Response | undefined> {
  const origin = params.request.headers.get("Origin");
  const endpoint = matchAdminHttpEndpoint(new URL(params.request.url));
  if (
    endpoint === null ||
    params.request.method === "OPTIONS" ||
    !endpoint.contract.methods.some((method) => method === params.request.method) ||
    (origin !== null && !params.allowedOrigins.includes(origin))
  ) {
    return undefined;
  }
  const token = bearerToken(params.request.headers.get("Authorization"));
  if (token === null) return workerUnauthorizedResponse(origin);
  if (params.identityResolver === undefined) return identityUnavailableResponse(origin);
  const identity = await params.identityResolver.resolveToken(token);
  if (identity === null) return workerUnauthorizedResponse(origin);
  if (identity.appId === undefined) return undefined;
  const database = params.resolveDatabase(identity.appId);
  if (database !== null) return database;

  // Never retry against the compatibility DB: an incomplete provisioning route must not become
  // a cross-app data-placement failure.
  return workerErrorResponse({
    status: 503,
    code: "app_database_unavailable",
    message: "App database unavailable",
    origin
  });
}

function workerUnauthorizedResponse(origin: string | null): Response {
  return workerErrorResponse({
    status: 401,
    code: "unauthorized",
    message: "valid bearer token required",
    origin,
    headers: { "WWW-Authenticate": "Bearer" }
  });
}

function identityUnavailableResponse(origin: string | null): Response {
  return workerErrorResponse({
    status: 503,
    code: "identity_resolver_unavailable",
    message: "identity service unavailable",
    origin
  });
}

function workerErrorResponse(params: {
  status: number;
  code: string;
  message: string;
  origin: string | null;
  headers?: Record<string, string>;
}): Response {
  return Response.json(
    { error: { code: params.code, message: params.message } },
    {
      status: params.status,
      headers: {
        "Cache-Control": "no-store",
        ...(params.origin === null
          ? {}
          : { "Access-Control-Allow-Origin": params.origin, Vary: "Origin" }),
        ...params.headers
      }
    }
  );
}

function bearerToken(authorization: string | null): string | null {
  return authorization?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? null;
}

function configurationUnavailableResponse(): Response {
  return Response.json(
    {
      error: {
        code: "admin_configuration_unavailable",
        message: "Admin API configuration unavailable"
      }
    },
    { status: 503, headers: { "Cache-Control": "no-store" } }
  );
}

function configurationUnavailableResponseForRequest(request: Request): Response {
  // Callback failures must always clear the one-time browser binding, including failures that
  // happen while constructing the app database router before the callback handler exists.
  return new URL(request.url).pathname === SLACK_OAUTH_CALLBACK_PATH
    ? slackOAuthCallbackUnavailableResponse()
    : configurationUnavailableResponse();
}

export async function runScheduledTelemetry(
  env: ControlPlaneWorkerEnv,
  options: { fetcher?: typeof fetch; now?: () => Date } = {}
): Promise<TelemetryScheduleResult> {
  const configuration = parseWorkerTelemetryConfiguration(env);
  if (!configuration.enabled) {
    return { sent: false, reason: "disabled" };
  }
  if (env.DB === undefined) {
    throw new Error("telemetry aggregate database is unavailable");
  }
  return runTelemetrySchedule({
    configuration,
    source: createD1TelemetrySnapshotSource(env.DB),
    sink: createHttpTelemetrySink({
      endpoint: configuration.endpoint,
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher })
    }),
    ...(options.now === undefined ? {} : { now: options.now })
  });
}

export interface ScheduledExecutionRetentionResult {
  status: "disabled" | "completed";
  scannedScopes: number;
  archivedScopes: number;
}

export async function runScheduledExecutionRetention(
  env: ControlPlaneWorkerEnv,
  options: {
    now?: () => Date;
    archiveScope?: (request: ArchiveExpiredExecutionsRequest) => Promise<object | null>;
  } = {}
): Promise<ScheduledExecutionRetentionResult> {
  if (env.EXECUTION_ARCHIVE_HOT_RETENTION_DAYS === undefined) {
    return { status: "disabled", scannedScopes: 0, archivedScopes: 0 };
  }
  const hotRetentionDays = parseHotRetentionDays(env.EXECUTION_ARCHIVE_HOT_RETENTION_DAYS);
  if (env.DB === undefined || env.EXECUTION_ARCHIVE === undefined) {
    throw new Error("execution retention configuration is invalid");
  }

  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("execution retention configuration is invalid");
  }
  const cutoff = new Date(now.getTime() - hotRetentionDays * 86_400_000);
  const rows = await env.DB.prepare(
    `SELECT t.id, t.app_id
       FROM tenants t
       WHERE EXISTS (
         SELECT 1 FROM executions e WHERE e.tenant_id = t.id AND e.created_at < ?
       )
       ORDER BY t.app_id ASC, t.id ASC
       LIMIT ?`
  )
    .bind(cutoff.toISOString(), SCHEDULED_RETENTION_SCOPE_LIMIT)
    .all();
  // Keep the application-side cap as defense in depth for test doubles or non-D1 adapters that
  // do not enforce the SQL LIMIT contract exactly.
  const scopes = rows.results.slice(0, SCHEDULED_RETENTION_SCOPE_LIMIT).map(parseRetentionScope);
  const archiveScope =
    options.archiveScope ??
    createD1R2ExecutionArchiveStore(env.DB, env.EXECUTION_ARCHIVE, {
      hotRetentionDays
    }).archiveExpired;
  let archivedScopes = 0;

  // One ordered batch per bounded scope keeps scheduled work predictable. A later invocation
  // resumes the backlog without allowing one large tenant to monopolize the Worker event.
  for (const scope of scopes) {
    const archived = await archiveScope({ ...scope, now });
    if (archived !== null) archivedScopes += 1;
  }
  return { status: "completed", scannedScopes: scopes.length, archivedScopes };
}

export function scheduleMaintenanceTasks(
  env: ControlPlaneWorkerEnv,
  waitUntil: (task: Promise<unknown>) => void,
  options: {
    telemetryRunner?: (env: ControlPlaneWorkerEnv) => Promise<unknown>;
    retentionRunner?: (env: ControlPlaneWorkerEnv) => Promise<unknown>;
  } = {}
): void {
  const telemetry = Promise.resolve().then(() =>
    (options.telemetryRunner ?? runScheduledTelemetry)(env)
  );
  const retention = Promise.resolve().then(() =>
    (options.retentionRunner ?? runScheduledExecutionRetention)(env)
  );
  // Separate waitUntil registrations preserve each job's lifetime and failure signal. One rejected
  // task cannot short-circuit the other job before Cloudflare has observed its completion.
  waitUntil(telemetry);
  waitUntil(retention);
}

function parseHotRetentionDays(value: string): number {
  if (!/^[1-9]\d{0,3}$/u.test(value)) {
    throw new Error("execution retention configuration is invalid");
  }
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days > 3650) {
    throw new Error("execution retention configuration is invalid");
  }
  return days;
}

function parseRetentionScope(value: unknown): { appId: string; tenantId: string } {
  if (
    !isRecord(value) ||
    typeof value.app_id !== "string" ||
    value.app_id.trim() === "" ||
    typeof value.id !== "string" ||
    value.id.trim() === ""
  ) {
    throw new Error("execution retention scope is invalid");
  }
  return { appId: value.app_id, tenantId: value.id };
}

function parseIdentityConfiguration(
  serialized: string | undefined
): Record<string, AuthenticatedIdentity> | undefined {
  if (serialized === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed)) {
      return undefined;
    }
    const entries = Object.entries(parsed);
    if (
      entries.length === 0 ||
      entries.some(([token, identity]) => token.trim() === "" || !isRecord(identity))
    ) {
      return undefined;
    }

    // The JSON binding is a deployment bootstrap for design partners. Validation remains at
    // the HTTP trust boundary so malformed role/scope claims fail closed without being logged.
    return Object.fromEntries(entries) as Record<string, AuthenticatedIdentity>;
  } catch {
    return undefined;
  }
}

function isRateLimitReservationInput(
  value: unknown
): value is { nowMs: number; windowMs: number; limit: number } {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).length === 3 &&
    Number.isFinite(value.nowMs) &&
    Number.isSafeInteger(value.windowMs) &&
    (value.windowMs as number) >= 1000 &&
    (value.windowMs as number) <= 86_400_000 &&
    Number.isSafeInteger(value.limit) &&
    (value.limit as number) >= 1 &&
    (value.limit as number) <= 10_000
  );
}

function parseAllowedOrigins(serialized: string | undefined): readonly string[] {
  if (serialized === undefined) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    return Array.isArray(parsed) && parsed.every((origin) => typeof origin === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function parseSchemaCatalogConfiguration(serialized: string | undefined) {
  if (serialized === undefined) {
    return {};
  }
  return parsePublishedHookSchemaCatalog(JSON.parse(serialized) as unknown);
}

function parseWorkerTelemetryConfiguration(env: ControlPlaneWorkerEnv) {
  return parseTelemetryConfiguration({
    ...(env.TENANTSCRIPT_TELEMETRY_ENABLED === undefined
      ? {}
      : { enabled: env.TENANTSCRIPT_TELEMETRY_ENABLED }),
    ...(env.TENANTSCRIPT_TELEMETRY_ENDPOINT === undefined
      ? {}
      : { endpoint: env.TENANTSCRIPT_TELEMETRY_ENDPOINT }),
    ...(env.TENANTSCRIPT_PRODUCT_VERSION === undefined
      ? {}
      : { productVersion: env.TENANTSCRIPT_PRODUCT_VERSION }),
    ...(env.TENANTSCRIPT_RUNTIME_PRIMITIVE === undefined
      ? {}
      : { runtimePrimitive: env.TENANTSCRIPT_RUNTIME_PRIMITIVE })
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
