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
});
