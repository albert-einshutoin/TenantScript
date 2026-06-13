import { describe, expect, it, vi } from "vitest";
import {
  CapabilityDeniedError,
  createApprovalsRequestProvider,
  createCapabilityBroker,
  createInvoiceReadProvider,
  createMockSlackSendProvider,
  createPluginCapabilityContext,
  type ApprovalRecord
} from "../src/index.js";

describe("capabilities security suite", () => {
  it("denies ungranted capability calls", async () => {
    const broker = createCapabilityBroker({
      grants: {},
      providers: { "slack.send": vi.fn() }
    });

    await expect(broker.call("slack.send", { channel: "C123", text: "hello" })).rejects.toThrow(
      CapabilityDeniedError
    );
  });

  it("denies Slack sends outside the granted channel scope", async () => {
    const broker = createCapabilityBroker({
      grants: { "slack.send": { channel: "C123" } },
      providers: { "slack.send": vi.fn() }
    });

    await expect(broker.call("slack.send", { channel: "C999", text: "hello" })).rejects.toThrow(
      "slack.send channel C999 is outside granted scope"
    );
  });

  it("keeps raw provider secrets outside the plugin capability context", async () => {
    const broker = createCapabilityBroker({
      grants: { "slack.send": { channel: "C123" } },
      providers: {
        "slack.send": createMockSlackSendProvider({
          token: "xoxb-raw-secret",
          deliver: vi.fn()
        })
      }
    });
    const context = createPluginCapabilityContext(broker);

    expect(JSON.stringify(context)).not.toContain("xoxb-raw-secret");
    await expect(
      context.capability("slack.send", { channel: "C123", text: "allowed" })
    ).resolves.toEqual({ ok: true, provider: "mock-slack" });
  });

  it("denies approval requests outside the granted role scope", async () => {
    const store = { createApproval: vi.fn() };
    const broker = createCapabilityBroker({
      grants: { "approvals.request": { roles: ["manager"] } },
      providers: {
        "approvals.request": createApprovalsRequestProvider({
          store,
          generateId: () => "approval_1",
          now: () => new Date("2026-06-13T01:00:00.000Z")
        })
      }
    });

    await expect(
      broker.call("approvals.request", {
        role: "viewer",
        subject: { invoiceId: "inv_1" },
        resumeHook: "onInvoiceApprovalDecided",
        expiresAt: "2026-06-14T01:00:00.000Z"
      })
    ).rejects.toThrow("approvals.request role viewer is outside granted scope");
    expect(store.createApproval).not.toHaveBeenCalled();
  });

  it("denies approval requests that spoof an ungranted resume hook", async () => {
    const store = {
      createApproval: vi.fn((record: ApprovalRecord) => record)
    };
    const broker = createCapabilityBroker({
      grants: {
        "approvals.request": {
          roles: ["manager"],
          resumeHooks: ["onInvoiceApprovalDecided"]
        }
      },
      providers: {
        "approvals.request": createApprovalsRequestProvider({
          store,
          generateId: () => "approval_1",
          now: () => new Date("2026-06-13T01:00:00.000Z")
        })
      }
    });

    await expect(
      broker.call("approvals.request", {
        role: "manager",
        subject: { invoiceId: "inv_1" },
        resumeHook: "exfiltrateApprovalDecision",
        expiresAt: "2026-06-14T01:00:00.000Z"
      })
    ).rejects.toThrow(
      "approvals.request resumeHook exfiltrateApprovalDecision is outside granted scope"
    );
    expect(store.createApproval).not.toHaveBeenCalled();
  });

  it("denies invoice.read requests that spoof another tenant", async () => {
    const store = {
      findInvoice: vi.fn()
    };
    const broker = createCapabilityBroker({
      grants: { "invoice.read": { fields: ["id", "amountCents"] } },
      providers: {
        "invoice.read": createInvoiceReadProvider({
          tenantId: "tenant_1",
          store
        })
      }
    });

    await expect(
      broker.call("invoice.read", { tenantId: "tenant_2", invoiceId: "inv_2" })
    ).rejects.toThrow("invoice.read tenant tenant_2 is outside tenant scope");
    expect(store.findInvoice).not.toHaveBeenCalled();
  });

  it("denies invoice.read records returned outside the bound tenant", async () => {
    const broker = createCapabilityBroker({
      grants: { "invoice.read": { fields: ["id", "amountCents"] } },
      providers: {
        "invoice.read": createInvoiceReadProvider({
          tenantId: "tenant_1",
          store: {
            findInvoice: () => ({
              tenantId: "tenant_2",
              id: "inv_2",
              amountCents: 90_000
            })
          }
        })
      }
    });

    await expect(broker.call("invoice.read", { invoiceId: "inv_2" })).rejects.toThrow(
      "invoice.read invoice inv_2 is outside tenant scope"
    );
  });
});
