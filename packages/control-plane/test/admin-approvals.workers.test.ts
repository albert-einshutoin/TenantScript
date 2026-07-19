import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1AdminApprovalDecisionStore, createD1ControlPlaneStore } from "../src/index.js";

const testEnv = env as unknown as {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  const store = createD1ControlPlaneStore(testEnv.DB);
  await store.createApp({ id: "app_1", name: "App 1" });
  await store.createApp({ id: "app_2", name: "App 2" });
  await store.createTenant({ id: "tenant_1", appId: "app_1", name: "Tenant 1" });
  await store.createTenant({ id: "tenant_2", appId: "app_2", name: "Tenant 2" });
  await store.createPlugin({ id: "plugin_1", appId: "app_1", key: "plugin-1" });
  await store.createPlugin({ id: "plugin_2", appId: "app_2", key: "plugin-2" });
  await store.createApproval(approval("approval_1", "tenant_1", "plugin_1"));
  await store.createApproval(approval("approval_2", "tenant_2", "plugin_2"));
});

describe("D1 Admin approval decisions", () => {
  it("atomically decides and appends identity-scoped audit evidence", async () => {
    const store = createD1AdminApprovalDecisionStore(testEnv.DB, {
      auditId: () => "approval_audit_1",
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    await expect(store.decide(request("approval_1", "approved"))).resolves.toEqual({
      approvalId: "approval_1",
      state: "approved",
      auditId: "approval_audit_1",
      decidedAt: "2026-07-20T00:00:00.000Z"
    });
    await expect(
      testEnv.DB.prepare("SELECT state, decided_by FROM approvals WHERE id = ?")
        .bind("approval_1")
        .first()
    ).resolves.toEqual({ state: "approved", decided_by: "manager-subject" });
    await expect(
      testEnv.DB.prepare(
        "SELECT approval_id, actor, decision FROM approval_audit_events WHERE id = ?"
      )
        .bind("approval_audit_1")
        .first()
    ).resolves.toEqual({
      approval_id: "approval_1",
      actor: "manager-subject",
      decision: "approved"
    });
  });

  it("rejects cross-tenant, viewer, expired, and duplicate decisions without audit", async () => {
    const store = createD1AdminApprovalDecisionStore(testEnv.DB, {
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });
    await expect(
      store.decide({ ...request("approval_2", "approved"), appId: "app_1", tenantId: "tenant_1" })
    ).rejects.toMatchObject({ code: "approval_not_found" });
    await expect(
      store.decide({ ...request("approval_1", "approved"), actorRole: "viewer" })
    ).rejects.toMatchObject({ code: "approval_role_forbidden" });

    await store.decide(request("approval_1", "rejected"));
    await expect(store.decide(request("approval_1", "approved"))).rejects.toMatchObject({
      code: "approval_already_decided"
    });
    await expect(
      testEnv.DB.prepare("SELECT COUNT(*) AS count FROM approval_audit_events").first()
    ).resolves.toEqual({ count: 1 });
  });
});

function request(approvalId: string, decision: "approved" | "rejected") {
  return {
    appId: "app_1",
    tenantId: "tenant_1",
    actor: "manager-subject",
    actorRole: "manager",
    approvalId,
    decision
  };
}

function approval(id: string, tenantId: string, pluginId: string) {
  return {
    id,
    tenantId,
    pluginId,
    role: "manager",
    subject: { secret: "must-not-enter-audit" },
    resumeHook: "approval.decided",
    state: "pending" as const,
    expiresAt: new Date("2026-07-21T00:00:00.000Z"),
    createdAt: new Date("2026-07-19T00:00:00.000Z")
  };
}
