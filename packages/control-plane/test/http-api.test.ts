import { describe, expect, it, vi } from "vitest";
import { createAdminCursorCodec, type AdminDashboardStore } from "../src/admin-dashboard.js";
import type { AdminInstallationDetailStore } from "../src/admin-installations.js";
import { createControlPlaneHttpHandler } from "../src/http-api.js";
import { createStaticTokenIdentityResolver } from "../src/index.js";

const allowedOrigin = "https://admin.example.com";

describe("Control Plane HTTP session contract", () => {
  it("returns a tenant-scoped session without echoing the bearer token", async () => {
    const handler = createHandler();
    const response = await handler(
      sessionRequest({
        token: "manager-secret-token",
        url: "https://api.example.com/v1/session?tenantId=tenant_other&appId=app_other"
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
    const body = await response.json();
    expect(body).toEqual({
      subject: "ops-manager",
      role: "manager",
      appId: "app_acme",
      tenantId: "tenant_acme"
    });
    expect(JSON.stringify(body)).not.toContain("manager-secret-token");
    expect(JSON.stringify(body)).not.toContain("tenant_other");
  });

  it.each([
    ["missing authorization", undefined],
    ["empty bearer", "Bearer "],
    ["wrong scheme", "Basic abc"],
    ["unknown token", "Bearer unknown"]
  ])("returns 401 for %s", async (_label, authorization) => {
    const handler = createHandler();
    const headers = new Headers({ Origin: allowedOrigin });
    if (authorization !== undefined) {
      headers.set("Authorization", authorization);
    }

    const response = await handler(new Request("https://api.example.com/v1/session", { headers }));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await expect(response.json()).resolves.toEqual({
      error: { code: "unauthorized", message: "valid bearer token required" }
    });
  });

  it.each([
    ["missing app scope", { subject: "user", role: "manager", tenantId: "tenant_acme" }],
    ["missing tenant scope", { subject: "user", role: "manager", appId: "app_acme" }],
    [
      "unsupported role",
      { subject: "user", role: "operator", appId: "app_acme", tenantId: "tenant_acme" }
    ]
  ])("returns 403 for %s", async (_label, identity) => {
    const handler = createControlPlaneHttpHandler({
      identityResolver: createStaticTokenIdentityResolver({ invalid: identity }),
      allowedOrigins: [allowedOrigin]
    });

    const response = await handler(sessionRequest({ token: "invalid" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "admin_scope_forbidden", message: "tenant-scoped admin access required" }
    });
  });

  it("fails closed when the identity resolver is not configured", async () => {
    const handler = createControlPlaneHttpHandler({ allowedOrigins: [allowedOrigin] });

    const response = await handler(sessionRequest({ token: "manager-secret-token" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "identity_resolver_unavailable",
        message: "identity service unavailable"
      }
    });
  });

  it("returns a redacted 500 response when identity resolution fails", async () => {
    const secret = "do-not-leak-this-token";
    const handler = createControlPlaneHttpHandler({
      identityResolver: {
        resolveToken: () => {
          throw new Error(`provider failed with ${secret}`);
        }
      },
      allowedOrigins: [allowedOrigin]
    });

    const response = await handler(sessionRequest({ token: secret }));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("internal_error");
    expect(body).not.toContain(secret);
    expect(body).not.toContain("provider failed");
  });

  it("returns typed method and route errors", async () => {
    const handler = createHandler();

    const methodResponse = await handler(
      new Request("https://api.example.com/v1/session", {
        method: "POST",
        headers: { Origin: allowedOrigin }
      })
    );
    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get("allow")).toBe("GET, OPTIONS");
    await expect(methodResponse.json()).resolves.toEqual({
      error: { code: "method_not_allowed", message: "method not allowed" }
    });

    const routeResponse = await handler(
      new Request("https://api.example.com/v1/unknown", {
        headers: { Origin: allowedOrigin }
      })
    );
    expect(routeResponse.status).toBe(404);
    await expect(routeResponse.json()).resolves.toEqual({
      error: { code: "route_not_found", message: "route not found" }
    });
  });

  it("rejects remote plaintext origins but allows loopback development origins", () => {
    expect(() =>
      createControlPlaneHttpHandler({ allowedOrigins: ["http://admin.example.com"] })
    ).toThrow("Admin API origins must use https except for loopback development");
    expect(() =>
      createControlPlaneHttpHandler({ allowedOrigins: ["http://localhost:4180"] })
    ).not.toThrow();
  });
});

describe("Control Plane Admin dashboard contract", () => {
  it("derives scope only from identity and returns redacted bounded summaries", async () => {
    const store = dashboardStore();
    const handler = createDashboardHandler(store);
    const response = await handler(
      sessionRequest({
        token: "manager-secret-token",
        url: "https://api.example.com/v1/admin/dashboard?appId=app_other&tenantId=tenant_other&limit=2"
      })
    );

    expect(response.status).toBe(200);
    expect(store.readSection).toHaveBeenCalledTimes(4);
    expect(store.readSection).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "app_acme", tenantId: "tenant_acme", limit: 2 })
    );
    const body: TestDashboardBody = await response.json();
    expect(body.installations.items).toEqual([
      {
        id: "inst_1",
        pluginKey: "safe-plugin",
        version: "1.0.0",
        enabled: true,
        priority: 10
      }
    ]);
    expect(JSON.stringify(body)).not.toContain("secret-config");
    expect(JSON.stringify(body)).not.toContain("customer-payload");
    expect(JSON.stringify(body)).not.toContain("stack trace");
    expect(body.installations.nextCursor).toEqual(expect.any(String));
  });

  it("fails closed for missing store and rejects invalid limits", async () => {
    const missingStore = createControlPlaneHttpHandler({
      identityResolver: createIdentityResolver(),
      cursorCodec: createAdminCursorCodec("cursor-secret-must-be-at-least-32-bytes-long"),
      allowedOrigins: [allowedOrigin]
    });
    const missingResponse = await missingStore(
      sessionRequest({ token: "manager-secret-token", url: dashboardUrl() })
    );
    expect(missingResponse.status).toBe(503);
    await expect(missingResponse.json()).resolves.toMatchObject({
      error: { code: "dashboard_store_unavailable" }
    });

    const store = dashboardStore();
    const handler = createDashboardHandler(store);
    for (const limit of ["0", "not-a-number", "1.5"]) {
      const response = await handler(
        sessionRequest({ token: "manager-secret-token", url: `${dashboardUrl()}?limit=${limit}` })
      );
      expect(response.status).toBe(400);
    }
    await handler(
      sessionRequest({ token: "manager-secret-token", url: `${dashboardUrl()}?limit=999` })
    );
    expect(store.readSection).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });

  it("rejects tampered and cross-tenant section cursors", async () => {
    const store = dashboardStore();
    const handler = createDashboardHandler(store);
    const initial = await handler(
      sessionRequest({ token: "manager-secret-token", url: dashboardUrl() })
    );
    const initialBody: TestDashboardBody = await initial.json();
    const cursor = initialBody.installations.nextCursor;
    const replacement = cursor.endsWith("a") ? "b" : "a";
    const tampered = await handler(
      sessionRequest({
        token: "manager-secret-token",
        url: `${dashboardUrl()}/installations?cursor=${encodeURIComponent(`${cursor.slice(0, -1)}${replacement}`)}`
      })
    );
    expect(tampered.status).toBe(400);

    const otherTenantHandler = createControlPlaneHttpHandler({
      identityResolver: createStaticTokenIdentityResolver({
        other: {
          subject: "other",
          role: "viewer",
          appId: "app_other",
          tenantId: "tenant_other"
        }
      }),
      dashboardStore: store,
      cursorCodec: createAdminCursorCodec("cursor-secret-must-be-at-least-32-bytes-long"),
      allowedOrigins: [allowedOrigin]
    });
    const crossTenant = await otherTenantHandler(
      sessionRequest({
        token: "other",
        url: `${dashboardUrl()}/installations?cursor=${encodeURIComponent(cursor)}`
      })
    );
    expect(crossTenant.status).toBe(400);
    await expect(crossTenant.json()).resolves.toMatchObject({ error: { code: "invalid_cursor" } });
  });

  it("redacts downstream store failures", async () => {
    const store = dashboardStore();
    store.readSection.mockRejectedValue(new Error("SQL stack trace secret-config"));
    const response = await createDashboardHandler(store)(
      sessionRequest({ token: "manager-secret-token", url: dashboardUrl() })
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("internal_error");
    expect(body).not.toContain("SQL stack");
    expect(body).not.toContain("secret-config");
  });
});

describe("Control Plane installation permission review contract", () => {
  it.each(["manager-secret-token", "viewer-secret-token"])(
    "allows %s to read a tenant-scoped safe installation projection",
    async (token) => {
      const store = installationStore();
      const handler = createControlPlaneHttpHandler({
        identityResolver: createStaticTokenIdentityResolver({
          "manager-secret-token": {
            subject: "manager", role: "manager", appId: "app_acme", tenantId: "tenant_acme"
          },
          "viewer-secret-token": {
            subject: "viewer", role: "viewer", appId: "app_acme", tenantId: "tenant_acme"
          }
        }),
        installationDetailStore: store,
        allowedOrigins: [allowedOrigin]
      });
      const response = await handler(
        sessionRequest({
          token,
          url: "https://api.example.com/v1/admin/installations/inst_1?tenantId=tenant_other"
        })
      );

      expect(response.status).toBe(200);
      expect(store.readInstallation).toHaveBeenCalledWith({
        appId: "app_acme", tenantId: "tenant_acme", id: "inst_1"
      });
      const body = await response.text();
      expect(body).toContain("configFields");
      expect(body).not.toContain("secret-config");
      expect(body).not.toContain("grants_json");
    }
  );

  it("returns 404 for an installation outside the authenticated tenant", async () => {
    const store = installationStore();
    store.readInstallation.mockResolvedValue(null);
    const handler = createControlPlaneHttpHandler({
      identityResolver: createIdentityResolver(),
      installationDetailStore: store,
      allowedOrigins: [allowedOrigin]
    });
    const response = await handler(
      sessionRequest({ token: "manager-secret-token", url: "https://api.example.com/v1/admin/installations/inst_other" })
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "installation_not_found" } });
  });
});

function createHandler() {
  return createControlPlaneHttpHandler({
    identityResolver: createStaticTokenIdentityResolver({
      "manager-secret-token": {
        subject: "ops-manager",
        role: "manager",
        appId: "app_acme",
        tenantId: "tenant_acme"
      }
    }),
    allowedOrigins: [allowedOrigin]
  });
}

function createIdentityResolver() {
  return createStaticTokenIdentityResolver({
    "manager-secret-token": {
      subject: "ops-manager",
      role: "manager",
      appId: "app_acme",
      tenantId: "tenant_acme"
    }
  });
}

function createDashboardHandler(store: AdminDashboardStore) {
  return createControlPlaneHttpHandler({
    identityResolver: createIdentityResolver(),
    dashboardStore: store,
    cursorCodec: createAdminCursorCodec("cursor-secret-must-be-at-least-32-bytes-long"),
    allowedOrigins: [allowedOrigin],
    now: () => new Date("2026-07-19T12:00:00.000Z")
  });
}

function dashboardStore() {
  const readSection = vi.fn<AdminDashboardStore["readSection"]>().mockImplementation((request) => {
    switch (request.section) {
      case "installations":
        return Promise.resolve({
          section: "installations",
          items: [
            {
              id: "inst_1",
              pluginKey: "safe-plugin",
              version: "1.0.0",
              enabled: true,
              priority: 10
            }
          ],
          nextPosition: "inst_1"
        });
      case "pluginVersions":
        return Promise.resolve({ section: "pluginVersions", items: [] });
      case "approvals":
        return Promise.resolve({ section: "approvals", items: [] });
      case "executions":
        return Promise.resolve({ section: "executions", items: [] });
    }
  });
  return {
    readSection,
    readUsageSummary: vi.fn<AdminDashboardStore["readUsageSummary"]>().mockResolvedValue({
      date: "2026-07-19",
      executions: 1,
      runtimeMs: 12
    })
  } satisfies AdminDashboardStore;
}

function dashboardUrl(): string {
  return "https://api.example.com/v1/admin/dashboard";
}

function installationStore() {
  return {
    readInstallation: vi.fn<AdminInstallationDetailStore["readInstallation"]>().mockResolvedValue({
      id: "inst_1",
      pluginKey: "safe-plugin",
      version: "1.0.0",
      enabled: true,
      priority: 10,
      configFields: [
        { name: "channel", type: "string", required: true, configured: true, hasDefault: false }
      ],
      capabilities: [
        { name: "slack.send", scopeKeys: ["channel"], configuredBy: ["channel"], status: "granted" }
      ]
    })
  } satisfies AdminInstallationDetailStore;
}

interface TestDashboardBody {
  installations: {
    items: unknown[];
    nextCursor: string;
  };
}

function sessionRequest(params: { token: string; url?: string }): Request {
  return new Request(params.url ?? "https://api.example.com/v1/session", {
    headers: {
      Authorization: `Bearer ${params.token}`,
      Origin: allowedOrigin
    }
  });
}
