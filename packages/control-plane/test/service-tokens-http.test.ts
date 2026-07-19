import { describe, expect, it } from "vitest";
import { createStaticTokenIdentityResolver } from "../src/api.js";
import { createControlPlaneHttpHandler } from "../src/http-api.js";
import {
  createServiceTokenAwareIdentityResolver,
  createServiceTokenIdentityResolver,
  createServiceTokenManager,
  type ServiceTokenRecord,
  type ServiceTokenStore
} from "../src/service-tokens.js";

describe("service token Admin API", () => {
  it("issues a scoped token once, applies its scope, and revokes it immediately", async () => {
    const store = memoryStore();
    const serviceTokenManager = createServiceTokenManager({
      store,
      now: () => new Date("2026-07-20T00:00:00.000Z"),
      generateId: () => "st_01",
      generateSecret: () => "secret-value-with-sufficient-entropy"
    });
    const identityResolver = createServiceTokenAwareIdentityResolver({
      serviceTokens: createServiceTokenIdentityResolver(store, {
        now: () => new Date("2026-07-20T00:00:00.000Z")
      }),
      bootstrap: createStaticTokenIdentityResolver({
        "owner-token": {
          subject: "owner_1",
          role: "owner",
          appId: "app_1",
          tenantId: "tenant_1"
        }
      })
    });
    const handler = createControlPlaneHttpHandler({
      identityResolver,
      serviceTokenManager,
      adminMutationRateLimiter: allowMutations()
    });

    const issueResponse = await handler(
      jsonRequest("POST", "https://control.example/v1/admin/service-tokens", "owner-token", {
        label: "read bot",
        role: "admin",
        scopes: ["session:read"],
        expiresAt: "2026-07-21T00:00:00.000Z"
      })
    );
    expect(issueResponse.status).toBe(201);
    const issued: { id: string; token: string } = await issueResponse.json();
    expect(issued).toMatchObject({
      id: "st_01",
      token: "ts_service_secret-value-with-sufficient-entropy"
    });
    expect(JSON.stringify(store.records)).not.toContain(issued.token);

    const session = await handler(
      new Request("https://control.example/v1/session", {
        headers: { Authorization: `Bearer ${issued.token}` }
      })
    );
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({ subject: "service-token:st_01" });

    const scopeDenied = await handler(
      jsonRequest("POST", "https://control.example/v1/admin/service-tokens", issued.token, {
        label: "nested bot",
        role: "viewer",
        scopes: ["session:read"],
        expiresAt: "2026-07-21T00:00:00.000Z"
      })
    );
    expect(scopeDenied.status).toBe(403);
    await expect(scopeDenied.json()).resolves.toMatchObject({
      error: { code: "service_token_issue_forbidden" }
    });

    const revokeResponse = await handler(
      new Request("https://control.example/v1/admin/service-tokens?id=st_01", {
        method: "DELETE",
        headers: { Authorization: "Bearer owner-token" }
      })
    );
    expect(revokeResponse.status).toBe(204);

    const revokedSession = await handler(
      new Request("https://control.example/v1/session", {
        headers: { Authorization: `Bearer ${issued.token}` }
      })
    );
    expect(revokedSession.status).toBe(401);
  });

  it("rejects escalation and conceals cross-tenant revocation", async () => {
    const store = memoryStore();
    const handler = createControlPlaneHttpHandler({
      identityResolver: createStaticTokenIdentityResolver({
        "admin-token": {
          subject: "admin_1",
          role: "admin",
          appId: "app_1",
          tenantId: "tenant_1"
        }
      }),
      serviceTokenManager: createServiceTokenManager({ store }),
      adminMutationRateLimiter: allowMutations()
    });

    const escalation = await handler(
      jsonRequest("POST", "https://control.example/v1/admin/service-tokens", "admin-token", {
        label: "owner bot",
        role: "owner",
        scopes: ["session:read"],
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      })
    );
    expect(escalation.status).toBe(403);
    await expect(escalation.json()).resolves.toMatchObject({
      error: { code: "service_token_role_escalation" }
    });

    const missing = await handler(
      new Request("https://control.example/v1/admin/service-tokens?id=st_other", {
        method: "DELETE",
        headers: { Authorization: "Bearer admin-token" }
      })
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "service_token_not_found" }
    });
  });
});

function jsonRequest(method: string, url: string, token: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function allowMutations() {
  return { reserve: () => Promise.resolve({ allowed: true as const, remaining: 99 }) };
}

function memoryStore(): ServiceTokenStore & { records: ServiceTokenRecord[] } {
  const records: ServiceTokenRecord[] = [];
  return {
    records,
    create: (record) => {
      records.push(structuredClone(record));
      return Promise.resolve();
    },
    findByTokenHash: (hash) =>
      Promise.resolve(records.find((record) => record.tokenHash === hash) ?? null),
    revoke: ({ id, appId, tenantId, revokedAt, revokedBy }) => {
      const record = records.find(
        (candidate) =>
          candidate.id === id && candidate.appId === appId && candidate.tenantId === tenantId
      );
      if (record === undefined) return Promise.resolve(false);
      record.revokedAt ??= revokedAt;
      record.revokedBy ??= revokedBy;
      return Promise.resolve(true);
    }
  };
}
