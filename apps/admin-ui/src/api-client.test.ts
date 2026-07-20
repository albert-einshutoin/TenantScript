import { describe, expect, it, vi } from "vitest";
import {
  AdminApiError,
  createAdminApiClient,
  createDemoAdminApiClient,
  createHttpAdminSessionClient,
  type AdminSession
} from "./api-client.js";

describe("Admin API environment selection", () => {
  it("submits operator installation proposals to the approval endpoint without trusted scope fields", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(sessionPayload("operator")))
      .mockResolvedValueOnce(
        Response.json(
          {
            approvalId: "approval_install_1",
            state: "pending",
            pluginKey: "invoice-notify",
            version: "1.0.0",
            capabilities: ["slack.send"],
            expiresAt: "2026-07-21T00:00:00.000Z"
          },
          { status: 201 }
        )
      );
    const client = createAdminApiClient({
      isDevelopment: false,
      demoMode: false,
      controlPlaneUrl: "https://api.example.com",
      fetcher
    });
    await client.resolveSession({ token: "operator-token" });

    const result = await client.requestInstallation({
      idempotencyKey: "install-request-client-key-0001",
      versionId: "version_1",
      config: { notifyChannel: "C123" },
      confirmedCapabilities: ["slack.send"],
      enabled: false,
      priority: 20
    });
    expect(result.approvalId).toBe("approval_install_1");
    expect(result.expiresAt).toBeInstanceOf(Date);

    const [url, init] = fetcher.mock.calls[1] ?? [];
    expect(requestUrl(url)).toBe("https://api.example.com/v1/admin/installation-requests");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(
      "install-request-client-key-0001"
    );
    expect(init?.body).toBe(
      '{"versionId":"version_1","config":{"notifyChannel":"C123"},"confirmedCapabilities":["slack.send"],"enabled":false,"priority":20}'
    );
    const requestBody = init?.body;
    expect(typeof requestBody).toBe("string");
    if (typeof requestBody !== "string") throw new Error("expected JSON request body");
    expect(requestBody).not.toContain("tenantId");
  });
  it("keeps demo commands revisioned and idempotent like the HTTP contract", async () => {
    const client = createDemoAdminApiClient();
    await expect(
      client.updateInstallationCommand({
        id: "inst_large_invoice",
        expectedRevision: 0,
        enabled: false
      })
    ).resolves.toMatchObject({ enabled: false, priority: 10, revision: 1 });
    await expect(
      client.updateInstallationCommand({
        id: "inst_large_invoice",
        expectedRevision: 1,
        priority: 10
      })
    ).resolves.toMatchObject({ enabled: false, priority: 10, revision: 1 });
    await expect(
      client.updateInstallationCommand({
        id: "inst_large_invoice",
        expectedRevision: 0,
        priority: 4
      })
    ).rejects.toEqual(
      new AdminApiError(409, "installation_revision_conflict", "installation changed; refresh")
    );
  });

  it("keeps demo rollbacks scoped, revisioned, and correlated with dashboard state", async () => {
    const client = createDemoAdminApiClient();
    await expect(
      client.rollbackInstallation({
        idempotencyKey: "rollback-client-key-0001",
        installationId: "inst_large_invoice",
        targetVersionId: "version_large_invoice_1_2_2",
        expectedRevision: 0
      })
    ).resolves.toMatchObject({
      installationId: "inst_large_invoice",
      fromVersion: "1.3.0",
      toVersion: "1.2.2",
      revision: 1
    });
    const dashboard = await client.getDashboard(
      await client.resolveSession({ token: "manager-token" })
    );
    expect(dashboard.installations.find(({ id }) => id === "inst_large_invoice")).toMatchObject({
      version: "1.2.2",
      revision: 1
    });
    await expect(
      client.rollbackInstallation({
        idempotencyKey: "rollback-client-key-0002",
        installationId: "missing",
        targetVersionId: "version_large_invoice_1_3_0",
        expectedRevision: 0
      })
    ).rejects.toMatchObject({ code: "rollback_target_not_found" });
    await expect(
      client.rollbackInstallation({
        idempotencyKey: "rollback-client-key-0003",
        installationId: "inst_large_invoice",
        targetVersionId: "missing",
        expectedRevision: 1
      })
    ).rejects.toMatchObject({ code: "rollback_target_not_found" });
    await expect(
      client.rollbackInstallation({
        idempotencyKey: "rollback-client-key-0004",
        installationId: "inst_large_invoice",
        targetVersionId: "version_large_invoice_1_3_0",
        expectedRevision: 0
      })
    ).rejects.toMatchObject({ code: "installation_revision_conflict" });
    await expect(
      client.rollbackInstallation({
        idempotencyKey: "rollback-client-key-0005",
        installationId: "inst_large_invoice",
        targetVersionId: "version_large_invoice_1_2_2",
        expectedRevision: 1
      })
    ).rejects.toMatchObject({ code: "rollback_target_is_current" });
  });

  it("keeps demo execution search and detail aligned with the HTTP contract", async () => {
    const client = createDemoAdminApiClient();

    await expect(client.searchExecutions({})).resolves.toMatchObject({
      items: [{ id: "exec_1" }, { id: "exec_2" }]
    });
    await expect(
      client.searchExecutions({
        pluginId: "plugin_large_invoice",
        hookName: "invoice.created",
        status: "success"
      })
    ).resolves.toMatchObject({ items: [{ id: "exec_1" }] });
    await expect(
      client.searchExecutions({ pluginId: "plugin_large_invoice", status: "error" })
    ).resolves.toMatchObject({ items: [] });
    await expect(client.getExecutionDetail("exec_1")).resolves.toMatchObject({
      id: "exec_1",
      capabilityCalls: [{ name: "slack.send", status: "success" }]
    });
    await expect(client.getExecutionDetail("missing")).rejects.toEqual(
      new AdminApiError(404, "execution_not_found", "execution not found")
    );
  });

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
      usage: { executions: 1, runtimeMs: 12 },
      schemaMigrations: [{ hookName: "invoice.created" }]
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
              priority: 20,
              revision: 0
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

  it("preserves a bounded Retry-After hint without automatically retrying a mutation", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(sessionPayload()))
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "admin_mutation_rate_limited", message: "too many admin changes" } },
          { status: 429, headers: { "Retry-After": "17" } }
        )
      );
    const client = createAdminApiClient({
      isDevelopment: false,
      demoMode: false,
      controlPlaneUrl: "https://api.example.com",
      fetcher
    });
    await client.resolveSession({ token: "secret-token" });

    await expect(
      client.updateInstallationCommand({ id: "inst_1", expectedRevision: 0, enabled: false })
    ).rejects.toEqual(
      new AdminApiError(429, "admin_mutation_rate_limited", "too many admin changes", 17)
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("loads a value-free install preview and submits only config plus explicit capability confirmation", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(sessionPayload()))
      .mockResolvedValueOnce(
        Response.json({
          versionId: "version_1",
          pluginKey: "invoice-notify",
          version: "1.0.0",
          configFields: [
            { name: "notifyChannel", type: "string", required: true, hasDefault: false }
          ],
          capabilities: [
            {
              name: "slack.send",
              scopeKeys: ["channel"],
              configReferences: ["notifyChannel"]
            }
          ],
          egress: { mode: "deny", allowlistedHostCount: 0 }
        })
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            id: "installation_new",
            versionId: "version_1",
            pluginKey: "invoice-notify",
            version: "1.0.0",
            enabled: true,
            priority: 20,
            revision: 0
          },
          { status: 201 }
        )
      );
    const client = createAdminApiClient({
      isDevelopment: false,
      demoMode: false,
      controlPlaneUrl: "https://api.example.com",
      fetcher
    });
    await client.resolveSession({ token: "secret-token" });

    await expect(client.getInstallPreview("version_1")).resolves.toMatchObject({
      versionId: "version_1",
      configFields: [{ name: "notifyChannel" }]
    });
    await expect(
      client.installPlugin({
        idempotencyKey: "install-client-key-0001",
        versionId: "version_1",
        config: { notifyChannel: "C123" },
        confirmedCapabilities: ["slack.send"],
        enabled: true,
        priority: 20
      })
    ).resolves.toMatchObject({ id: "installation_new", revision: 0 });

    const [previewUrl] = fetcher.mock.calls[1] ?? [];
    expect(requestUrl(previewUrl)).toBe(
      "https://api.example.com/v1/admin/install-preview?versionId=version_1"
    );
    const [installUrl, installInit] = fetcher.mock.calls[2] ?? [];
    expect(requestUrl(installUrl)).toBe("https://api.example.com/v1/admin/installations");
    expect(installInit?.method).toBe("POST");
    expect(new Headers(installInit?.headers).get("idempotency-key")).toBe(
      "install-client-key-0001"
    );
    expect(installInit?.body).toBe(
      '{"versionId":"version_1","config":{"notifyChannel":"C123"},"confirmedCapabilities":["slack.send"],"enabled":true,"priority":20}'
    );
    const installBody = installInit?.body;
    expect(typeof installBody).toBe("string");
    if (typeof installBody !== "string") throw new Error("expected JSON install body");
    expect(installBody).not.toContain("tenantId");
    expect(installBody).not.toContain("grants");
    expect(installBody).not.toContain("idempotencyKey");
  });

  it("rejects install responses and previews that expose config or grant values", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(sessionPayload()))
      .mockResolvedValueOnce(
        Response.json({
          versionId: "version_1",
          pluginKey: "invoice-notify",
          version: "1.0.0",
          configFields: [],
          capabilities: [],
          egress: { mode: "deny", allowlistedHostCount: 0 },
          config: { secret: "leak" }
        })
      );
    const client = createAdminApiClient({
      isDevelopment: false,
      demoMode: false,
      controlPlaneUrl: "https://api.example.com",
      fetcher
    });
    await client.resolveSession({ token: "secret-token" });
    await expect(client.getInstallPreview("version_1")).rejects.toEqual(
      new AdminApiError(502, "invalid_response", "control-plane returned an invalid response")
    );
  });

  it("rejects an install response correlated to a different plugin version", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(sessionPayload()))
      .mockResolvedValueOnce(
        Response.json(
          {
            id: "installation_new",
            versionId: "version_other",
            pluginKey: "invoice-notify",
            version: "2.0.0",
            enabled: false,
            priority: 20,
            revision: 0
          },
          { status: 201 }
        )
      );
    const client = createAdminApiClient({
      isDevelopment: false,
      demoMode: false,
      controlPlaneUrl: "https://api.example.com",
      fetcher
    });
    await client.resolveSession({ token: "secret-token" });

    await expect(
      client.installPlugin({
        idempotencyKey: "install-client-key-0002",
        versionId: "version_1",
        config: {},
        confirmedCapabilities: [],
        enabled: false,
        priority: 20
      })
    ).rejects.toEqual(
      new AdminApiError(502, "invalid_response", "control-plane returned an invalid response")
    );
  });

  it("rejects a command response that changes the installation ID", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(sessionPayload()))
      .mockResolvedValueOnce(
        Response.json({ id: "other", enabled: false, priority: 4, revision: 2 })
      );
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
      client.updateInstallationCommand({ id: "inst_1", expectedRevision: 0, enabled: false })
    ).rejects.toEqual(
      new AdminApiError(502, "invalid_response", "control-plane returned an invalid response")
    );
  });

  it("submits the minimal rollback command and validates correlated audit evidence", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(sessionPayload()))
      .mockResolvedValueOnce(
        Response.json({
          installationId: "inst_1",
          pluginKey: "invoice-notify",
          fromVersion: "1.3.0",
          toVersion: "1.2.2",
          revision: 4,
          auditId: "audit_rollback_1",
          completedAt: "2026-07-19T17:00:00.000Z"
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
      client.rollbackInstallation({
        idempotencyKey: "rollback-client-key-0006",
        installationId: "inst_1",
        targetVersionId: "version_1_2_2",
        expectedRevision: 3
      })
    ).resolves.toMatchObject({
      auditId: "audit_rollback_1",
      completedAt: new Date("2026-07-19T17:00:00.000Z")
    });
    const [url, init] = fetcher.mock.calls[1] ?? [];
    expect(requestUrl(url)).toBe("https://api.example.com/v1/admin/rollbacks");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("rollback-client-key-0006");
    expect(typeof init?.body).toBe("string");
    expect(JSON.parse(init?.body as string)).toEqual({
      installationId: "inst_1",
      targetVersionId: "version_1_2_2",
      expectedRevision: 3
    });
  });

  it("rejects uncorrelated or storage-bearing rollback responses", async () => {
    for (const payload of [
      {
        installationId: "other",
        pluginKey: "invoice-notify",
        fromVersion: "1.3.0",
        toVersion: "1.2.2",
        revision: 4,
        auditId: "audit_1",
        completedAt: "2026-07-19T17:00:00.000Z"
      },
      {
        installationId: "inst_1",
        pluginKey: "invoice-notify",
        fromVersion: "1.3.0",
        toVersion: "1.2.2",
        revision: 4,
        auditId: "audit_1",
        completedAt: "2026-07-19T17:00:00.000Z",
        config: { secret: "must-not-render" }
      }
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(sessionPayload()))
        .mockResolvedValueOnce(Response.json(payload));
      const client = createAdminApiClient({
        isDevelopment: false,
        demoMode: false,
        controlPlaneUrl: "https://api.example.com",
        fetcher
      });
      await client.resolveSession({ token: "secret-token" });
      await expect(
        client.rollbackInstallation({
          idempotencyKey: "rollback-client-key-0007",
          installationId: "inst_1",
          targetVersionId: "version_1_2_2",
          expectedRevision: 3
        })
      ).rejects.toEqual(
        new AdminApiError(502, "invalid_response", "control-plane returned an invalid response")
      );
    }
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
          items: [
            {
              id: "v1",
              pluginId: "p1",
              pluginKey: "invoice-notify",
              version: "1.0.0",
              artifactHash: "hash",
              createdAt: "2026-07-19T00:00:00.000Z"
            }
          ],
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

  it("searches executions with server filters and accepts only value-free detail fields", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(sessionPayload()))
      .mockResolvedValueOnce(
        Response.json({
          section: "executions",
          items: [
            {
              id: "exec_1",
              pluginId: "plugin_invoice",
              hookName: "invoice.created",
              version: "1.2.3",
              status: "error",
              durationMs: 19,
              capabilityNames: ["slack.send"],
              createdAt: "2026-07-19T00:00:00.000Z"
            }
          ],
          nextCursor: "signed.next"
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          id: "exec_1",
          pluginId: "plugin_invoice",
          hookName: "invoice.created",
          version: "1.2.3",
          status: "error",
          durationMs: 19,
          errorCode: "execution_failed",
          capabilityCalls: [{ name: "slack.send", status: "error" }],
          createdAt: "2026-07-19T00:00:00.000Z"
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
      client.searchExecutions({
        pluginId: "plugin_invoice",
        hookName: "invoice.created",
        status: "error",
        cursor: "signed.cursor"
      })
    ).resolves.toMatchObject({ items: [{ id: "exec_1" }], nextCursor: "signed.next" });
    expect(requestUrl(fetcher.mock.calls[1]?.[0])).toBe(
      "https://api.example.com/v1/admin/dashboard/executions?pluginId=plugin_invoice&hookName=invoice.created&status=error&cursor=signed.cursor"
    );
    await expect(client.getExecutionDetail("exec_1")).resolves.toMatchObject({
      id: "exec_1",
      errorCode: "execution_failed",
      capabilityCalls: [{ name: "slack.send", status: "error" }]
    });
    expect(requestUrl(fetcher.mock.calls[2]?.[0])).toBe(
      "https://api.example.com/v1/admin/execution-detail?id=exec_1"
    );

    const unsafeClient = createAdminApiClient({
      isDevelopment: false,
      demoMode: false,
      controlPlaneUrl: "https://api.example.com",
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(sessionPayload()))
        .mockResolvedValueOnce(
          Response.json({
            id: "exec_unsafe",
            pluginId: "plugin_invoice",
            hookName: "invoice.created",
            version: "1.2.3",
            status: "error",
            durationMs: 19,
            errorCode: "execution_failed",
            capabilityCalls: [],
            createdAt: "2026-07-19T00:00:00.000Z",
            error: "provider secret and customer payload"
          })
        )
    });
    await unsafeClient.resolveSession({ token: "secret-token" });
    await expect(unsafeClient.getExecutionDetail("exec_unsafe")).rejects.toEqual(
      new AdminApiError(502, "invalid_response", "control-plane returned an invalid response")
    );
  });

  it("submits a minimal approval decision and validates correlated audit evidence", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(sessionPayload()))
      .mockResolvedValueOnce(
        Response.json({
          approvalId: "approval_1",
          state: "approved",
          auditId: "approval_audit_1",
          decidedAt: "2026-07-20T00:00:00.000Z",
          installation: {
            id: "installation_1",
            versionId: "version_1",
            pluginKey: "invoice-notify",
            version: "1.0.0",
            enabled: true,
            priority: 20,
            revision: 0
          }
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
      client.decideApproval({
        approvalId: "approval_1",
        decision: "approved",
        reason: "validated"
      })
    ).resolves.toEqual({
      approvalId: "approval_1",
      state: "approved",
      auditId: "approval_audit_1",
      decidedAt: new Date("2026-07-20T00:00:00.000Z"),
      installation: {
        id: "installation_1",
        versionId: "version_1",
        pluginKey: "invoice-notify",
        version: "1.0.0",
        enabled: true,
        priority: 20,
        revision: 0
      }
    });
    const [url, init] = fetcher.mock.calls[1] ?? [];
    expect(requestUrl(url)).toBe("https://api.example.com/v1/admin/approval-decisions");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(init?.body).toBe(
      JSON.stringify({ approvalId: "approval_1", decision: "approved", reason: "validated" })
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
          priority: 10,
          revision: 0
        }
      ],
      nextCursor: "signed.cursor"
    },
    pluginVersions: { items: [] },
    approvals: { items: [] },
    executions: { items: [] },
    usage: { date: "2026-07-19", executions: 1, runtimeMs: 12 },
    schemaMigrations: [
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
    ]
  };
}

function sessionPayload(role: "manager" | "operator" = "manager") {
  return {
    subject: "ops-manager",
    role,
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
      { subject: "user", role: "super-admin", appId: "app_acme", tenantId: "tenant_acme" }
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

  it.each(["owner", "admin", "operator", "viewer", "tenant-admin", "manager"])(
    "accepts the supported %s session role",
    async (role) => {
      const payload = { subject: "user", role, appId: "app_acme", tenantId: "tenant_acme" };
      const client = createHttpAdminSessionClient({
        baseUrl: "https://api.example.com",
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload))
      });

      await expect(client.resolveSession({ token: "secret" })).resolves.toEqual(payload);
    }
  );
});
