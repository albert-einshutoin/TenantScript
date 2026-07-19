import { describe, expect, it } from "vitest";
import {
  createControlPlaneApi,
  createControlPlaneHttpHandler,
  createDurableObjectDailyUsageCounter,
  createInMemoryDailyUsageCounter,
  createInMemoryExecutionLogStore,
  createStaticTokenIdentityResolver,
  type DailyUsageRecord,
  type ApprovalContinuationRequest,
  type ApprovalRecord,
  type ArtifactStore,
  type ContinuationRunner,
  type ControlPlaneStore
} from "../src/index.js";

describe("control-plane security suite", () => {
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
});

const noopArtifacts: ArtifactStore = {
  putArtifact: (hash) => Promise.resolve({ hash })
};

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
