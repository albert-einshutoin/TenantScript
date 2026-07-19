import { env, exports } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1ControlPlaneStore } from "../src/index.js";

const worker = exports as unknown as {
  default: { fetch: (request: Request) => Promise<Response> };
};

const testEnv = env as unknown as {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  const store = createD1ControlPlaneStore(testEnv.DB);
  await store.createApp({ id: "app_worker", name: "Worker App" });
  await store.createTenant({ id: "tenant_worker", appId: "app_worker", name: "Worker Tenant" });
});

describe("Worker service token lifecycle", () => {
  it("issues a one-time credential, authenticates it, and rejects it immediately after revoke", async () => {
    const issue = await worker.default.fetch(
      jsonRequest("POST", "https://control.example/v1/admin/service-tokens", {
        label: "worker read bot",
        role: "viewer",
        scopes: ["session:read"],
        expiresAt: "2026-08-20T00:00:00.000Z"
      })
    );
    expect(issue.status).toBe(201);
    const issued: { id: string; token: string } = await issue.json();
    expect(issued.token).toMatch(/^ts_service_[a-f0-9]{64}$/u);

    const persisted = await testEnv.DB.prepare("SELECT * FROM service_tokens WHERE id = ?")
      .bind(issued.id)
      .first();
    expect(persisted).not.toBeNull();
    expect(JSON.stringify(persisted)).not.toContain(issued.token);
    expect(JSON.stringify(persisted)).not.toContain(issued.token.slice("ts_service_".length));

    const session = await worker.default.fetch(authenticatedRequest("/v1/session", issued.token));
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      subject: `service-token:${issued.id}`,
      role: "viewer",
      appId: "app_worker",
      tenantId: "tenant_worker"
    });

    const revoke = await worker.default.fetch(
      new Request(`https://control.example/v1/admin/service-tokens?id=${issued.id}`, {
        method: "DELETE",
        headers: adminHeaders()
      })
    );
    expect(revoke.status).toBe(204);

    const rejected = await worker.default.fetch(authenticatedRequest("/v1/session", issued.token));
    expect(rejected.status).toBe(401);
  });

  it("enforces the app and tenant relationship in the migration", async () => {
    await testEnv.DB.prepare("INSERT INTO apps (id, name) VALUES (?, ?)")
      .bind("app_other", "Other App")
      .run();

    await expect(
      testEnv.DB.prepare(
        `INSERT INTO service_tokens
          (id, token_hash, label, role, app_id, tenant_id, scopes_json,
           created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          "st_cross_scope",
          "a".repeat(64),
          "cross scope",
          "viewer",
          "app_other",
          "tenant_worker",
          '["session:read"]',
          "attacker",
          "2026-07-20T00:00:00.000Z",
          "2026-07-21T00:00:00.000Z"
        )
        .run()
    ).rejects.toThrow();
  });
});

function jsonRequest(method: string, url: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { ...adminHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function authenticatedRequest(path: string, token: string): Request {
  return new Request(`https://control.example${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "https://admin.example.com"
    }
  });
}

function adminHeaders(): Record<string, string> {
  return {
    Authorization: "Bearer worker-manager-token",
    Origin: "https://admin.example.com"
  };
}
