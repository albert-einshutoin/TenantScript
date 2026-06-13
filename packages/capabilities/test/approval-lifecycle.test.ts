import { describe, expect, it, vi } from "vitest";
import {
  createApprovalLifecyclePlan,
  createApprovalsRequestProvider,
  expireApproval,
  type ApprovalRecord,
  type ApprovalWorkflowEngine
} from "../src/index.js";

const pendingApproval: ApprovalRecord = {
  id: "approval_1",
  role: "manager",
  subject: { invoiceId: "inv_1" },
  resumeHook: "onInvoiceApprovalDecided",
  state: "pending",
  expiresAt: new Date("2026-06-13T02:00:00.000Z"),
  createdAt: new Date("2026-06-13T01:00:00.000Z")
};

describe("approval lifecycle", () => {
  it("creates a notification, reminder, and expiration plan", () => {
    expect(createApprovalLifecyclePlan(pendingApproval)).toEqual({
      approvalId: "approval_1",
      notifyAt: new Date("2026-06-13T01:00:00.000Z"),
      reminderAt: new Date("2026-06-13T01:30:00.000Z"),
      expiresAt: new Date("2026-06-13T02:00:00.000Z")
    });
  });

  it("expires pending approvals at the deadline", () => {
    expect(expireApproval(pendingApproval, new Date("2026-06-13T02:00:00.000Z"))).toEqual({
      ...pendingApproval,
      state: "expired",
      updatedAt: new Date("2026-06-13T02:00:00.000Z")
    });
  });

  it("keeps pending approvals unchanged before the deadline", () => {
    expect(expireApproval(pendingApproval, new Date("2026-06-13T01:59:59.999Z"))).toBe(
      pendingApproval
    );
  });

  it("starts the workflow lifecycle after the approval is persisted", async () => {
    const calls: string[] = [];
    const workflow: ApprovalWorkflowEngine = {
      startApprovalLifecycle: vi.fn<ApprovalWorkflowEngine["startApprovalLifecycle"]>((plan) => {
        calls.push(`workflow:${plan.approvalId}`);
        return Promise.resolve();
      })
    };
    const provider = createApprovalsRequestProvider({
      store: {
        createApproval: (record) => {
          calls.push(`store:${record.id}`);
          return Promise.resolve(record);
        }
      },
      workflow,
      generateId: () => "approval_1",
      now: () => new Date("2026-06-13T01:00:00.000Z")
    });

    await expect(
      provider({
        role: "manager",
        subject: { invoiceId: "inv_1" },
        resumeHook: "onInvoiceApprovalDecided",
        expiresAt: "2026-06-13T02:00:00.000Z"
      })
    ).resolves.toEqual({ ok: true, approvalId: "approval_1", state: "pending" });

    expect(calls).toEqual(["store:approval_1", "workflow:approval_1"]);
    expect(workflow.startApprovalLifecycle).toHaveBeenCalledWith({
      approvalId: "approval_1",
      notifyAt: new Date("2026-06-13T01:00:00.000Z"),
      reminderAt: new Date("2026-06-13T01:30:00.000Z"),
      expiresAt: new Date("2026-06-13T02:00:00.000Z")
    });
  });
});
