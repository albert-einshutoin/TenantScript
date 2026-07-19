import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const worker = exports as unknown as {
  default: { fetch: (request: Request) => Promise<Response> };
};

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
});
