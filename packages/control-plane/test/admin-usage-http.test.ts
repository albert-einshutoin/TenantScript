import { describe, expect, it } from "vitest";
import {
  createControlPlaneHttpHandler,
  createInMemoryUsageMeter,
  createStaticTokenIdentityResolver
} from "../src/index.js";

describe("Admin usage aggregation HTTP contract", () => {
  it("derives tenant scope from identity and applies optional plugin and inclusive UTC dates", async () => {
    const usageMeter = createInMemoryUsageMeter();
    await Promise.all([
      record(usageMeter, "tenant_1", "plugin_1", "2026-07-01T00:00:00.000Z", 3),
      record(usageMeter, "tenant_1", "plugin_2", "2026-07-02T00:00:00.000Z", 5),
      record(usageMeter, "tenant_2", "plugin_1", "2026-07-01T00:00:00.000Z", 99)
    ]);
    const handler = createControlPlaneHttpHandler({
      usageMeter,
      identityResolver: createStaticTokenIdentityResolver({
        viewer: {
          subject: "viewer_1",
          role: "viewer",
          appId: "app_1",
          tenantId: "tenant_1"
        }
      })
    });

    const response = await handler(
      request(
        "https://api.example.com/v1/admin/usage?tenantId=tenant_2&pluginId=plugin_1&fromDate=2026-07-01&toDate=2026-07-02"
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        {
          tenantId: "tenant_1",
          pluginId: "plugin_1",
          date: "2026-07-01",
          executions: 1,
          cpuMs: 3,
          subrequests: 1,
          workflowRuns: 0
        }
      ]
    });
  });

  it("returns stable errors for missing service and invalid ranges without provider details", async () => {
    const identityResolver = createStaticTokenIdentityResolver({
      viewer: {
        subject: "viewer_1",
        role: "viewer",
        appId: "app_1",
        tenantId: "tenant_1"
      }
    });
    const unavailable = createControlPlaneHttpHandler({ identityResolver });
    const invalid = createControlPlaneHttpHandler({
      identityResolver,
      usageMeter: createInMemoryUsageMeter()
    });

    const unavailableResponse = await unavailable(
      request("https://api.example.com/v1/admin/usage?fromDate=2026-07-01&toDate=2026-07-02")
    );
    const invalidResponse = await invalid(
      request(
        "https://api.example.com/v1/admin/usage?fromDate=private-provider-value&toDate=2026-07-02"
      )
    );

    expect(unavailableResponse.status).toBe(503);
    await expect(unavailableResponse.json()).resolves.toEqual({
      error: { code: "usage_meter_unavailable", message: "usage service unavailable" }
    });
    expect(invalidResponse.status).toBe(400);
    const body = await invalidResponse.text();
    expect(body).toContain("invalid_usage_query");
    expect(body).not.toContain("private-provider-value");
  });
});

function request(url: string): Request {
  return new Request(url, { headers: { Authorization: "Bearer viewer" } });
}

function record(
  meter: ReturnType<typeof createInMemoryUsageMeter>,
  tenantId: string,
  pluginId: string,
  at: string,
  cpuMs: number
) {
  return meter.recordExecutionUsage({
    tenantId,
    pluginId,
    hookType: "event",
    status: "success",
    cpuMs,
    subrequests: 1,
    workflowRuns: 0,
    at: new Date(at)
  });
}
