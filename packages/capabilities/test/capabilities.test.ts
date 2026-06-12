import { describe, expect, it, vi } from "vitest";
import {
  CapabilityDeniedError,
  createApprovalsRequestProvider,
  createCapabilityBroker,
  createDurableObjectCapabilityCallJournal,
  createInMemoryCapabilityCallJournal,
  createMockSlackSendProvider,
  createPluginCapabilityContext,
  type ApprovalRecord,
  type CapabilityCallJournalEntry
} from "../src/index.js";

describe("createCapabilityBroker", () => {
  it("allows granted capability calls", async () => {
    const provider = vi.fn().mockResolvedValue({ ok: true });
    const broker = createCapabilityBroker({
      grants: { "slack.send": { channel: "C123" } },
      providers: { "slack.send": provider }
    });

    await expect(broker.call("slack.send", { channel: "C123", text: "hello" })).resolves.toEqual({
      ok: true
    });
    expect(provider).toHaveBeenCalledWith({ channel: "C123", text: "hello" });
  });

  it("replays journaled capability results for the same execution retry", async () => {
    const deliver = vi.fn();
    const journal = createInMemoryCapabilityCallJournal();
    const createBrokerForRetry = () =>
      createCapabilityBroker({
        executionId: "exec_retry_1",
        journal,
        grants: { "slack.send": { channel: "C123" } },
        providers: {
          "slack.send": createMockSlackSendProvider({
            token: "xoxb-secret-token",
            deliver
          })
        }
      });

    const first = await createBrokerForRetry().call("slack.send", {
      channel: "C123",
      text: "hello"
    });
    const retry = await createBrokerForRetry().call("slack.send", {
      channel: "C123",
      text: "hello"
    });

    expect(retry).toEqual(first);
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith({ channel: "C123", text: "hello" });
  });

  it("stores journal entries through Durable Object compatible storage", async () => {
    const entries = new Map<string, CapabilityCallJournalEntry>();
    const journal = createDurableObjectCapabilityCallJournal({
      get: (key) => entries.get(key),
      put: (key, entry) => {
        entries.set(key, entry);
      }
    });

    await expect(
      journal.writeCapabilityCall({
        executionId: "exec_1",
        callIndex: 0,
        capability: "slack.send",
        inputHash: "hash_1",
        result: { ok: true },
        completedAt: new Date("2026-06-13T01:00:00.000Z")
      })
    ).resolves.toMatchObject({ executionId: "exec_1", callIndex: 0 });
    await expect(
      journal.readCapabilityCall({ executionId: "exec_1", callIndex: 0 })
    ).resolves.toMatchObject({ capability: "slack.send", result: { ok: true } });
  });

  it("rejects ungranted capabilities", async () => {
    const broker = createCapabilityBroker({
      grants: {},
      providers: { "slack.send": vi.fn() }
    });

    await expect(broker.call("slack.send", { channel: "C123", text: "hello" })).rejects.toThrow(
      CapabilityDeniedError
    );
  });

  it("rejects calls outside the granted channel scope", async () => {
    const broker = createCapabilityBroker({
      grants: { "slack.send": { channel: "C123" } },
      providers: { "slack.send": vi.fn() }
    });

    await expect(broker.call("slack.send", { channel: "C999", text: "hello" })).rejects.toThrow(
      "slack.send channel C999 is outside granted scope"
    );
  });

  it("creates an approval and lets the handler finish without suspension", async () => {
    const approvals: ApprovalRecord[] = [];
    const broker = createCapabilityBroker({
      grants: { "approvals.request": { roles: ["manager"] } },
      providers: {
        "approvals.request": createApprovalsRequestProvider({
          store: {
            createApproval: (record) => {
              approvals.push(record);
              return Promise.resolve(record);
            }
          },
          generateId: () => "approval_1",
          now: () => new Date("2026-06-13T01:00:00.000Z")
        })
      }
    });
    const context = createPluginCapabilityContext(broker);

    await expect(
      (async () => {
        const result = await context.capability("approvals.request", {
          role: "manager",
          subject: { invoiceId: "inv_1", amountCents: 150_000 },
          resumeHook: "onInvoiceApprovalDecided",
          expiresAt: "2026-06-14T01:00:00.000Z"
        });
        return { result, handlerCompleted: true };
      })()
    ).resolves.toEqual({
      result: { ok: true, approvalId: "approval_1", state: "pending" },
      handlerCompleted: true
    });
    expect(approvals).toEqual([
      {
        id: "approval_1",
        role: "manager",
        subject: { invoiceId: "inv_1", amountCents: 150_000 },
        resumeHook: "onInvoiceApprovalDecided",
        state: "pending",
        expiresAt: new Date("2026-06-14T01:00:00.000Z"),
        createdAt: new Date("2026-06-13T01:00:00.000Z")
      }
    ]);
  });

  it("rejects approvals requested for roles outside the grant", async () => {
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
        role: "admin",
        subject: { invoiceId: "inv_1" },
        resumeHook: "onInvoiceApprovalDecided",
        expiresAt: "2026-06-14T01:00:00.000Z"
      })
    ).rejects.toThrow("approvals.request role admin is outside granted scope");
    expect(store.createApproval).not.toHaveBeenCalled();
  });

  it("rejects malformed approval requests", async () => {
    const broker = createCapabilityBroker({
      grants: { "approvals.request": { roles: ["manager"] } },
      providers: {
        "approvals.request": createApprovalsRequestProvider({
          store: { createApproval: vi.fn() },
          generateId: () => "approval_1",
          now: () => new Date("2026-06-13T01:00:00.000Z")
        })
      }
    });

    await expect(
      broker.call("approvals.request", {
        role: "manager",
        subject: { invoiceId: "inv_1" },
        expiresAt: "2026-06-14T01:00:00.000Z"
      })
    ).rejects.toThrow("approvals.request requires role, subject, resumeHook, and expiresAt");
  });
});

describe("createMockSlackSendProvider", () => {
  it("delivers payloads without exposing the raw token to plugin context", async () => {
    const deliver = vi.fn();
    const broker = createCapabilityBroker({
      grants: { "slack.send": { channel: "C123" } },
      providers: {
        "slack.send": createMockSlackSendProvider({
          token: "xoxb-secret-token",
          deliver
        })
      }
    });
    const context = createPluginCapabilityContext(broker);

    await expect(
      context.capability("slack.send", { channel: "C123", text: "hello" })
    ).resolves.toEqual({
      ok: true,
      provider: "mock-slack"
    });

    expect(deliver).toHaveBeenCalledWith({ channel: "C123", text: "hello" });
    expect(JSON.stringify(context)).not.toContain("xoxb-secret-token");
  });

  it("rejects malformed Slack payloads", async () => {
    const broker = createCapabilityBroker({
      grants: { "slack.send": { channel: "C123" } },
      providers: {
        "slack.send": createMockSlackSendProvider({
          token: "xoxb-secret-token",
          deliver: vi.fn()
        })
      }
    });

    await expect(broker.call("slack.send", { channel: "C123" })).rejects.toThrow(
      "slack.send requires channel and text"
    );
  });
});
