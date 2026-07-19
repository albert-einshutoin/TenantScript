import { describe, expect, it, vi } from "vitest";
import type { AdminMutationRateLimiter } from "../src/admin-mutation-rate-limit.js";
import { createStaticTokenIdentityResolver } from "../src/api.js";
import { createControlPlaneHttpHandler } from "../src/http-api.js";

const identityResolver = createStaticTokenIdentityResolver({
  manager: {
    subject: "ops-manager",
    role: "manager",
    appId: "app_acme",
    tenantId: "tenant_acme"
  }
});

describe("Admin mutation HTTP rate limit", () => {
  it("returns 429 with retry metadata and performs no mutation after quota is exhausted", async () => {
    const updateInstallation = vi.fn().mockResolvedValue({
      id: "inst_1",
      enabled: false,
      priority: 10,
      revision: 1
    });
    const reserve = vi
      .fn<AdminMutationRateLimiter["reserve"]>()
      .mockResolvedValueOnce({ allowed: true, remaining: 0 })
      .mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 17 });
    const handler = createControlPlaneHttpHandler({
      identityResolver,
      installationCommandStore: { updateInstallation },
      adminMutationRateLimiter: { reserve }
    });

    expect((await handler(commandRequest())).status).toBe(200);
    const limited = await handler(commandRequest());

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("17");
    expect(limited.headers.get("cache-control")).toBe("no-store");
    await expect(limited.json()).resolves.toEqual({
      error: { code: "admin_mutation_rate_limited", message: "too many admin changes" }
    });
    expect(updateInstallation).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith({
      appId: "app_acme",
      tenantId: "tenant_acme",
      actor: "ops-manager",
      family: "installation-command"
    });
  });

  it("fails closed before mutation when the limiter is missing or unavailable", async () => {
    const updateInstallation = vi.fn();
    const missing = createControlPlaneHttpHandler({
      identityResolver,
      installationCommandStore: { updateInstallation }
    });
    const unavailable = createControlPlaneHttpHandler({
      identityResolver,
      installationCommandStore: { updateInstallation },
      adminMutationRateLimiter: {
        reserve: vi.fn().mockRejectedValue(new Error("secret durable object failure"))
      }
    });

    for (const handler of [missing, unavailable]) {
      const response = await handler(commandRequest());
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("admin_mutation_rate_limit_unavailable");
    }
    expect(updateInstallation).not.toHaveBeenCalled();
  });
});

function commandRequest(): Request {
  return new Request("https://api.example.com/v1/admin/installation-command", {
    method: "PATCH",
    headers: {
      Authorization: "Bearer manager",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ id: "inst_1", expectedRevision: 0, enabled: false })
  });
}
