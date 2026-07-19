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
});

describe("Control Plane Worker Admin HTTP transport", () => {
  it("routes the deployed worker fetch entrypoint to the tenant-scoped session handler", async () => {
    const response = await worker.default.fetch(
      new Request("https://control-plane.example.com/v1/session", {
        headers: {
          Authorization: "Bearer worker-manager-token",
          Origin: "https://admin.example.com"
        }
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      subject: "worker-manager",
      role: "manager",
      appId: "app_worker",
      tenantId: "tenant_worker"
    });
  });

  it("fails closed instead of serving the old probe response", async () => {
    const response = await worker.default.fetch(
      new Request("https://control-plane.example.com/v1/session", {
        headers: { Origin: "https://admin.example.com" }
      })
    );

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("test worker");
  });

  it("serves the real D1 dashboard through the Worker entrypoint", async () => {
    const store = createD1ControlPlaneStore(testEnv.DB);
    await store.createApp({ id: "app_worker", name: "Worker App" });
    await store.createTenant({ id: "tenant_worker", appId: "app_worker", name: "Worker Tenant" });

    const response = await worker.default.fetch(
      new Request("https://control-plane.example.com/v1/admin/dashboard?limit=1", {
        headers: {
          Authorization: "Bearer worker-manager-token",
          Origin: "https://admin.example.com"
        }
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      installations: { items: [] },
      pluginVersions: { items: [] },
      approvals: { items: [] },
      executions: { items: [] },
      usage: { executions: 0, runtimeMs: 0 }
    });
  });

  it("decides an approval through the deployed Worker and writes audit evidence", async () => {
    const store = createD1ControlPlaneStore(testEnv.DB);
    await store.createApp({ id: "app_worker", name: "Worker App" });
    await store.createTenant({ id: "tenant_worker", appId: "app_worker", name: "Worker Tenant" });
    await store.createPlugin({ id: "plugin_worker", appId: "app_worker", key: "worker-plugin" });
    await store.createApproval({
      id: "approval_worker",
      tenantId: "tenant_worker",
      pluginId: "plugin_worker",
      role: "manager",
      subject: { customerSecret: "not-for-audit" },
      resumeHook: "approval.decided",
      state: "pending",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      createdAt: new Date("2026-07-19T00:00:00.000Z")
    });

    const response = await worker.default.fetch(
      new Request("https://control-plane.example.com/v1/admin/approval-decisions", {
        method: "POST",
        headers: {
          Authorization: "Bearer worker-manager-token",
          Origin: "https://admin.example.com",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ approvalId: "approval_worker", decision: "rejected" })
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      approvalId: "approval_worker",
      state: "rejected"
    });
    await expect(
      testEnv.DB.prepare("SELECT COUNT(*) AS count FROM approval_audit_events").first()
    ).resolves.toEqual({ count: 1 });
  });

  it("routes operator installation requests to the D1 approval workflow", async () => {
    const store = createD1ControlPlaneStore(testEnv.DB);
    await store.createApp({ id: "app_worker", name: "Worker App" });
    await store.createTenant({ id: "tenant_worker", appId: "app_worker", name: "Worker Tenant" });
    await store.createPlugin({ id: "plugin_worker", appId: "app_worker", key: "worker-plugin" });
    await store.createPluginVersion({
      id: "version_worker",
      pluginId: "plugin_worker",
      version: "1.0.0",
      artifactHash: "hash_worker",
      manifest: {
        name: "worker-plugin",
        version: "1.0.0",
        hooks: [{ name: "invoice.created", type: "event", timeoutMs: 250 }],
        capabilities: { "slack.send": { channel: "$config.channel" } },
        configSchema: {
          properties: { channel: { type: "string" } },
          required: ["channel"]
        },
        egress: { mode: "deny" },
        limits: { cpuMs: 50, timeoutMs: 500 }
      }
    });

    const response = await worker.default.fetch(
      new Request("https://control-plane.example.com/v1/admin/installation-requests", {
        method: "POST",
        headers: {
          Authorization: "Bearer worker-operator-token",
          Origin: "https://admin.example.com",
          "Content-Type": "application/json",
          "Idempotency-Key": "worker-install-request-key-0001"
        },
        body: JSON.stringify({
          versionId: "version_worker",
          config: { channel: "C123" },
          confirmedCapabilities: ["slack.send"],
          enabled: true,
          priority: 10
        })
      })
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      state: "pending",
      pluginKey: "worker-plugin",
      capabilities: ["slack.send"]
    });
    await expect(
      testEnv.DB.prepare("SELECT COUNT(*) AS count FROM installations").first()
    ).resolves.toEqual({ count: 0 });
  });

  it("atomically limits concurrent tenant-scoped mutations without extra audit writes", async () => {
    const store = createD1ControlPlaneStore(testEnv.DB);
    await store.createApp({ id: "app_worker", name: "Worker App" });
    await store.createTenant({ id: "tenant_worker", appId: "app_worker", name: "Worker Tenant" });
    await store.createPlugin({ id: "plugin_worker", appId: "app_worker", key: "worker-plugin" });
    for (let index = 0; index < 10; index += 1) {
      await store.createApproval({
        id: `approval_rate_${String(index)}`,
        tenantId: "tenant_worker",
        pluginId: "plugin_worker",
        role: "manager",
        subject: {},
        resumeHook: "approval.decided",
        state: "pending",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-07-20T00:00:00.000Z")
      });
    }

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        worker.default.fetch(
          new Request("https://control-plane.example.com/v1/admin/approval-decisions", {
            method: "POST",
            headers: {
              Authorization: "Bearer worker-manager-token",
              Origin: "https://admin.example.com",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              approvalId: `approval_rate_${String(index)}`,
              decision: "rejected"
            })
          })
        )
      )
    );

    expect(responses.filter((response) => response.status === 200)).toHaveLength(2);
    const limited = responses.filter((response) => response.status === 429);
    expect(limited).toHaveLength(8);
    expect(limited.every((response) => response.headers.has("Retry-After"))).toBe(true);
    await expect(
      testEnv.DB.prepare("SELECT COUNT(*) AS count FROM approval_audit_events").first()
    ).resolves.toEqual({ count: 2 });
  });
});
