import { createStaticTokenIdentityResolver, type AuthenticatedIdentity } from "./api.js";
import { createAdminCursorCodec, createD1AdminDashboardStore } from "./admin-dashboard.js";
import {
  createD1AdminInstallationCommandStore,
  createD1AdminInstallationDetailStore
} from "./admin-installations.js";
import { createD1AdminInstallFlowStore } from "./admin-install-flow.js";
import { createD1AdminRollbackStore } from "./admin-rollbacks.js";
import { createD1AdminExecutionDetailStore } from "./admin-executions.js";
import { createControlPlaneHttpHandler } from "./http-api.js";
import type { D1DatabaseLike } from "./storage.js";

interface ControlPlaneWorkerEnv {
  ADMIN_ALLOWED_ORIGINS?: string;
  ADMIN_CURSOR_SECRET?: string;
  ADMIN_IDENTITIES_JSON?: string;
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
    const rollbackStore = env.DB === undefined ? undefined : createD1AdminRollbackStore(env.DB);
    const executionDetailStore =
      env.DB === undefined ? undefined : createD1AdminExecutionDetailStore(env.DB);
    let handler;
    try {
      const cursorCodec =
        env.ADMIN_CURSOR_SECRET === undefined
          ? undefined
          : createAdminCursorCodec(env.ADMIN_CURSOR_SECRET);
      handler = createControlPlaneHttpHandler({
        ...(identities === undefined
          ? {}
          : { identityResolver: createStaticTokenIdentityResolver(identities) }),
        ...(dashboardStore === undefined ? {} : { dashboardStore }),
        ...(installationDetailStore === undefined ? {} : { installationDetailStore }),
        ...(installationCommandStore === undefined ? {} : { installationCommandStore }),
        ...(installFlowStore === undefined ? {} : { installFlowStore }),
        ...(rollbackStore === undefined ? {} : { rollbackStore }),
        ...(executionDetailStore === undefined ? {} : { executionDetailStore }),
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
