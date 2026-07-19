import { describe, expect, it, vi } from "vitest";
import {
  createControlPlaneHttpHandler,
  createStaticTokenIdentityResolver,
  type AdminApprovalDecisionStore
} from "../src/index.js";

describe("Admin approval decision HTTP contract", () => {
  it("derives manager scope and returns correlated audit evidence", async () => {
    const store = decisionStore();
    const handler = createHandler(store);
    const response = await handler(decisionRequest("manager", {
      approvalId: "approval_1",
      decision: "approved",
      reason: "validated"
    }));

    expect(response.status).toBe(200);
    expect(store.decide).toHaveBeenCalledWith({
      appId: "app_1",
      tenantId: "tenant_1",
      actor: "manager-subject",
      actorRole: "manager",
      approvalId: "approval_1",
      decision: "approved",
      reason: "validated"
    });
    await expect(response.json()).resolves.toMatchObject({
      approvalId: "approval_1",
      state: "approved",
      auditId: "approval_audit_1"
    });
  });

  it("rejects viewers and self-asserted or ambiguous fields before storage", async () => {
    const store = decisionStore();
    const handler = createHandler(store);

    expect((await handler(decisionRequest("viewer", validBody()))).status).toBe(403);
    for (const body of [
      { ...validBody(), tenantId: "tenant_2" },
      { ...validBody(), actor: "attacker" },
      { ...validBody(), approvalId: "" },
      { ...validBody(), decision: "pending" },
      { ...validBody(), reason: "x".repeat(1001) }
    ]) {
      expect((await handler(decisionRequest("manager", body))).status).toBe(400);
    }
    expect(store.decide).not.toHaveBeenCalled();
  });
});

function createHandler(store: ReturnType<typeof decisionStore>) {
  return createControlPlaneHttpHandler({
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
    approvalDecisionStore: store,
    allowedOrigins: ["https://admin.example.com"]
  });
}

function decisionStore() {
  return {
    decide: vi.fn<AdminApprovalDecisionStore["decide"]>().mockResolvedValue({
      approvalId: "approval_1",
      state: "approved",
      auditId: "approval_audit_1",
      decidedAt: "2026-07-20T00:00:00.000Z"
    })
  } satisfies AdminApprovalDecisionStore;
}

function validBody() {
  return { approvalId: "approval_1", decision: "approved" };
}

function decisionRequest(token: string, body: Record<string, unknown>): Request {
  return new Request("https://api.example.com/v1/admin/approval-decisions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "https://admin.example.com",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}
