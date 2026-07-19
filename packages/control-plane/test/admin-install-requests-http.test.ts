import { describe, expect, it, vi } from "vitest";
import {
  createControlPlaneHttpHandler,
  createStaticTokenIdentityResolver,
  type AdminInstallRequestStore
} from "../src/index.js";

describe("Admin installation grant request HTTP contract", () => {
  it("lets operators request reviewed grants without performing a direct install", async () => {
    const requests = requestStore();
    const handler = createHandler(requests);

    const response = await handler(request("operator", "/v1/admin/installation-requests"));

    expect(response.status).toBe(201);
    expect(requests.requestInstallation).toHaveBeenCalledWith({
      appId: "app_1",
      tenantId: "tenant_1",
      actor: "operator-subject",
      idempotencyKey: "install-request-key-0001",
      versionId: "version_1",
      config: { notifyChannel: "C123" },
      confirmedCapabilities: ["slack.send"],
      enabled: false,
      priority: 20
    });
    await expect(response.json()).resolves.toEqual({
      approvalId: "approval_install_1",
      state: "pending",
      pluginKey: "invoice-notify",
      version: "1.0.0",
      capabilities: ["slack.send"],
      expiresAt: "2026-07-21T00:00:00.000Z"
    });
  });

  it("denies viewers and keeps operator requests separate from direct installation", async () => {
    const requests = requestStore();
    const handler = createHandler(requests);

    expect((await handler(request("viewer", "/v1/admin/installation-requests"))).status).toBe(403);
    expect((await handler(request("operator", "/v1/admin/installations"))).status).toBe(403);
    expect(requests.requestInstallation).toHaveBeenCalledTimes(0);
  });
});

function createHandler(store: ReturnType<typeof requestStore>) {
  return createControlPlaneHttpHandler({
    identityResolver: createStaticTokenIdentityResolver({
      operator: {
        subject: "operator-subject",
        role: "operator",
        appId: "app_1",
        tenantId: "tenant_1"
      },
      viewer: {
        subject: "viewer-subject",
        role: "viewer",
        appId: "app_1",
        tenantId: "tenant_1"
      }
    }),
    installFlowStore: {
      readVersion: () => Promise.resolve(null),
      install: () => Promise.resolve(null)
    },
    installRequestStore: store,
    adminMutationRateLimiter: {
      reserve: () => Promise.resolve({ allowed: true, remaining: 10 })
    }
  });
}

function request(token: string, path: string): Request {
  return new Request(`https://control.example${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "install-request-key-0001"
    },
    body: JSON.stringify({
      versionId: "version_1",
      config: { notifyChannel: "C123" },
      confirmedCapabilities: ["slack.send"],
      enabled: false,
      priority: 20
    })
  });
}

function requestStore() {
  return {
    requestInstallation: vi
      .fn<AdminInstallRequestStore["requestInstallation"]>()
      .mockResolvedValue({
        approvalId: "approval_install_1",
        state: "pending",
        pluginKey: "invoice-notify",
        version: "1.0.0",
        capabilities: ["slack.send"],
        expiresAt: "2026-07-21T00:00:00.000Z"
      })
  } satisfies AdminInstallRequestStore;
}
