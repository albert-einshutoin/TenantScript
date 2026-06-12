import { describe, expect, it } from "vitest";
import {
  createControlPlaneApi,
  createInMemoryExecutionLogStore,
  createStaticTokenIdentityResolver,
  type ApprovalRecord,
  type ArtifactStore,
  type ControlPlaneStore
} from "../src/index.js";

describe("control-plane security suite", () => {
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
