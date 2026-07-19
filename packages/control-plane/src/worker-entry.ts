import { createStaticTokenIdentityResolver, type AuthenticatedIdentity } from "./api.js";
import { createControlPlaneHttpHandler } from "./http-api.js";

interface ControlPlaneWorkerEnv {
  ADMIN_ALLOWED_ORIGINS?: string;
  ADMIN_IDENTITIES_JSON?: string;
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
    const handler = createControlPlaneHttpHandler({
      ...(identities === undefined
        ? {}
        : { identityResolver: createStaticTokenIdentityResolver(identities) }),
      allowedOrigins
    });
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
