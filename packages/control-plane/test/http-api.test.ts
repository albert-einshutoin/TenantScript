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
      { subject: "user", role: "super-admin", appId: "app_acme", tenantId: "tenant_acme" }
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
    expect(store.readSchemaMigrations).toHaveBeenCalledWith({ appId: "app_acme" });
    const body: TestDashboardBody = await response.json();
    expect(body.installations.items).toEqual([
      {
        id: "inst_1",
        pluginKey: "safe-plugin",
        version: "1.0.0",
        enabled: true,
        priority: 10,
        revision: 0
      }
    ]);
    expect(JSON.stringify(body)).not.toContain("secret-config");
    expect(JSON.stringify(body)).not.toContain("customer-payload");
    expect(JSON.stringify(body)).not.toContain("stack trace");
    expect(body.installations.nextCursor).toEqual(expect.any(String));
    expect(body.schemaMigrations).toEqual([
      expect.objectContaining({ hookName: "invoice.created" })
    ]);
    expect(body.telemetry).toEqual({ enabled: false, mode: "disabled", schemaVersion: 1 });
  });

  it("returns only the public anonymous telemetry status when explicitly enabled", async () => {
    const handler = createControlPlaneHttpHandler({
      identityResolver: createIdentityResolver(),
      dashboardStore: dashboardStore(),
      cursorCodec: createAdminCursorCodec("cursor-secret-must-be-at-least-32-bytes-long"),
      telemetryStatus: { enabled: true, mode: "anonymous-aggregate", schemaVersion: 1 },
      allowedOrigins: [allowedOrigin],
      now: () => new Date("2026-07-19T12:00:00.000Z")
    });

    const response = await handler(
      sessionRequest({ token: "manager-secret-token", url: dashboardUrl() })
    );
    const body: TestDashboardBody = await response.json();

    expect(body.telemetry).toEqual({
      enabled: true,
      mode: "anonymous-aggregate",
      schemaVersion: 1
    });
    expect(JSON.stringify(body.telemetry)).not.toContain("endpoint");
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

  it("pages audit events only through their signed tenant cursor", async () => {
    const store = dashboardStore();
    const handler = createDashboardHandler(store);
    const initial = await handler(
      sessionRequest({ token: "manager-secret-token", url: `${dashboardUrl()}/auditEvents` })
    );
    const body: { nextCursor: string } = await initial.json();

    const response = await handler(
      sessionRequest({
        token: "manager-secret-token",
        url: `${dashboardUrl()}/auditEvents?cursor=${encodeURIComponent(body.nextCursor)}`
      })
    );

    expect(response.status).toBe(200);
    expect(store.readSection).toHaveBeenLastCalledWith({
      appId: "app_acme",
      tenantId: "tenant_acme",
      section: "auditEvents",
      limit: 20,
      position: "2026-07-19T12:00:00.000Z\taudit_1"
    });
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
            subject: "manager",
            role: "manager",
            appId: "app_acme",
            tenantId: "tenant_acme"
          },
          "viewer-secret-token": {
            subject: "viewer",
            role: "viewer",
            appId: "app_acme",
            tenantId: "tenant_acme"
          }
        }),
        installationDetailStore: store,
        allowedOrigins: [allowedOrigin]
      });
      const response = await handler(
        sessionRequest({
          token,
          url: "https://api.example.com/v1/admin/installation-review?id=inst_1&tenantId=tenant_other"
        })
      );

      expect(response.status).toBe(200);
      expect(store.readInstallation).toHaveBeenCalledWith({
        appId: "app_acme",
        tenantId: "tenant_acme",
        id: "inst_1"
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
      sessionRequest({
        token: "manager-secret-token",
        url: "https://api.example.com/v1/admin/installation-review?id=inst_other"
      })
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "installation_not_found" }
    });
  });

  it("fails closed when the installation ID is missing", async () => {
    const handler = createControlPlaneHttpHandler({
      identityResolver: createIdentityResolver(),
      installationDetailStore: installationStore(),
      allowedOrigins: [allowedOrigin]
    });
    const response = await handler(
      sessionRequest({
        token: "manager-secret-token",
        url: "https://api.example.com/v1/admin/installation-review"
      })
    );
    expect(response.status).toBe(404);
  });
});

describe("Control Plane installation command contract", () => {
  it("requires a matching revision and exposes a common conflict response without a mutation audit", async () => {
    const commandStore = {
      updateInstallation: vi.fn().mockResolvedValue({
        outcome: "conflict",
        id: "inst_1",
        revision: 4
      })
    };
    const handler = createControlPlaneHttpHandler({
      identityResolver: createIdentityResolver(),
      installationCommandStore: commandStore,
      adminMutationRateLimiter: allowAdminMutation,
      allowedOrigins: [allowedOrigin]
    });
    const missingRevision = await handler(
      commandRequest("manager-secret-token", { id: "inst_1", enabled: false })
    );
    expect(missingRevision.status).toBe(400);

    const conflict = await handler(
      commandRequest("manager-secret-token", {
        id: "inst_1",
        expectedRevision: 3,
        enabled: false
      })
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: { code: "installation_revision_conflict", message: "installation changed; refresh" }
    });
    expect(commandStore.updateInstallation).toHaveBeenCalledWith({
      appId: "app_acme",
      tenantId: "tenant_acme",
      actor: "ops-manager",
      id: "inst_1",
      expectedRevision: 3,
      enabled: false
    });
  });

  it("lets only a manager issue a scoped command and derives every audit field from identity", async () => {
    const commandStore = {
      updateInstallation: vi.fn().mockResolvedValue({
        outcome: "updated",
        id: "inst_1",
        enabled: false,
        priority: 5,
        revision: 1,
        changed: true
      })
    };
    const handler = createControlPlaneHttpHandler({
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
      installationCommandStore: commandStore,
      adminMutationRateLimiter: allowAdminMutation,
      allowedOrigins: [allowedOrigin]
    });

    const response = await handler(
      commandRequest("manager", {
        id: "inst_1",
        expectedRevision: 0,
        enabled: false,
        priority: 5
      })
    );

    expect(response.status).toBe(200);
    expect(commandStore.updateInstallation).toHaveBeenCalledWith({
      appId: "app_acme",
      tenantId: "tenant_acme",
      actor: "manager-subject",
      id: "inst_1",
      expectedRevision: 0,
      enabled: false,
      priority: 5
    });
    expect(await response.json()).toEqual({
      id: "inst_1",
      enabled: false,
      priority: 5,
      revision: 1
    });

    const forbidden = await handler(
      commandRequest("viewer", { id: "inst_1", expectedRevision: 0, enabled: false })
    );
    expect(forbidden.status).toBe(403);
    expect(commandStore.updateInstallation).toHaveBeenCalledTimes(1);
  });

  it("fails closed for malformed, oversized, or unsafe command bodies and only permits the fixed route", async () => {
    const commandStore = { updateInstallation: vi.fn() };
    const handler = createControlPlaneHttpHandler({
      identityResolver: createIdentityResolver(),
      installationCommandStore: commandStore,
      adminMutationRateLimiter: allowAdminMutation,
      allowedOrigins: [allowedOrigin]
    });
    const headers = {
      Authorization: "Bearer manager-secret-token",
      Origin: allowedOrigin,
      "Content-Type": "application/json"
    };
    const cases = [
      new Request("https://api.example.com/v1/admin/installation-command", {
        method: "PATCH",
        headers,
        body: "{"
      }),
      commandRequest("manager-secret-token", { id: "inst_1" }),
      commandRequest("manager-secret-token", { id: "inst_1", expectedRevision: 0, priority: 1.5 }),
      commandRequest("manager-secret-token", {
        id: "inst_1",
        expectedRevision: 0,
        priority: Number.POSITIVE_INFINITY
      }),
      new Request("https://api.example.com/v1/admin/installation-command", {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "text/plain" },
        body: JSON.stringify({ id: "inst_1", enabled: true })
      }),
      new Request("https://api.example.com/v1/admin/installation-command", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ id: "inst_1", enabled: true, config: { secret: "no" } })
      }),
      commandRequest("manager-secret-token", {
        id: "inst_1",
        expectedRevision: 0,
        enabled: true,
        tenantId: "tenant_other",
        appId: "app_other",
        actor: "attacker",
        role: "manager"
      }),
      new Request("https://api.example.com/v1/admin/installations/..", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ id: "inst_1", enabled: true })
      }),
      new Request("https://api.example.com/v1/admin/installation-command", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ id: "inst_1", enabled: true, padding: "x".repeat(16_384) })
      })
    ];
    for (const request of cases) {
      const response = await handler(request);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).not.toContain("secret");
    }
    expect(commandStore.updateInstallation).not.toHaveBeenCalled();
  });

  it("uses a common 404 for missing, cross-tenant, cross-app, and corrupt relations; no-op skips audit mutation", async () => {
    const commandStore = {
      updateInstallation: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          outcome: "updated",
          id: "inst_1",
          enabled: true,
          priority: 10,
          revision: 0,
          changed: false
        })
    };
    const handler = createControlPlaneHttpHandler({
      identityResolver: createIdentityResolver(),
      installationCommandStore: commandStore,
      adminMutationRateLimiter: allowAdminMutation,
      allowedOrigins: [allowedOrigin]
    });
    for (const id of ["missing", "other-tenant", "cross-app"]) {
      const response = await handler(
        commandRequest("manager-secret-token", { id, expectedRevision: 0, enabled: false })
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "installation_not_found" }
      });
    }
    const noOp = await handler(
      commandRequest("manager-secret-token", {
        id: "inst_1",
        expectedRevision: 0,
        enabled: true,
        priority: 10
      })
    );
    expect(noOp.status).toBe(200);
    await expect(noOp.json()).resolves.toEqual({
      id: "inst_1",
      enabled: true,
      priority: 10,
      revision: 0
    });
  });

  it("advertises PATCH in CORS preflight and rejects other methods", async () => {
    const handler = createControlPlaneHttpHandler({
      identityResolver: createIdentityResolver(),
      installationCommandStore: { updateInstallation: vi.fn() },
      allowedOrigins: [allowedOrigin]
    });
    const preflight = await handler(
      new Request("https://api.example.com/v1/admin/installation-command", {
        method: "OPTIONS",
        headers: { Origin: allowedOrigin, "Access-Control-Request-Method": "PATCH" }
      })
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("PATCH");
    const response = await handler(
      new Request("https://api.example.com/v1/admin/installation-command", {
        method: "PUT",
        headers: { Origin: allowedOrigin }
      })
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("PATCH, OPTIONS");
  });

  it("rejects chunked command bodies over 16KiB and cancels their stream before mutation", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('{"id":"inst_1","expectedRevision":0,"enabled":')
        );
        controller.enqueue(new Uint8Array(16 * 1024));
      },
      cancel() {
        cancelled = true;
      }
    });
    const commandStore = { updateInstallation: vi.fn() };
    const handler = createControlPlaneHttpHandler({
      identityResolver: createIdentityResolver(),
      installationCommandStore: commandStore,
      allowedOrigins: [allowedOrigin]
    });
    const request = new Request("https://api.example.com/v1/admin/installation-command", {
      method: "PATCH",
      headers: {
        Authorization: "Bearer manager-secret-token",
        Origin: allowedOrigin,
        "Content-Type": "application/json"
      },
      body,
      duplex: "half"
    } as RequestInit);
    const response = await handler(request);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(commandStore.updateInstallation).not.toHaveBeenCalled();
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

const allowAdminMutation = {
  reserve: () => Promise.resolve({ allowed: true as const, remaining: 999 })
};

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
              priority: 10,
              revision: 0
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
      case "auditEvents":
        return Promise.resolve({
          section: "auditEvents",
          items: [
            {
              id: "audit_1",
              installationId: "inst_1",
              pluginId: "plugin_1",
              revision: 1,
              actor: "ops-manager",
              action: "installation.command",
              before: { enabled: true, priority: 10, revision: 0 },
              after: { enabled: false, priority: 10, revision: 1 },
              createdAt: "2026-07-19T12:00:00.000Z"
            }
          ],
          nextPosition: "2026-07-19T12:00:00.000Z\taudit_1"
        });
    }
  });
  return {
    readSection,
    readSchemaMigrations: vi
      .fn<NonNullable<AdminDashboardStore["readSchemaMigrations"]>>()
      .mockResolvedValue([
        {
          hookName: "invoice.created",
          incompatibleInstallations: [],
          versions: [
            {
              version: "1.0.0",
              installationCount: 0,
              removable: true,
              blockingInstallations: []
            }
          ]
        }
      ]),
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
      revision: 0,
      configFields: [
        { name: "channel", type: "string", required: true, configured: true, hasDefault: false }
      ],
      capabilities: [
        {
          name: "slack.send",
          scopeKeys: ["channel"],
          configReferences: ["channel"],
          status: "granted"
        }
      ],
      egress: { mode: "deny", allowlistedHostCount: 0 }
    })
  } satisfies AdminInstallationDetailStore;
}

interface TestDashboardBody {
  installations: {
    items: unknown[];
    nextCursor: string;
  };
  auditEvents: {
    items: unknown[];
    nextCursor: string;
  };
  schemaMigrations: unknown[];
  telemetry: { enabled: boolean; mode: string; schemaVersion: number };
}

function sessionRequest(params: { token: string; url?: string }): Request {
  return new Request(params.url ?? "https://api.example.com/v1/session", {
    headers: {
      Authorization: `Bearer ${params.token}`,
      Origin: allowedOrigin
    }
  });
}

function commandRequest(token: string, body: Record<string, unknown>): Request {
  return new Request("https://api.example.com/v1/admin/installation-command", {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: allowedOrigin,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}
