export type AdminMutationFamily =
  | "installation-command"
  | "installation-create"
  | "installation-request"
  | "rollback"
  | "approval-decision"
  | "service-token-issue"
  | "service-token-revoke";

export interface AdminMutationRateLimitRequest {
  appId: string;
  tenantId: string;
  actor: string;
  family: AdminMutationFamily;
}

export type AdminMutationRateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

export interface AdminMutationRateLimiter {
  reserve(request: AdminMutationRateLimitRequest): Promise<AdminMutationRateLimitResult>;
}

export interface AdminMutationRateLimitStore {
  reserve(request: {
    bucketId: string;
    nowMs: number;
    windowMs: number;
    limit: number;
  }): Promise<{ count: number; windowStartedAt: number }>;
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

export function createDurableObjectAdminMutationRateLimitStore(
  namespace: DurableObjectNamespaceLike
): AdminMutationRateLimitStore {
  return {
    async reserve(request) {
      const stub = namespace.get(namespace.idFromName(request.bucketId));
      const response = await stub.fetch("https://rate-limit.internal/reserve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nowMs: request.nowMs,
          windowMs: request.windowMs,
          limit: request.limit
        })
      });
      if (!response.ok) throw new Error("Admin mutation rate limit store unavailable");
      const result: unknown = await response.json();
      if (!isReservationResponse(result)) {
        throw new Error("Admin mutation rate limit store returned an invalid response");
      }
      return result;
    }
  };
}

interface FixedWindowRecord {
  windowStartedAt: number;
  count: number;
}

export function evaluateFixedWindowReservation(input: {
  current: FixedWindowRecord | undefined;
  nowMs: number;
  windowMs: number;
  limit: number;
}): { record: FixedWindowRecord; count: number } {
  const current = input.current;
  if (
    current === undefined ||
    current.windowStartedAt > input.nowMs ||
    input.nowMs >= current.windowStartedAt + input.windowMs
  ) {
    return { record: { windowStartedAt: input.nowMs, count: 1 }, count: 1 };
  }
  if (current.count >= input.limit) {
    // Keep persisted state bounded while returning a synthetic over-limit count to the caller.
    return { record: current, count: input.limit + 1 };
  }
  const count = current.count + 1;
  return { record: { ...current, count }, count };
}

export function createAdminMutationRateLimiter(options: {
  store: AdminMutationRateLimitStore;
  limit: number;
  windowSeconds: number;
  now?: () => Date;
}): AdminMutationRateLimiter {
  assertSafeConfiguration(options.limit, options.windowSeconds);
  const windowMs = options.windowSeconds * 1000;
  const now = options.now ?? (() => new Date());

  return {
    async reserve(request) {
      const nowMs = now().getTime();
      if (!Number.isFinite(nowMs)) throw new Error("Admin mutation rate limit clock unavailable");
      const bucketId = await rateLimitBucketId(request);
      const reservation = await options.store.reserve({
        bucketId,
        nowMs,
        windowMs,
        limit: options.limit
      });
      const { count, windowStartedAt } = reservation;
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error("Admin mutation rate limit store returned an invalid count");
      }
      if (!Number.isFinite(windowStartedAt) || windowStartedAt > nowMs) {
        throw new Error("Admin mutation rate limit store returned an invalid window");
      }
      if (count <= options.limit) {
        return { allowed: true, remaining: options.limit - count };
      }
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((windowStartedAt + windowMs - nowMs) / 1000))
      };
    }
  };
}

export function parseAdminMutationRateLimitConfiguration(input: {
  limit?: string;
  windowSeconds?: string;
}): { limit: number; windowSeconds: number } {
  const limit = parseBoundedInteger(input.limit, 20);
  const windowSeconds = parseBoundedInteger(input.windowSeconds, 60);
  assertSafeConfiguration(limit, windowSeconds);
  return { limit, windowSeconds };
}

function assertSafeConfiguration(limit: number, windowSeconds: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 10_000 ||
    !Number.isSafeInteger(windowSeconds) ||
    windowSeconds < 1 ||
    windowSeconds > 86_400
  ) {
    throw new Error("Invalid admin mutation rate limit configuration");
  }
}

function parseBoundedInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error("Invalid admin mutation rate limit configuration");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Invalid admin mutation rate limit configuration");
  }
  return parsed;
}

async function rateLimitBucketId(request: AdminMutationRateLimitRequest): Promise<string> {
  // Only the digest crosses the Durable Object namespace boundary. This prevents tenant IDs,
  // actor identifiers, and any accidentally supplied credential-shaped values from becoming
  // object names, logs, or storage keys.
  const encoded = new TextEncoder().encode(
    JSON.stringify([request.appId, request.tenantId, request.actor, request.family])
  );
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isReservationResponse(
  value: unknown
): value is { count: number; windowStartedAt: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Number.isSafeInteger((value as { count?: unknown }).count) &&
    typeof (value as { windowStartedAt?: unknown }).windowStartedAt === "number" &&
    Number.isFinite((value as { windowStartedAt: number }).windowStartedAt)
  );
}
