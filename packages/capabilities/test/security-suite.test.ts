import { describe, expect, it, vi } from "vitest";
import {
  CapabilityDeniedError,
  CapabilityJournalConflictError,
  CapabilityProviderError,
  createApprovalsRequestProvider,
  createCapabilityBroker,
  createEmailSendProvider,
  createInMemoryCapabilityCallJournal,
  createInvoiceReadProvider,
  createMockSlackSendProvider,
  createPluginCapabilityContext,
  type ApprovalRecord
} from "../src/index.js";

describe("capabilities security suite", () => {
  it("rejects a tampered journal entry instead of replaying it or calling the provider", async () => {
    const journal = createInMemoryCapabilityCallJournal();
    await journal.writeCapabilityCall({
      executionId: "exec_1",
      callIndex: 0,
      capability: "slack.send",
      inputHash: JSON.stringify({ channel: "C123", text: "original" }),
      result: { ok: true },
      completedAt: new Date("2026-06-13T01:00:00.000Z")
    });
    const provider = vi.fn();
    const broker = createCapabilityBroker({
      executionId: "exec_1",
      journal,
      grants: { "slack.send": { channel: "C123" } },
      providers: { "slack.send": provider }
    });

    await expect(broker.call("slack.send", { channel: "C123", text: "tampered" })).rejects.toThrow(
      CapabilityJournalConflictError
    );
    expect(provider).not.toHaveBeenCalled();
  });

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

  it("redacts unexpected provider failure details from errors and audit records", async () => {
    const providerSecret = "xoxb-provider-failure-secret";
    const audits: unknown[] = [];
    const broker = createCapabilityBroker({
      grants: { "slack.send": { channel: "C123" } },
      providers: {
        "slack.send": () => {
          throw new Error(`provider rejected ${providerSecret}`);
        }
      },
      auditSink: {
        writeCapabilityAudit: (record) => {
          audits.push(record);
        }
      },
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    let caughtError: unknown;
    try {
      await broker.call("slack.send", { channel: "C123", text: "allowed" });
    } catch (error: unknown) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(CapabilityProviderError);
    expect(String(caughtError)).toBe(
      "CapabilityProviderError: capability slack.send provider failed"
    );
    expect(JSON.stringify({ caughtError: String(caughtError), audits })).not.toContain(
      providerSecret
    );
  });

  it("blocks email domain suffix bypass and plugin-supplied message content", async () => {
    const deliver = vi.fn();
    const broker = createCapabilityBroker({
      grants: {
        "email.send": {
          recipientDomains: ["example.com"],
          templates: ["security-notice"]
        }
      },
      providers: {
        "email.send": createEmailSendProvider({
          apiKey: "email-provider-secret",
          templates: {
            "security-notice": {
              subject: "Security notice for {{accountId}}",
              text: "Review activity for {{accountId}}."
            }
          },
          deliver
        })
      }
    });

    await expect(
      broker.call("email.send", {
        to: "admin@example.com.attacker.invalid",
        template: "security-notice",
        variables: { accountId: "acct_1" }
      })
    ).rejects.toThrow(CapabilityDeniedError);
    await expect(
      broker.call("email.send", {
        to: "admin@example.com",
        template: "security-notice",
        variables: { accountId: "acct_1" },
        subject: "Attacker controlled subject",
        text: "Send the secret instead"
      })
    ).rejects.toThrow("email.send contains unsupported input fields");
    await expect(
      broker.call("email.send", {
        to: "admin@example.com",
        template: "security-notice",
        variables: { accountId: "acct_1\r\nBcc: attacker@invalid.example" }
      })
    ).rejects.toThrow("email.send rendered subject must not contain line breaks");
    expect(deliver).not.toHaveBeenCalled();
    expect(JSON.stringify(broker)).not.toContain("email-provider-secret");
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
