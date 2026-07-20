import {
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
import type { D1DatabaseLike } from "./storage.js";

interface ControlPlaneWorkerEnv {
  ADMIN_ALLOWED_ORIGINS?: string;
  ADMIN_CURSOR_SECRET?: string;
  ADMIN_IDENTITIES_JSON?: string;
  ADMIN_HOOK_SCHEMA_CATALOG_JSON?: string;
  ADMIN_MUTATION_RATE_LIMIT?: string;
  ADMIN_MUTATION_RATE_WINDOW_SECONDS?: string;
  ADMIN_MUTATION_RATE_LIMITER_DO?: DurableObjectNamespace;
  APP_DATABASE_ROUTES_JSON?: string;
  TENANTSCRIPT_TELEMETRY_ENABLED?: string;
  TENANTSCRIPT_TELEMETRY_ENDPOINT?: string;
  TENANTSCRIPT_PRODUCT_VERSION?: string;
  TENANTSCRIPT_RUNTIME_PRIMITIVE?: string;
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
      const result = await this.state.storage.transaction(async (transaction) => {
        const current = await transaction.get<{ windowStartedAt: number; count: number }>("window");
        const evaluated = evaluateFixedWindowReservation({ current, ...input });
        await transaction.put("window", evaluated.record);
        return {
          count: evaluated.count,
          windowStartedAt: evaluated.record.windowStartedAt
        };
      });
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
    try {
      if (env.APP_DATABASE_ROUTES_JSON !== undefined) {
        const router = createAppDatabaseRouterFromBindings({
          serializedRoutes: env.APP_DATABASE_ROUTES_JSON,
          bindings: env
        });
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
      return configurationUnavailableResponse();
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
      handler = createControlPlaneHttpHandler({
        ...(identityResolver === undefined ? {} : { identityResolver }),
        ...(dashboardStore === undefined ? {} : { dashboardStore }),
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
        ...(cursorCodec === undefined ? {} : { cursorCodec }),
        telemetryStatus: publicTelemetryStatus(telemetryConfiguration),
        allowedOrigins
      });
    } catch {
      // Binding errors can contain deployment values. Return a stable response without
      // reflecting invalid origin or secret configuration into the public Worker response.
      return configurationUnavailableResponse();
    }
    return handler(request);
  },

  scheduled(
    _controller: ScheduledController,
    env: ControlPlaneWorkerEnv,
    context: ExecutionContext
  ): void {
    context.waitUntil(runScheduledTelemetry(env));
  }
};

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
