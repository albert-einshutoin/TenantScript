import { createStaticTokenIdentityResolver, type AuthenticatedIdentity } from "./api.js";
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
import { createControlPlaneHttpHandler } from "./http-api.js";
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
  ADMIN_MUTATION_RATE_LIMIT?: string;
  ADMIN_MUTATION_RATE_WINDOW_SECONDS?: string;
  ADMIN_MUTATION_RATE_LIMITER_DO?: DurableObjectNamespace;
  DB?: D1DatabaseLike;
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
  fetch(request: Request, env: ControlPlaneWorkerEnv) {
    const identities = parseIdentityConfiguration(env.ADMIN_IDENTITIES_JSON);
    const allowedOrigins = parseAllowedOrigins(env.ADMIN_ALLOWED_ORIGINS);
    const dashboardStore = env.DB === undefined ? undefined : createD1AdminDashboardStore(env.DB);
    const installationDetailStore =
      env.DB === undefined ? undefined : createD1AdminInstallationDetailStore(env.DB);
    const installationCommandStore =
      env.DB === undefined ? undefined : createD1AdminInstallationCommandStore(env.DB);
    const installFlowStore =
      env.DB === undefined ? undefined : createD1AdminInstallFlowStore(env.DB);
    const installRequestStore =
      env.DB === undefined ? undefined : createD1AdminInstallRequestStore(env.DB);
    const rollbackStore = env.DB === undefined ? undefined : createD1AdminRollbackStore(env.DB);
    const executionDetailStore =
      env.DB === undefined ? undefined : createD1AdminExecutionDetailStore(env.DB);
    const approvalDecisionStore =
      env.DB === undefined ? undefined : createD1AdminApprovalDecisionStore(env.DB);
    const serviceTokenStore = env.DB === undefined ? undefined : createD1ServiceTokenStore(env.DB);
    let handler;
    try {
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
        allowedOrigins
      });
    } catch {
      // Binding errors can contain deployment values. Return a stable response without
      // reflecting invalid origin or secret configuration into the public Worker response.
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
    return handler(request);
  }
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
