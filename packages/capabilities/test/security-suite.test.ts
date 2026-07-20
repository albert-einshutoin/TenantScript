import { describe, expect, it, vi } from "vitest";
import {
  CapabilityDeniedError,
  CapabilityJournalConflictError,
  CapabilityProviderError,
  createApprovalsRequestProvider,
  createCapabilityBroker,
  createEmailSendProvider,
  createHttpFetchProvider,
  createInMemoryCapabilityCallJournal,
  createInvoiceReadProvider,
  createInMemoryKvStateStorage,
  createKvStateProvider,
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

  it("blocks HTTP redirect allowlist bypass before credentials reach the destination", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" }
      })
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: "https://attacker.example.net/collect" }
      });
    const broker = createCapabilityBroker({
      grants: {
        "http.fetch": {
          origins: ["https://api.example.com"],
          methods: ["GET"]
        }
      },
      providers: {
        "http.fetch": createHttpFetchProvider({
          allowedOrigins: ["https://api.example.com"],
          allowedMethods: ["GET"],
          credentials: {
            "https://api.example.com": {
              name: "authorization",
              value: "Bearer redirect-secret"
            }
          },
          transport
        })
      }
    });

    await expect(
      broker.call("http.fetch", {
        url: "https://api.example.com/start",
        method: "GET"
      })
    ).rejects.toThrow("http.fetch destination http://169.254.169.254 is not public");
    await expect(
      broker.call("http.fetch", {
        url: "https://api.example.com/start",
        method: "GET"
      })
    ).rejects.toThrow("http.fetch origin https://attacker.example.net is outside granted scope");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(transport.mock.calls[0])).toContain("redirect-secret");
  });

  it("rejects plugin-controlled credential and routing headers before HTTP transport", async () => {
    const transport = vi.fn();
    const broker = createCapabilityBroker({
      grants: {
        "http.fetch": {
          origins: ["https://api.example.com"],
          methods: ["POST"],
          requestHeaders: ["content-type"]
        }
      },
      providers: {
        "http.fetch": createHttpFetchProvider({
          allowedOrigins: ["https://api.example.com"],
          allowedMethods: ["POST"],
          transport
        })
      }
    });

    await expect(
      broker.call("http.fetch", {
        url: "https://api.example.com/v1/jobs",
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer attacker-controlled"
        },
        body: "{}"
      })
    ).rejects.toThrow("http.fetch header authorization cannot be supplied by the plugin");
    await expect(
      broker.call("http.fetch", {
        url: "https://api.example.com/v1/jobs",
        method: "POST",
        headers: { Host: "attacker.invalid" },
        body: "{}"
      })
    ).rejects.toThrow("http.fetch header host cannot be supplied by the plugin");
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    "http://127.0.0.1/admin",
    "http://100.64.0.1/internal",
    "http://[::1]/internal",
    "http://metadata.google.internal/computeMetadata/v1"
  ])("rejects reserved HTTP destination %s", async (url) => {
    const transport = vi.fn();
    const broker = createCapabilityBroker({
      grants: {
        "http.fetch": { origins: ["https://api.example.com"], methods: ["GET"] }
      },
      providers: { "http.fetch": transport }
    });

    await expect(broker.call("http.fetch", { url, method: "GET" })).rejects.toThrow(
      "is not public"
    );
    expect(transport).not.toHaveBeenCalled();
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

  it("rejects kv.state scope spoofing and keeps tenant facets isolated", async () => {
    const storage = createInMemoryKvStateStorage();
    const limits = {
      maxKeyBytes: 128,
      maxValueBytes: 1_024,
      maxTotalBytes: 8_192,
      maxEntries: 32
    };
    const createBroker = (tenantId: string) =>
      createCapabilityBroker({
        grants: {
          "kv.state": { operations: ["get", "put"], keyPrefixes: ["settings:"] }
        },
        providers: {
          "kv.state": createKvStateProvider({
            scope: { tenantId, pluginName: "billing", version: "1.0.0" },
            limits,
            storage
          })
        }
      });
    const tenantA = createBroker("tenant_a");
    const tenantB = createBroker("tenant_b");

    await tenantA.call("kv.state", {
      operation: "put",
      key: "settings:theme",
      value: "tenant-a-only"
    });
    await expect(
      tenantA.call("kv.state", {
        operation: "get",
        key: "settings:theme",
        tenantId: "tenant_b"
      })
    ).rejects.toThrow("kv.state contains unsupported input fields");
    await expect(
      tenantB.call("kv.state", { operation: "get", key: "settings:theme" })
    ).resolves.toEqual({ found: false });
  });
});
