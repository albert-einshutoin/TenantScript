import { describe, expect, it, vi } from "vitest";
import {
  AdminApiError,
  createAdminApiClient,
  createHttpAdminSessionClient,
  type AdminSession
} from "./api-client.js";

describe("Admin API environment selection", () => {
  it("connects the production client to the configured Control Plane", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          subject: "ops-manager",
          role: "manager",
          appId: "app_acme",
          tenantId: "tenant_acme"
        })
      )
      .mockResolvedValueOnce(Response.json(dashboardPayload()));
    const client = createAdminApiClient({
      isDevelopment: false,
      demoMode: false,
      controlPlaneUrl: "https://api.example.com",
      fetcher
    });

    const session = await client.resolveSession({ token: "production-token" });
    expect(session).toMatchObject({
      subject: "ops-manager",
      tenantId: "tenant_acme"
    });
    await expect(client.getDashboard(session)).resolves.toMatchObject({
      usage: { executions: 1, runtimeMs: 12 }
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [dashboardUrl, dashboardInit] = fetcher.mock.calls[1] ?? [];
    expect(requestUrl(dashboardUrl)).toBe("https://api.example.com/v1/admin/dashboard");
    expect(new Headers(dashboardInit?.headers).get("authorization")).toBe(
      "Bearer production-token"
    );
    expect(requestUrl(dashboardUrl)).not.toContain("production-token");
  });

  it("never enables fixture credentials in a production build", async () => {
    const client = createAdminApiClient({
      isDevelopment: false,
      demoMode: true
    });

    await expect(client.resolveSession({ token: "manager-token" })).rejects.toEqual(
      new AdminApiError(503, "control_plane_not_configured", "Control Plane not configured")
    );
  });

  it("rejects a loopback HTTP Control Plane URL in a production build", () => {
    expect(() =>
      createAdminApiClient({
        isDevelopment: false,
        demoMode: false,
        controlPlaneUrl: "http://127.0.0.1:8787"
      })
    ).toThrow("control-plane URL must use https except for loopback development");
  });

  it("loads a signed section page and clears credentials on logout", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          subject: "ops-manager",
          role: "manager",
          appId: "app_acme",
          tenantId: "tenant_acme"
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          section: "installations",
          items: [
            {
              id: "inst_2",
              pluginKey: "second-plugin",
              version: "2.0.0",
              enabled: true,
              priority: 20
            }
          ]
        })
      );
    const client = createAdminApiClient({
      isDevelopment: false,
      demoMode: false,
      controlPlaneUrl: "https://api.example.com",
      fetcher
    });
    await client.resolveSession({ token: "secret-token" });

    await expect(
      client.getDashboardSection("installations", "signed.cursor")
    ).resolves.toMatchObject({ section: "installations", items: [{ id: "inst_2" }] });
    expect(requestUrl(fetcher.mock.calls[1]?.[0])).toContain(
      "/v1/admin/dashboard/installations?cursor=signed.cursor"
    );

    client.clearSession();
    await expect(client.getDashboardSection("installations", "signed.cursor")).rejects.toEqual(
      new AdminApiError(401, "session_required", "Admin session required")
    );
  });

  it("loads only safe installation permission-review metadata with the session bearer", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(sessionPayload()))
      .mockResolvedValueOnce(
        Response.json({
          id: "inst_1",
          pluginKey: "invoice-notify",
          version: "1.2.3",
          enabled: true,
          priority: 10,
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
      );
    const client = createAdminApiClient({
      isDevelopment: false,
      demoMode: false,
      controlPlaneUrl: "https://api.example.com",
      fetcher
    });
    await client.resolveSession({ token: "secret-token" });

    await expect(client.getInstallationPermissionReview("..")).resolves.toMatchObject({
      configFields: [{ name: "channel", configured: true }],
      capabilities: [{ name: "slack.send", status: "granted" }]
    });
    expect(requestUrl(fetcher.mock.calls[1]?.[0])).toBe(
      "https://api.example.com/v1/admin/installation-review?id=.."
    );
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      "Bearer secret-token"
    );
  });

  it("sends a fixed-route PATCH command without self-asserted scope and validates its safe response", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(sessionPayload()))
      .mockResolvedValueOnce(Response.json({ id: "..", enabled: false, priority: 4, revision: 2 }));
    const client = createAdminApiClient({
      isDevelopment: false,
      demoMode: false,
      controlPlaneUrl: "https://api.example.com",
      fetcher
    });
    await client.resolveSession({ token: "secret-token" });

    await expect(
      client.updateInstallationCommand({ id: "..", expectedRevision: 1, enabled: false })
    ).resolves.toEqual({ id: "..", enabled: false, priority: 4, revision: 2 });
    const [url, init] = fetcher.mock.calls[1] ?? [];
    expect(requestUrl(url)).toBe("https://api.example.com/v1/admin/installation-command");
    expect(init?.method).toBe("PATCH");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(init?.body).toBe('{"id":"..","expectedRevision":1,"enabled":false}');
    const body = init?.body;
    expect(typeof body).toBe("string");
    if (typeof body !== "string") throw new Error("expected JSON command body");
    expect(body).not.toContain("tenantId");
    expect(body).not.toContain("appId");
    expect(body).not.toContain("actor");
  });

  it("rejects a command response that changes the installation ID", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(sessionPayload()))
      .mockResolvedValueOnce(Response.json({ id: "other", enabled: false, priority: 4, revision: 2 }));
    const client = createAdminApiClient({
      isDevelopment: false,
      demoMode: false,
      controlPlaneUrl: "https://api.example.com",
      fetcher
    });
    await client.resolveSession({ token: "secret-token" });
    await expect(
      client.updateInstallationCommand({ id: "inst_1", expectedRevision: 1, enabled: false })
    ).rejects.toEqual(
      new AdminApiError(502, "invalid_response", "control-plane returned an invalid response")
    );
  });

  it("rejects installation command responses that include storage values", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(sessionPayload()))
      .mockResolvedValueOnce(
        Response.json({
          id: "inst_1",
          enabled: false,
          priority: 4,
          config: { channel: "must-not-render" }
        })
      );
    const client = createAdminApiClient({
      isDevelopment: false,
      demoMode: false,
      controlPlaneUrl: "https://api.example.com",
      fetcher
    });
    await client.resolveSession({ token: "secret-token" });

    await expect(
      client.updateInstallationCommand({ id: "inst_1", enabled: false })
    ).rejects.toEqual(
      new AdminApiError(502, "invalid_response", "control-plane returned an invalid response")
    );
  });

  it("rejects installation review responses that include storage values", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(sessionPayload()))
      .mockResolvedValueOnce(
        Response.json({
          id: "inst_1",
          pluginKey: "invoice-notify",
          version: "1.2.3",
          enabled: true,
          priority: 10,
          configFields: [],
          capabilities: [],
          egress: { mode: "deny", allowlistedHostCount: 0 },
          config: { channel: "must-not-render" }
        })
      );
    const client = createAdminApiClient({
      isDevelopment: false,
      demoMode: false,
      controlPlaneUrl: "https://api.example.com",
      fetcher
    });
    await client.resolveSession({ token: "secret-token" });
    await expect(client.getInstallationPermissionReview("inst_1")).rejects.toEqual(
      new AdminApiError(502, "invalid_response", "control-plane returned an invalid response")
    );
  });

  it("rejects dashboard responses that expose storage-only fields", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          subject: "ops-manager",
          role: "manager",
          appId: "app_acme",
          tenantId: "tenant_acme"
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          ...dashboardPayload(),
          installations: {
            items: [
              {
                id: "inst_1",
                pluginKey: "plugin",
                version: "1.0.0",
                enabled: true,
                priority: 10,
                config: { secret: "must-not-cross-wire" }
              }
            ]
          }
        })
      );
    const client = createAdminApiClient({
      isDevelopment: false,
      demoMode: false,
      controlPlaneUrl: "https://api.example.com",
      fetcher
    });
    const session = await client.resolveSession({ token: "secret-token" });

    await expect(client.getDashboard(session)).rejects.toEqual(
      new AdminApiError(502, "invalid_response", "control-plane returned an invalid response")
    );
  });

  it("maps every paginated dashboard section DTO", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(sessionPayload()))
      .mockResolvedValueOnce(
        Response.json({
          section: "pluginVersions",
          items: [{ id: "v1", pluginId: "p1", version: "1.0.0", artifactHash: "hash" }],
          nextCursor: "next.version"
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          section: "approvals",
          items: [
            {
              id: "a1",
              pluginId: "p1",
              role: "manager",
              resumeHook: "approval.decided",
              state: "approved",
              expiresAt: "2026-07-20T00:00:00.000Z",
              createdAt: "2026-07-19T00:00:00.000Z"
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          section: "executions",
          items: [
            {
              id: "e1",
              pluginId: "p1",
              hookName: "invoice.created",
              version: "1.0.0",
              status: "success",
              durationMs: 12,
              capabilityNames: [],
              createdAt: "2026-07-19T00:00:00.000Z"
            }
          ]
        })
      );
    const client = createAdminApiClient({
      isDevelopment: false,
      demoMode: false,
      controlPlaneUrl: "https://api.example.com",
      fetcher
    });
    await client.resolveSession({ token: "secret-token" });

    await expect(client.getDashboardSection("pluginVersions", "cursor")).resolves.toMatchObject({
      section: "pluginVersions",
      nextCursor: "next.version"
    });
    await expect(client.getDashboardSection("approvals", "cursor")).resolves.toMatchObject({
      section: "approvals",
      items: [{ createdAt: new Date("2026-07-19T00:00:00.000Z") }]
    });
    await expect(client.getDashboardSection("executions", "cursor")).resolves.toMatchObject({
      section: "executions",
      items: [{ capabilityNames: [] }]
    });
  });

  it("preserves typed dashboard errors and redacts network failures", async () => {
    const forbidden = createAdminApiClient({
      isDevelopment: false,
      demoMode: false,
      controlPlaneUrl: "https://api.example.com",
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(sessionPayload()))
        .mockResolvedValueOnce(
          Response.json(
            { error: { code: "admin_scope_forbidden", message: "tenant scope required" } },
            { status: 403 }
          )
        )
    });
    const session = await forbidden.resolveSession({ token: "secret-token" });
    await expect(forbidden.getDashboard(session)).rejects.toEqual(
      new AdminApiError(403, "admin_scope_forbidden", "tenant scope required")
    );

    const network = createAdminApiClient({
      isDevelopment: false,
      demoMode: false,
      controlPlaneUrl: "https://api.example.com",
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(sessionPayload()))
        .mockRejectedValueOnce(new Error("provider secret"))
    });
    const networkSession = await network.resolveSession({ token: "secret-token" });
    await expect(network.getDashboard(networkSession)).rejects.toEqual(
      new AdminApiError(0, "network_error", "control-plane is unreachable")
    );
  });
});

function dashboardPayload() {
  return {
    installations: {
      items: [
        {
          id: "inst_1",
          pluginKey: "safe-plugin",
          version: "1.0.0",
          enabled: true,
          priority: 10
        }
      ],
      nextCursor: "signed.cursor"
    },
    pluginVersions: { items: [] },
    approvals: { items: [] },
    executions: { items: [] },
    usage: { date: "2026-07-19", executions: 1, runtimeMs: 12 }
  };
}

function sessionPayload() {
  return {
    subject: "ops-manager",
    role: "manager",
    appId: "app_acme",
    tenantId: "tenant_acme"
  };
}

function requestUrl(input: Parameters<typeof fetch>[0] | undefined): string {
  if (input === undefined) {
    return "";
  }
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

describe("Admin HTTP session client", () => {
  it("sends the token only in Authorization and returns identity without the credential", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        subject: "ops-manager",
        role: "manager",
        appId: "app_acme",
        tenantId: "tenant_acme"
      })
    );
    const client = createHttpAdminSessionClient({
      baseUrl: "https://api.example.com/",
      fetcher
    });

    const session = await client.resolveSession({ token: "secret-token" });

    expect(session).toEqual<AdminSession>({
      subject: "ops-manager",
      role: "manager",
      appId: "app_acme",
      tenantId: "tenant_acme"
    });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    const requestUrl =
      typeof url === "string" ? url : url instanceof URL ? url.href : (url?.url ?? "");
    expect(requestUrl).toBe("https://api.example.com/v1/session");
    expect(requestUrl).not.toContain("secret-token");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
  });

  it("rejects remote plaintext HTTP but allows loopback development URLs", () => {
    expect(() => createHttpAdminSessionClient({ baseUrl: "http://api.example.com" })).toThrow(
      "control-plane URL must use https except for loopback development"
    );
    expect(() =>
      createHttpAdminSessionClient({
        baseUrl: "http://127.0.0.1:8787",
        allowInsecureLoopback: true
      })
    ).not.toThrow();
  });

  it("converts an HTTP error envelope into a typed error", async () => {
    const client = createHttpAdminSessionClient({
      baseUrl: "https://api.example.com",
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: {
              code: "admin_scope_forbidden",
              message: "tenant-scoped admin access required"
            }
          },
          { status: 403 }
        )
      )
    });

    await expect(client.resolveSession({ token: "viewer" })).rejects.toEqual(
      new AdminApiError(403, "admin_scope_forbidden", "tenant-scoped admin access required")
    );
  });

  it("converts a network failure into a typed error without exposing provider details", async () => {
    const client = createHttpAdminSessionClient({
      baseUrl: "https://api.example.com",
      fetcher: vi.fn<typeof fetch>().mockRejectedValue(new Error("socket secret: abc123"))
    });

    await expect(client.resolveSession({ token: "secret" })).rejects.toEqual(
      new AdminApiError(0, "network_error", "control-plane is unreachable")
    );
  });

  it.each([
    "https://user:password@api.example.com",
    "https://api.example.com?token=configuration-secret",
    "https://api.example.com#configuration-secret"
  ])("rejects an unsafe control-plane base URL: %s", (baseUrl) => {
    expect(() => createHttpAdminSessionClient({ baseUrl })).toThrow(
      "control-plane URL must not contain credentials, query, or fragment"
    );
  });

  it.each([
    ["missing tenant scope", { subject: "user", role: "manager", appId: "app_acme" }],
    [
      "unknown role",
      { subject: "user", role: "operator", appId: "app_acme", tenantId: "tenant_acme" }
    ],
    ["malformed payload", { ok: true }]
  ])("rejects %s as an invalid response", async (_label, payload) => {
    const client = createHttpAdminSessionClient({
      baseUrl: "https://api.example.com",
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload))
    });

    await expect(client.resolveSession({ token: "secret" })).rejects.toEqual(
      new AdminApiError(502, "invalid_response", "control-plane returned an invalid response")
    );
  });
});
