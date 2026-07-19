import { describe, expect, it, vi } from "vitest";
import {
  createAdminCursorCodec,
  createControlPlaneHttpHandler,
  createStaticTokenIdentityResolver,
  type AdminDashboardStore,
  type AdminExecutionDetailStore
} from "../src/index.js";

describe("Admin execution search HTTP contract", () => {
  it("derives tenant scope, applies bounded filters, and binds them to the cursor", async () => {
    const dashboardStore = dashboard();
    const handler = createHandler(dashboardStore, detailStore());
    const first = await handler(
      request(
        "/v1/admin/dashboard/executions?pluginId=plugin_1&hookName=invoice.created&status=error&limit=2"
      )
    );

    expect(first.status).toBe(200);
    expect(dashboardStore.readSection).toHaveBeenCalledWith({
      appId: "app_1",
      tenantId: "tenant_1",
      section: "executions",
      limit: 2,
      filters: { pluginId: "plugin_1", hookName: "invoice.created", status: "error" }
    });
    const body: { nextCursor: string } = await first.json();
    const replay = await handler(
      request(
        `/v1/admin/dashboard/executions?pluginId=plugin_2&hookName=invoice.created&status=error&limit=2&cursor=${encodeURIComponent(body.nextCursor)}`
      )
    );
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: { code: "invalid_cursor" } });
  });

  it("rejects invalid or oversized filters before reading storage", async () => {
    const dashboardStore = dashboard();
    const handler = createHandler(dashboardStore, detailStore());
    for (const path of [
      "/v1/admin/dashboard/executions?status=unknown",
      "/v1/admin/dashboard/executions?pluginId=",
      `/v1/admin/dashboard/executions?hookName=${"x".repeat(257)}`,
      "/v1/admin/dashboard/executions?tenantId=tenant_2"
    ]) {
      expect((await handler(request(path))).status).toBe(400);
    }
    expect(dashboardStore.readSection).not.toHaveBeenCalled();
  });

  it("returns a value-free execution detail and a common 404 outside scope", async () => {
    const details = detailStore();
    const handler = createHandler(dashboard(), details);

    const found = await handler(request("/v1/admin/execution-detail?id=exec_1"));
    expect(found.status).toBe(200);
    expect(details.readExecution).toHaveBeenCalledWith({
      appId: "app_1",
      tenantId: "tenant_1",
      id: "exec_1"
    });
    const serialized = JSON.stringify(await found.json());
    expect(serialized).toContain("execution_failed");
    expect(serialized).toContain("slack.send");
    expect(serialized).not.toContain("customer payload");
    expect(serialized).not.toContain("provider secret");

    details.readExecution.mockResolvedValueOnce(null);
    const missing = await handler(request("/v1/admin/execution-detail?id=exec_other"));
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "execution_not_found" }
    });
  });
});

function createHandler(
  dashboardStore: ReturnType<typeof dashboard>,
  executionDetailStore: ReturnType<typeof detailStore>
) {
  return createControlPlaneHttpHandler({
    identityResolver: createStaticTokenIdentityResolver({
      token: { subject: "operator", role: "viewer", appId: "app_1", tenantId: "tenant_1" }
    }),
    dashboardStore,
    executionDetailStore,
    cursorCodec: createAdminCursorCodec("execution-search-cursor-secret-32-bytes")
  });
}

function dashboard() {
  return {
    readSection: vi.fn<AdminDashboardStore["readSection"]>().mockResolvedValue({
      section: "executions",
      items: [],
      nextPosition: "2026-07-19T00:00:00.000Z\texec_1"
    }),
    readUsageSummary: vi
      .fn<AdminDashboardStore["readUsageSummary"]>()
      .mockResolvedValue({ date: "2026-07-19", executions: 0, runtimeMs: 0 })
  } satisfies AdminDashboardStore;
}

function detailStore() {
  return {
    readExecution: vi.fn<AdminExecutionDetailStore["readExecution"]>().mockResolvedValue({
      id: "exec_1",
      pluginId: "plugin_1",
      hookName: "invoice.created",
      version: "1.0.0",
      status: "error",
      durationMs: 21,
      errorCode: "execution_failed",
      capabilityCalls: [{ name: "slack.send", status: "error" }],
      createdAt: "2026-07-19T00:00:00.000Z"
    })
  } satisfies AdminExecutionDetailStore;
}

function request(path: string): Request {
  return new Request(`https://api.example.com${path}`, {
    headers: { Authorization: "Bearer token" }
  });
}
