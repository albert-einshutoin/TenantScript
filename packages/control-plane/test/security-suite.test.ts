import { describe, expect, it, vi } from "vitest";
import {
  createAnalyticsEngineUsageSink,
  createAdminCursorCodec,
  createControlPlaneApi,
  createControlPlaneHttpHandler,
  createDurableObjectDailyUsageCounter,
  createInMemoryDailyUsageCounter,
  createInMemoryExecutionLogStore,
  createStaticTokenIdentityResolver,
  type AdminDashboardStore,
  type AdminExecutionDetailStore,
  type AdminInstallationDetailStore,
  type AdminInstallFlowStore,
  type AdminRollbackStore,
  type DailyUsageRecord,
  type AnalyticsEngineDataPoint,
  type ApprovalContinuationRequest,
  type ApprovalRecord,
  type ArtifactStore,
  type ContinuationRunner,
  type ControlPlaneStore
} from "../src/index.js";

describe("control-plane security suite", () => {
  it("writes only fixed billing fields and excludes payload, config, and secrets from usage data", async () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const sink = createAnalyticsEngineUsageSink({
      writeDataPoint: (point) => {
        if (point !== undefined) points.push(point);
      }
    });
    const hostileEvent = {
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      hookType: "event" as const,
      status: "success" as const,
      executions: 1 as const,
      cpuMs: 5,
      subrequests: 1,
      workflowRuns: 0,
      payload: "customer-payload",
      config: "private-config",
      secret: "provider-secret"
    };

    await sink.writeUsage(hostileEvent);

    expect(points).toEqual([
      {
        indexes: ["tenant_1:plugin_1"],
        blobs: ["tenant_1", "plugin_1", "event", "success"],
        doubles: [1, 5, 1, 0]
      }
    ]);
    expect(JSON.stringify(points)).not.toMatch(/customer-payload|private-config|provider-secret/);
  });

  it("keeps rollback scope identity-derived and denies viewer or forged commands", async () => {
    const rollbackStore = {
      rollback: vi.fn<AdminRollbackStore["rollback"]>().mockResolvedValue({
        outcome: "rolled_back",
        installationId: "inst_1",
        pluginKey: "safe-plugin",
        fromVersion: "2.0.0",
        toVersion: "1.0.0",
        revision: 1,
        auditId: "audit_1",
        completedAt: "2026-07-19T17:00:00.000Z"
      })
    } satisfies AdminRollbackStore;
    const handler = createControlPlaneHttpHandler({
      identityResolver: createStaticTokenIdentityResolver({
        manager: { subject: "manager", role: "manager", appId: "app_1", tenantId: "tenant_1" },
        viewer: { subject: "viewer", role: "viewer", appId: "app_1", tenantId: "tenant_1" }
      }),
      rollbackStore,
      adminMutationRateLimiter: allowAdminMutation,
      allowedOrigins: ["https://admin.example.com"]
    });
    const valid = { installationId: "inst_1", targetVersionId: "version_1", expectedRevision: 0 };

    expect((await handler(rollbackRequest("viewer", valid))).status).toBe(403);
    expect(
      (
        await handler(
          rollbackRequest("manager", { ...valid, tenantId: "tenant_2", actor: "attacker" })
        )
      ).status
    ).toBe(400);
    expect(rollbackStore.rollback).not.toHaveBeenCalled();

    expect((await handler(rollbackRequest("manager", valid))).status).toBe(200);
    expect(rollbackStore.rollback).toHaveBeenCalledWith({
      appId: "app_1",
      tenantId: "tenant_1",
      actor: "manager",
      idempotencyKey: "rollback-security-http-key-0001",
      ...valid
    });
  });
  it("allows only explicitly configured Admin UI origins", async () => {
    const handler = createControlPlaneHttpHandler({
      identityResolver: createStaticTokenIdentityResolver({}),
      allowedOrigins: ["https://admin.example.com"]
    });

    const allowed = await handler(
      new Request("https://api.example.com/v1/session", {
        method: "OPTIONS",
        headers: {
          Origin: "https://admin.example.com",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Authorization"
        }
      })
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://admin.example.com");
    expect(allowed.headers.get("access-control-allow-headers")).toContain("Authorization");

    const missingOrigin = await handler(
      new Request("https://api.example.com/v1/session", {
        method: "OPTIONS",
        headers: {
          "Access-Control-Request-Method": "GET"
        }
      })
    );
    expect(missingOrigin.status).toBe(403);

    const denied = await handler(
      new Request("https://api.example.com/v1/session", {
        headers: {
          Authorization: "Bearer secret-token",
          Origin: "https://attacker.example"
        }
      })
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(await denied.text()).not.toContain("secret-token");

    expect(() =>
      createControlPlaneHttpHandler({
        identityResolver: createStaticTokenIdentityResolver({}),
        allowedOrigins: ["*"]
      })
    ).toThrow("wildcard origins are not allowed");
  });

  it("does not return another tenant's execution logs when scoped by tenant", () => {
    const store = createInMemoryExecutionLogStore();

    store.writeExecution({
      id: "exec_tenant_1",
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      hookName: "invoice.created",
      version: "1.0.0",
      status: "success",
      durationMs: 12,
      capabilityCalls: [],
      createdAt: new Date("2026-06-12T00:00:00.000Z")
    });
    store.writeExecution({
      id: "exec_tenant_2",
      tenantId: "tenant_2",
      pluginId: "plugin_1",
      hookName: "invoice.created",
      version: "1.0.0",
      status: "error",
      durationMs: 10,
      error: "should not leak",
      capabilityCalls: [],
      createdAt: new Date("2026-06-12T00:00:01.000Z")
    });

    expect(store.searchExecutions({ tenantId: "tenant_1" }).map((record) => record.id)).toEqual([
      "exec_tenant_1"
    ]);
  });

  it("derives dashboard scope from identity and rejects cursor replay across tenants", async () => {
    const readSection = vi.fn<AdminDashboardStore["readSection"]>().mockImplementation((request) =>
      Promise.resolve(
        request.section === "installations"
          ? {
              section: "installations",
              items: [
                {
                  id: "inst_safe",
                  pluginKey: "safe-plugin",
                  version: "1.0.0",
                  enabled: true,
                  priority: 10,
                  revision: 0
                }
              ],
              nextPosition: "inst_safe"
            }
          : { section: request.section, items: [] }
      )
    );
    const dashboardStore: AdminDashboardStore = {
      readSection,
      readUsageSummary: () => Promise.resolve({ date: "2026-07-19", executions: 1, runtimeMs: 12 })
    };
    const handler = createControlPlaneHttpHandler({
      identityResolver: createStaticTokenIdentityResolver({
        tenant1: {
          subject: "user_1",
          role: "manager",
          appId: "app_1",
          tenantId: "tenant_1"
        },
        tenant2: {
          subject: "user_2",
          role: "viewer",
          appId: "app_2",
          tenantId: "tenant_2"
        }
      }),
      dashboardStore,
      cursorCodec: createAdminCursorCodec("security-suite-dashboard-cursor-secret-32-bytes"),
      allowedOrigins: ["https://admin.example.com"]
    });
    const initial = await handler(
      dashboardRequest(
        "tenant1",
        "https://api.example.com/v1/admin/dashboard?appId=app_2&tenantId=tenant_2"
      )
    );
    const body: {
      installations: { nextCursor: string };
    } = await initial.json();

    expect(initial.status).toBe(200);
    expect(readSection).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "app_1", tenantId: "tenant_1" })
    );

    const replay = await handler(
      dashboardRequest(
        "tenant2",
        `https://api.example.com/v1/admin/dashboard/installations?cursor=${encodeURIComponent(body.installations.nextCursor)}`
      )
    );
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: { code: "invalid_cursor" } });
  });

  it("binds execution filters to cursors and keeps detail lookup in identity scope", async () => {
    const dashboardStore: AdminDashboardStore = {
      readSection: vi.fn<AdminDashboardStore["readSection"]>().mockResolvedValue({
        section: "executions",
        items: [],
        nextPosition: "2026-07-19T00:00:00.000Z\texec_1"
      }),
      readUsageSummary: () => Promise.resolve({ date: "2026-07-19", executions: 0, runtimeMs: 0 })
    };
    const executionDetailStore = {
      readExecution: vi
        .fn<AdminExecutionDetailStore["readExecution"]>()
        .mockImplementation(({ tenantId, id }) =>
          Promise.resolve(
            tenantId === "tenant_1" && id === "exec_1"
              ? {
                  id,
                  pluginId: "plugin_1",
                  hookName: "invoice.created",
                  version: "1.0.0",
                  status: "error",
                  durationMs: 12,
                  errorCode: "execution_failed",
                  capabilityCalls: [{ name: "slack.send", status: "denied" }],
                  createdAt: "2026-07-19T00:00:00.000Z"
                }
              : null
          )
        )
    } satisfies AdminExecutionDetailStore;
    const handler = createControlPlaneHttpHandler({
      identityResolver: createStaticTokenIdentityResolver({
        tenant1: { subject: "user_1", role: "viewer", appId: "app_1", tenantId: "tenant_1" },
        tenant2: { subject: "user_2", role: "viewer", appId: "app_2", tenantId: "tenant_2" }
      }),
      dashboardStore,
      executionDetailStore,
      cursorCodec: createAdminCursorCodec("security-execution-search-secret-32-bytes"),
      allowedOrigins: ["https://admin.example.com"]
    });

    const first = await handler(
      dashboardRequest(
        "tenant1",
        "https://api.example.com/v1/admin/dashboard/executions?pluginId=plugin_1&status=error"
      )
    );
    const firstBody: { nextCursor: string } = await first.json();
    const changedFilter = await handler(
      dashboardRequest(
        "tenant1",
        `https://api.example.com/v1/admin/dashboard/executions?pluginId=plugin_1&status=success&cursor=${encodeURIComponent(firstBody.nextCursor)}`
      )
    );
    expect(changedFilter.status).toBe(400);
    await expect(changedFilter.json()).resolves.toMatchObject({
      error: { code: "invalid_cursor" }
    });

    const outsideScope = await handler(
      dashboardRequest("tenant2", "https://api.example.com/v1/admin/execution-detail?id=exec_1")
    );
    expect(outsideScope.status).toBe(404);
    expect(executionDetailStore.readExecution).toHaveBeenLastCalledWith({
      appId: "app_2",
      tenantId: "tenant_2",
      id: "exec_1"
    });
    expect(await outsideScope.text()).not.toContain("slack.send");
  });

  it("allows only token roles that match the approval role and ignores body role claims", async () => {
    const approval = {
      id: "approval_1",
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      role: "manager",
      subject: { invoiceId: "inv_1" },
      resumeHook: "onInvoiceApprovalDecided",
      state: "pending",
      expiresAt: new Date("2026-06-14T01:00:00.000Z"),
      createdAt: new Date("2026-06-13T01:00:00.000Z")
    } satisfies ApprovalRecord;
    const store = createDecisionStore(approval);
    const api = createControlPlaneApi({
      store,
      artifacts: noopArtifacts,
      identityResolver: createStaticTokenIdentityResolver({
        "manager-token": { subject: "user_manager", role: "manager" },
        "viewer-token": { subject: "user_viewer", role: "viewer" }
      })
    });

    await expect(
      api.decideApproval({
        id: "approval_1",
        tenantId: "tenant_1",
        decision: "approved",
        actor: "manager@example.com",
        auditId: "audit_1",
        authToken: "manager-token"
      })
    ).resolves.toMatchObject({ state: "approved" });

    const viewerStore = createDecisionStore(approval);
    const viewerApi = createControlPlaneApi({
      store: viewerStore,
      artifacts: noopArtifacts,
      identityResolver: createStaticTokenIdentityResolver({
        "viewer-token": { subject: "user_viewer", role: "viewer" }
      })
    });
    await expect(
      viewerApi.decideApproval({
        id: "approval_1",
        tenantId: "tenant_1",
        decision: "approved",
        actor: "viewer@example.com",
        auditId: "audit_2",
        authToken: "viewer-token",
        role: "manager"
      })
    ).rejects.toMatchObject({ status: 403, code: "approval_role_forbidden" });
  });

  it("rejects approval decisions scoped to another tenant", async () => {
    const approval = {
      id: "approval_1",
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      role: "manager",
      subject: { invoiceId: "inv_1" },
      resumeHook: "onInvoiceApprovalDecided",
      state: "pending",
      expiresAt: new Date("2026-06-14T01:00:00.000Z"),
      createdAt: new Date("2026-06-13T01:00:00.000Z")
    } satisfies ApprovalRecord;
    const api = createControlPlaneApi({
      store: createDecisionStore(approval),
      artifacts: noopArtifacts,
      identityResolver: createStaticTokenIdentityResolver({
        "manager-token": { subject: "user_manager", role: "manager" }
      })
    });

    await expect(
      api.decideApproval({
        id: "approval_1",
        tenantId: "tenant_2",
        decision: "approved",
        actor: "manager@example.com",
        auditId: "audit_cross_tenant",
        authToken: "manager-token"
      })
    ).rejects.toMatchObject({ status: 404, code: "approval_not_found" });
  });

  it("does not run a resume hook spoofed on the decision request body", async () => {
    const approval = {
      id: "approval_1",
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      role: "manager",
      subject: { invoiceId: "inv_1" },
      resumeHook: "onInvoiceApprovalDecided",
      state: "pending",
      expiresAt: new Date("2026-06-14T01:00:00.000Z"),
      createdAt: new Date("2026-06-13T01:00:00.000Z")
    } satisfies ApprovalRecord;
    const continuationCalls: ApprovalContinuationRequest[] = [];
    const continuationRunner: ContinuationRunner = {
      runApprovalContinuation: (request) => {
        continuationCalls.push(request);
        return Promise.resolve({
          id: "exec_resume_1",
          tenantId: request.approval.tenantId,
          pluginId: request.approval.pluginId,
          hookName: request.approval.resumeHook,
          version: "1.0.0",
          status: "success",
          durationMs: 1,
          capabilityCalls: [],
          createdAt: request.decidedAt
        });
      }
    };
    const api = createControlPlaneApi({
      store: createDecisionStore(approval),
      artifacts: noopArtifacts,
      continuationRunner,
      identityResolver: createStaticTokenIdentityResolver({
        "manager-token": { subject: "user_manager", role: "manager" }
      })
    });
    const forgedRequest = {
      id: "approval_1",
      tenantId: "tenant_1",
      decision: "approved",
      actor: "manager@example.com",
      auditId: "audit_1",
      authToken: "manager-token",
      resumeHook: "exfiltrateApprovalDecision"
    } as Parameters<typeof api.decideApproval>[0] & { resumeHook: string };

    await expect(api.decideApproval(forgedRequest)).resolves.toMatchObject({
      state: "approved"
    });

    expect(continuationCalls).toHaveLength(1);
    expect(continuationCalls[0]?.approval.resumeHook).toBe("onInvoiceApprovalDecided");
    expect(JSON.stringify(continuationCalls)).not.toContain("exfiltrateApprovalDecision");
  });

  it("serializes concurrent usage increments so budget counters cannot be raced", async () => {
    const counter = createInMemoryDailyUsageCounter();

    await Promise.all(
      Array.from({ length: 50 }, () =>
        counter.recordExecution({
          tenantId: "tenant_1",
          pluginId: "plugin_1",
          cpuMs: 2,
          at: new Date("2026-06-13T01:00:00.000Z")
        })
      )
    );

    await expect(
      counter.getDailyUsage({
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        at: new Date("2026-06-13T23:00:00.000Z")
      })
    ).resolves.toMatchObject({ executions: 50, cpuMs: 100 });
  });

  it("keeps durable usage storage across counter reinitialization", async () => {
    const records = new Map<string, DailyUsageRecord>();
    const storage = {
      get: (key: string) => records.get(key),
      put: (key: string, record: DailyUsageRecord) => {
        records.set(key, record);
      }
    };

    await createDurableObjectDailyUsageCounter(storage).recordExecution({
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      cpuMs: 12,
      at: new Date("2026-06-13T01:00:00.000Z")
    });

    await expect(
      createDurableObjectDailyUsageCounter(storage).getDailyUsage({
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        at: new Date("2026-06-13T02:00:00.000Z")
      })
    ).resolves.toMatchObject({ executions: 1, cpuMs: 12 });
  });

  it("rejects negative cpuMs usage that would reduce budget counters", async () => {
    await expect(
      createInMemoryDailyUsageCounter().recordExecution({
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        cpuMs: -1,
        at: new Date("2026-06-13T01:00:00.000Z")
      })
    ).rejects.toThrow("cpuMs must be a non-negative finite number");
  });

  it("does not let an installation permission review cross an identity tenant boundary", async () => {
    const detailStore = {
      readInstallation: vi
        .fn<AdminInstallationDetailStore["readInstallation"]>()
        .mockResolvedValue(null)
    } satisfies AdminInstallationDetailStore;
    const handler = createControlPlaneHttpHandler({
      identityResolver: createStaticTokenIdentityResolver({
        viewer: { subject: "viewer", role: "viewer", appId: "app_1", tenantId: "tenant_1" }
      }),
      installationDetailStore: detailStore,
      allowedOrigins: ["https://admin.example.com"]
    });
    const response = await handler(
      new Request(
        "https://api.example.com/v1/admin/installation-review?id=inst_tenant_2&tenantId=tenant_2",
        {
          headers: { Authorization: "Bearer viewer", Origin: "https://admin.example.com" }
        }
      )
    );

    expect(response.status).toBe(404);
    expect(detailStore.readInstallation).toHaveBeenCalledWith({
      appId: "app_1",
      tenantId: "tenant_1",
      id: "inst_tenant_2"
    });
    await expect(response.json()).resolves.toEqual({
      error: { code: "installation_not_found", message: "installation not found" }
    });
  });

  it("derives install scope from identity and rejects viewer or self-asserted grant escalation", async () => {
    const installFlowStore = {
      readVersion: vi.fn<AdminInstallFlowStore["readVersion"]>(),
      install: vi.fn<AdminInstallFlowStore["install"]>().mockResolvedValue({
        id: "installation_new",
        versionId: "version_1",
        pluginKey: "invoice-notify",
        version: "1.0.0",
        enabled: false,
        priority: 10,
        revision: 0
      })
    } satisfies AdminInstallFlowStore;
    const handler = createControlPlaneHttpHandler({
      identityResolver: createStaticTokenIdentityResolver({
        manager: {
          subject: "manager-subject",
          role: "manager",
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
      installFlowStore,
      adminMutationRateLimiter: allowAdminMutation,
      allowedOrigins: ["https://admin.example.com"]
    });
    const validBody = {
      versionId: "version_1",
      config: {},
      confirmedCapabilities: ["slack.send"],
      enabled: false,
      priority: 10
    };
    const viewer = await handler(installRequest("viewer", validBody));
    expect(viewer.status).toBe(403);

    const forged = await handler(
      installRequest("manager", {
        ...validBody,
        tenantId: "tenant_2",
        grants: { "slack.send": { channel: "attacker-controlled" } }
      })
    );
    expect(forged.status).toBe(400);
    expect(installFlowStore.install).not.toHaveBeenCalled();

    const valid = await handler(installRequest("manager", validBody));
    expect(valid.status).toBe(201);
    expect(installFlowStore.install).toHaveBeenCalledWith({
      appId: "app_1",
      tenantId: "tenant_1",
      actor: "manager-subject",
      idempotencyKey: "install-security-http-key-0001",
      ...validBody
    });
  });
});

const allowAdminMutation = {
  reserve: () => Promise.resolve({ allowed: true as const, remaining: 999 })
};

const noopArtifacts: ArtifactStore = {
  putArtifact: (hash) => Promise.resolve({ hash })
};

function dashboardRequest(token: string, url: string): Request {
  return new Request(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "https://admin.example.com"
    }
  });
}

function installRequest(token: string, body: Record<string, unknown>): Request {
  return new Request("https://api.example.com/v1/admin/installations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "https://admin.example.com",
      "Content-Type": "application/json",
      "Idempotency-Key": "install-security-http-key-0001"
    },
    body: JSON.stringify(body)
  });
}

function rollbackRequest(token: string, body: Record<string, unknown>): Request {
  return new Request("https://api.example.com/v1/admin/rollbacks", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "https://admin.example.com",
      "Content-Type": "application/json",
      "Idempotency-Key": "rollback-security-http-key-0001"
    },
    body: JSON.stringify(body)
  });
}

function createDecisionStore(initialApproval: ApprovalRecord): ControlPlaneStore {
  let approval = initialApproval;

  return {
    createApp: (record) => Promise.resolve(record),
    findAppById: () => Promise.resolve(null),
    createTenant: (record) => Promise.resolve(record),
    findTenantById: () => Promise.resolve(null),
    createPlugin: (record) => Promise.resolve(record),
    findPluginByKey: () => Promise.resolve(null),
    createPluginVersion: (record) => Promise.resolve(record),
    findPluginVersionById: () => Promise.resolve(null),
    findPluginVersion: () => Promise.resolve(null),
    listPluginVersions: () => Promise.resolve([]),
    createInstallation: (record) => Promise.resolve(record),
    findInstallationById: () => Promise.resolve(null),
    updateInstallationConfig: () => Promise.reject(new Error("unused updateInstallationConfig")),
    setInstallationEnabled: () => Promise.reject(new Error("unused setInstallationEnabled")),
    updateInstallationPriority: () =>
      Promise.reject(new Error("unused updateInstallationPriority")),
    updateInstallationVersion: () => Promise.reject(new Error("unused updateInstallationVersion")),
    createApproval: (record) => Promise.resolve(record),
    findApprovalById: (id) => Promise.resolve(id === approval.id ? approval : null),
    decideApproval: (request) => {
      approval = {
        ...approval,
        state: request.decision,
        decidedBy: request.decidedBy,
        ...(request.decisionReason === undefined ? {} : { decisionReason: request.decisionReason }),
        decidedAt: request.decidedAt
      };
      return Promise.resolve(approval);
    },
    writeExecution: (record) => Promise.resolve(record)
  };
}
