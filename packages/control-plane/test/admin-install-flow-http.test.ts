import { describe, expect, it, vi } from "vitest";
import {
  createControlPlaneHttpHandler,
  createStaticTokenIdentityResolver,
  type AdminInstallFlowStore
} from "../src/index.js";

const allowedOrigin = "https://admin.example.com";

describe("Control Plane Admin install flow HTTP contract", () => {
  it("allows both roles to preview safe metadata but only managers to install", async () => {
    const store = installFlowStore();
    const handler = createHandler(store);
    const preview = await handler(
      request("viewer", "/v1/admin/install-preview?versionId=version_1")
    );

    expect(preview.status).toBe(200);
    expect(store.readVersion).toHaveBeenCalledWith({ appId: "app_acme", versionId: "version_1" });
    expect(await preview.json()).toEqual(
      expect.objectContaining({ versionId: "version_1", pluginKey: "invoice-notify" })
    );

    const forbidden = await handler(
      request("viewer", "/v1/admin/installations", {
        method: "POST",
        body: validInstallBody()
      })
    );
    expect(forbidden.status).toBe(403);
    expect(store.install).not.toHaveBeenCalled();

    const installed = await handler(
      request("manager", "/v1/admin/installations", {
        method: "POST",
        body: validInstallBody()
      })
    );
    expect(installed.status).toBe(201);
    expect(store.install).toHaveBeenCalledWith({
      appId: "app_acme",
      tenantId: "tenant_acme",
      actor: "manager-subject",
      versionId: "version_1",
      config: { notifyChannel: "C123" },
      confirmedCapabilities: ["slack.send"],
      enabled: true,
      priority: 20
    });
    expect(await installed.json()).toEqual({
      id: "installation_new",
      pluginKey: "invoice-notify",
      version: "1.0.0",
      enabled: true,
      priority: 20,
      revision: 0
    });
  });

  it("uses common 404s and stable validation errors without reflecting config", async () => {
    const store = installFlowStore();
    store.readVersion.mockResolvedValueOnce(null);
    store.install
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce({ code: "invalid_config" })
      .mockRejectedValueOnce({ code: "capability_confirmation_mismatch" });
    const handler = createHandler(store);

    const missingPreview = await handler(
      request("manager", "/v1/admin/install-preview?versionId=missing")
    );
    expect(missingPreview.status).toBe(404);

    const missingInstall = await handler(
      request("manager", "/v1/admin/installations", { method: "POST", body: validInstallBody() })
    );
    expect(missingInstall.status).toBe(404);

    const invalidConfig = await handler(
      request("manager", "/v1/admin/installations", {
        method: "POST",
        body: { ...validInstallBody(), config: { notifyChannel: "customer-secret-value" } }
      })
    );
    expect(invalidConfig.status).toBe(400);
    const invalidConfigText = await invalidConfig.text();
    expect(invalidConfigText).toContain("invalid_config");
    expect(invalidConfigText).not.toContain("customer-secret-value");

    const invalidConfirmation = await handler(
      request("manager", "/v1/admin/installations", { method: "POST", body: validInstallBody() })
    );
    expect(invalidConfirmation.status).toBe(400);
    await expect(invalidConfirmation.json()).resolves.toMatchObject({
      error: { code: "capability_confirmation_mismatch" }
    });
  });

  it("rejects self-asserted scope, duplicate confirmations, unsafe numbers, extra keys, and oversized bodies", async () => {
    const store = installFlowStore();
    const handler = createHandler(store);
    const invalidBodies = [
      { ...validInstallBody(), tenantId: "tenant_other" },
      { ...validInstallBody(), actor: "attacker" },
      { ...validInstallBody(), confirmedCapabilities: ["slack.send", "slack.send"] },
      { ...validInstallBody(), priority: 1.5 },
      { ...validInstallBody(), priority: Number.MAX_SAFE_INTEGER + 1 },
      { ...validInstallBody(), config: { nested: { value: true } } },
      { ...validInstallBody(), padding: "x" }
    ];
    for (const body of invalidBodies) {
      const response = await handler(
        request("manager", "/v1/admin/installations", { method: "POST", body })
      );
      expect(response.status).toBe(400);
    }

    const oversized = await handler(
      request("manager", "/v1/admin/installations", {
        method: "POST",
        body: { ...validInstallBody(), config: { notifyChannel: "x".repeat(65_536) } }
      })
    );
    expect(oversized.status).toBe(413);
    expect(store.install).not.toHaveBeenCalled();
  });

  it("advertises route-specific CORS methods", async () => {
    const handler = createHandler(installFlowStore());
    const preview = await handler(
      new Request("https://api.example.com/v1/admin/install-preview?versionId=version_1", {
        method: "OPTIONS",
        headers: { Origin: allowedOrigin }
      })
    );
    const install = await handler(
      new Request("https://api.example.com/v1/admin/installations", {
        method: "OPTIONS",
        headers: { Origin: allowedOrigin }
      })
    );
    expect(preview.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(install.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
  });
});

function createHandler(store: ReturnType<typeof installFlowStore>) {
  return createControlPlaneHttpHandler({
    identityResolver: createStaticTokenIdentityResolver({
      manager: {
        subject: "manager-subject",
        role: "manager",
        appId: "app_acme",
        tenantId: "tenant_acme"
      },
      viewer: {
        subject: "viewer-subject",
        role: "viewer",
        appId: "app_acme",
        tenantId: "tenant_acme"
      }
    }),
    installFlowStore: store,
    allowedOrigins: [allowedOrigin]
  });
}

function installFlowStore() {
  return {
    readVersion: vi.fn<AdminInstallFlowStore["readVersion"]>().mockResolvedValue({
      versionId: "version_1",
      pluginKey: "invoice-notify",
      version: "1.0.0",
      configFields: [{ name: "notifyChannel", type: "string", required: true, hasDefault: false }],
      capabilities: [
        {
          name: "slack.send",
          scopeKeys: ["channel"],
          configReferences: ["notifyChannel"]
        }
      ],
      egress: { mode: "deny", allowlistedHostCount: 0 }
    }),
    install: vi.fn<AdminInstallFlowStore["install"]>().mockResolvedValue({
      id: "installation_new",
      pluginKey: "invoice-notify",
      version: "1.0.0",
      enabled: true,
      priority: 20,
      revision: 0
    })
  } satisfies AdminInstallFlowStore;
}

function validInstallBody(): Record<string, unknown> {
  return {
    versionId: "version_1",
    config: { notifyChannel: "C123" },
    confirmedCapabilities: ["slack.send"],
    enabled: true,
    priority: 20
  };
}

function request(
  token: string,
  path: string,
  options: { method?: string; body?: Record<string, unknown> } = {}
): Request {
  return new Request(`https://api.example.com${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: allowedOrigin,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });
}
