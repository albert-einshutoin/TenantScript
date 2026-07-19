import { describe, expect, it, vi } from "vitest";
import {
  createAdminMutationRateLimiter,
  createDurableObjectAdminMutationRateLimitStore,
  evaluateFixedWindowReservation,
  parseAdminMutationRateLimitConfiguration,
  type AdminMutationRateLimitStore
} from "../src/admin-mutation-rate-limit.js";

describe("admin mutation rate limit", () => {
  it("sends only the hashed bucket and numeric policy to the Durable Object", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ count: 1, windowStartedAt: Date.parse("2026-07-20T00:00:00.000Z") })
      );
    const idFromName = vi.fn().mockReturnValue("durable-id");
    const store = createDurableObjectAdminMutationRateLimitStore({
      idFromName,
      get: vi.fn().mockReturnValue({ fetch })
    });

    await expect(
      store.reserve({ bucketId: "a".repeat(64), nowMs: 1000, windowMs: 60_000, limit: 20 })
    ).resolves.toEqual({ count: 1, windowStartedAt: Date.parse("2026-07-20T00:00:00.000Z") });
    expect(idFromName).toHaveBeenCalledWith("a".repeat(64));
    expect(fetch).toHaveBeenCalledWith(
      "https://rate-limit.internal/reserve",
      expect.objectContaining({
        method: "POST",
        body: '{"nowMs":1000,"windowMs":60000,"limit":20}'
      })
    );
  });

  it.each([
    [new Response(null, { status: 503 }), "store unavailable"],
    [Response.json(null), "invalid response"],
    [Response.json({ count: 1, windowStartedAt: "now" }), "invalid response"]
  ])("rejects unavailable or malformed Durable Object responses %#", async (response, error) => {
    const store = createDurableObjectAdminMutationRateLimitStore({
      idFromName: () => "durable-id",
      get: () => ({ fetch: vi.fn().mockResolvedValue(response) })
    });

    await expect(
      store.reserve({ bucketId: "a".repeat(64), nowMs: 1000, windowMs: 60_000, limit: 20 })
    ).rejects.toThrow(error);
  });

  it("allows the configured maximum, then returns a deterministic retry delay", async () => {
    let now = new Date("2026-07-20T00:00:00.000Z");
    const store = inMemoryStore();
    const limiter = createAdminMutationRateLimiter({
      store,
      limit: 2,
      windowSeconds: 60,
      now: () => now
    });
    const request = scope();

    await expect(limiter.reserve(request)).resolves.toMatchObject({ allowed: true, remaining: 1 });
    await expect(limiter.reserve(request)).resolves.toMatchObject({ allowed: true, remaining: 0 });
    await expect(limiter.reserve(request)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 60
    });

    now = new Date("2026-07-20T00:01:00.000Z");
    await expect(limiter.reserve(request)).resolves.toMatchObject({ allowed: true, remaining: 1 });
  });

  it("isolates tenants, actors, and command families without exposing raw scope values", async () => {
    const reserve = vi
      .fn<AdminMutationRateLimitStore["reserve"]>()
      .mockResolvedValue({ count: 1, windowStartedAt: Date.parse("2026-07-20T00:00:00.000Z") });
    const limiter = createAdminMutationRateLimiter({
      store: { reserve },
      limit: 1,
      windowSeconds: 60,
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    for (const request of [
      scope(),
      scope({ tenantId: "tenant_other" }),
      scope({ actor: "other-operator" }),
      scope({ family: "approval-decision" })
    ]) {
      await limiter.reserve(request);
    }

    const bucketIds = reserve.mock.calls.map(([request]) => request.bucketId);
    expect(new Set(bucketIds)).toHaveLength(4);
    expect(bucketIds.join(" ")).not.toContain("tenant_acme");
    expect(bucketIds.join(" ")).not.toContain("operator@example.com");
    expect(bucketIds.every((id) => /^[a-f0-9]{64}$/u.test(id))).toBe(true);
  });

  it.each([
    { limit: 0, windowSeconds: 60 },
    { limit: -1, windowSeconds: 60 },
    { limit: 1.5, windowSeconds: 60 },
    { limit: 1, windowSeconds: 0 },
    { limit: 1, windowSeconds: 86_401 }
  ])("rejects unsafe configuration %#", (configuration) => {
    expect(() =>
      createAdminMutationRateLimiter({ store: inMemoryStore(), ...configuration })
    ).toThrow("Invalid admin mutation rate limit configuration");
  });

  it("uses safe defaults and rejects malformed or excessive deployment bindings", () => {
    expect(parseAdminMutationRateLimitConfiguration({})).toEqual({
      limit: 20,
      windowSeconds: 60
    });
    for (const value of ["0", "-1", "1.5", "1e2", " 10", "10001", "9007199254740992"]) {
      expect(() => parseAdminMutationRateLimitConfiguration({ limit: value })).toThrow(
        "Invalid admin mutation rate limit configuration"
      );
    }
    expect(() => parseAdminMutationRateLimitConfiguration({ windowSeconds: "86401" })).toThrow(
      "Invalid admin mutation rate limit configuration"
    );
  });

  it("never exceeds the limit under concurrent reservations", async () => {
    const store = inMemoryStore();
    const limiter = createAdminMutationRateLimiter({
      store,
      limit: 3,
      windowSeconds: 60,
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    const results = await Promise.all(Array.from({ length: 20 }, () => limiter.reserve(scope())));

    expect(results.filter((result) => result.allowed)).toHaveLength(3);
  });

  it.each([
    [{ count: 0, windowStartedAt: 0 }, "invalid count"],
    [{ count: 1.5, windowStartedAt: 0 }, "invalid count"],
    [{ count: 1, windowStartedAt: Number.NaN }, "invalid window"],
    [{ count: 1, windowStartedAt: 2_000 }, "invalid window"]
  ])("fails closed for malformed store state %#", async (reservation, error) => {
    const limiter = createAdminMutationRateLimiter({
      store: { reserve: () => Promise.resolve(reservation) },
      limit: 2,
      windowSeconds: 60,
      now: () => new Date(1_000)
    });
    await expect(limiter.reserve(scope())).rejects.toThrow(error);
  });

  it("fails closed when the clock is invalid", async () => {
    const limiter = createAdminMutationRateLimiter({
      store: inMemoryStore(),
      limit: 2,
      windowSeconds: 60,
      now: () => new Date(Number.NaN)
    });
    await expect(limiter.reserve(scope())).rejects.toThrow("clock unavailable");
  });
});

function scope(
  overrides: Partial<{
    appId: string;
    tenantId: string;
    actor: string;
    family: "installation-command" | "installation-create" | "rollback" | "approval-decision";
  }> = {}
) {
  return {
    appId: "app_acme",
    tenantId: "tenant_acme",
    actor: "operator@example.com",
    family: "installation-command" as const,
    ...overrides
  };
}

function inMemoryStore(): AdminMutationRateLimitStore {
  const records = new Map<string, { windowStartedAt: number; count: number }>();
  return {
    reserve: (request) => {
      const current = records.get(request.bucketId);
      const evaluated = evaluateFixedWindowReservation({
        current,
        nowMs: request.nowMs,
        windowMs: request.windowMs,
        limit: request.limit
      });
      records.set(request.bucketId, evaluated.record);
      return Promise.resolve({
        count: evaluated.count,
        windowStartedAt: evaluated.record.windowStartedAt
      });
    }
  };
}
