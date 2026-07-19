import { describe, expect, it, vi } from "vitest";
import {
  CapabilityDeniedError,
  createApprovalsRequestProvider,
  createCapabilityBroker,
  createDurableObjectCapabilityCallJournal,
  createEmailSendProvider,
  createHttpFetchProvider,
  createInMemoryCapabilityCallJournal,
  createInMemoryCapabilityRateLimiter,
  createInvoiceReadProvider,
  createMockSlackSendProvider,
  createPluginCapabilityContext,
  createWebFetchHttpTransport,
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

  it("renders an allowed email template without recursively evaluating variable content", async () => {
    const deliver = vi.fn();
    const broker = createCapabilityBroker({
      grants: {
        "email.send": {
          recipientDomains: ["example.com"],
          templates: ["invoice-ready"]
        }
      },
      providers: {
        "email.send": createEmailSendProvider({
          apiKey: "email-provider-secret",
          templates: {
            "invoice-ready": {
              subject: "Invoice {{invoiceId}} is ready",
              text: "Hello {{recipientName}}, invoice {{invoiceId}} is ready."
            }
          },
          deliver
        })
      }
    });

    await expect(
      broker.call("email.send", {
        to: "buyer@example.com",
        template: "invoice-ready",
        variables: {
          invoiceId: "inv_1",
          recipientName: "{{invoiceId}}"
        }
      })
    ).resolves.toEqual({ ok: true, provider: "email" });
    expect(deliver).toHaveBeenCalledWith(
      {
        to: "buyer@example.com",
        subject: "Invoice inv_1 is ready",
        text: "Hello {{invoiceId}}, invoice inv_1 is ready."
      },
      "email-provider-secret"
    );
  });

  it("rejects email recipients and templates outside the grant before delivery", async () => {
    const deliver = vi.fn();
    const broker = createCapabilityBroker({
      grants: {
        "email.send": {
          recipientDomains: ["example.com"],
          templates: ["invoice-ready"]
        }
      },
      providers: {
        "email.send": createEmailSendProvider({
          apiKey: "email-provider-secret",
          templates: {
            "invoice-ready": { subject: "Ready", text: "Ready" },
            internal: { subject: "Internal", text: "Internal" }
          },
          deliver
        })
      }
    });

    await expect(
      broker.call("email.send", {
        to: "buyer@example.com.attacker.invalid",
        template: "invoice-ready",
        variables: {}
      })
    ).rejects.toThrow(
      "email.send recipient domain example.com.attacker.invalid is outside granted scope"
    );
    await expect(
      broker.call("email.send", {
        to: "buyer@example.com",
        template: "internal",
        variables: {}
      })
    ).rejects.toThrow("email.send template internal is outside granted scope");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("follows allowed HTTP redirects and injects only the destination credential", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: "https://uploads.example.com/v1/result" }
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "provider-session=secret"
        },
        body: '{"ok":true}'
      });
    const broker = createCapabilityBroker({
      grants: {
        "http.fetch": {
          origins: ["https://api.example.com", "https://uploads.example.com"],
          methods: ["GET"],
          requestHeaders: ["accept"]
        }
      },
      providers: {
        "http.fetch": createHttpFetchProvider({
          allowedOrigins: ["https://api.example.com", "https://uploads.example.com"],
          allowedMethods: ["GET"],
          credentials: {
            "https://api.example.com": {
              name: "authorization",
              value: "Bearer api-secret"
            },
            "https://uploads.example.com": {
              name: "x-upload-token",
              value: "upload-secret"
            }
          },
          transport
        })
      }
    });

    await expect(
      broker.call("http.fetch", {
        url: "https://api.example.com/v1/start",
        method: "GET",
        headers: { accept: "application/json" }
      })
    ).resolves.toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}'
    });
    expect(transport).toHaveBeenNthCalledWith(1, {
      url: "https://api.example.com/v1/start",
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: "Bearer api-secret"
      }
    });
    expect(transport).toHaveBeenNthCalledWith(2, {
      url: "https://uploads.example.com/v1/result",
      method: "GET",
      headers: {
        accept: "application/json",
        "x-upload-token": "upload-secret"
      }
    });
  });

  it("adapts the Workers fetch API with manual redirects and ambient credentials disabled", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response("accepted", {
        status: 202,
        headers: { "content-type": "text/plain" }
      })
    );
    const transport = createWebFetchHttpTransport(fetcher);

    await expect(
      transport({
        url: "https://api.example.com/v1/jobs",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    ).resolves.toEqual({
      status: 202,
      headers: { "content-type": "text/plain" },
      body: "accepted"
    });
    expect(fetcher).toHaveBeenCalledWith("https://api.example.com/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      redirect: "manual",
      credentials: "omit"
    });
  });

  it("converts POST to GET after a 303 redirect and drops entity metadata", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ status: 303, headers: { location: "/v1/result" } })
      .mockResolvedValueOnce({ status: 204 });
    const broker = createCapabilityBroker({
      grants: {
        "http.fetch": {
          origins: ["https://api.example.com"],
          methods: ["POST", "GET"],
          requestHeaders: ["content-type"]
        }
      },
      providers: {
        "http.fetch": createHttpFetchProvider({
          allowedOrigins: ["https://api.example.com"],
          allowedMethods: ["POST", "GET"],
          transport
        })
      }
    });

    await expect(
      broker.call("http.fetch", {
        url: "https://api.example.com/v1/jobs",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    ).resolves.toEqual({ status: 204, headers: {} });
    expect(transport).toHaveBeenNthCalledWith(2, {
      url: "https://api.example.com/v1/result",
      method: "GET",
      headers: {}
    });
  });

  it("fails closed when an HTTP provider exceeds its redirect budget", async () => {
    const broker = createCapabilityBroker({
      grants: {
        "http.fetch": { origins: ["https://api.example.com"], methods: ["GET"] }
      },
      providers: {
        "http.fetch": createHttpFetchProvider({
          allowedOrigins: ["https://api.example.com"],
          allowedMethods: ["GET"],
          maxRedirects: 0,
          transport: () => ({ status: 302, headers: { location: "/again" } })
        })
      }
    });

    await expect(
      broker.call("http.fetch", { url: "https://api.example.com/start", method: "GET" })
    ).rejects.toThrow("http.fetch exceeded redirect limit");
  });

  it("rejects unsafe HTTP provider configuration before accepting calls", () => {
    const transport = vi.fn();
    expect(() =>
      createHttpFetchProvider({
        allowedOrigins: ["https://api.example.com"],
        allowedMethods: [],
        transport
      })
    ).toThrow("http.fetch provider methods are invalid");
    expect(() =>
      createHttpFetchProvider({
        allowedOrigins: ["https://api.example.com/v1"],
        allowedMethods: ["GET"],
        transport
      })
    ).toThrow("http.fetch provider origin https://api.example.com/v1 is invalid");
    expect(() =>
      createHttpFetchProvider({
        allowedOrigins: ["https://api.example.com"],
        allowedMethods: ["GET"],
        credentials: {
          "https://other.example.com": { name: "authorization", value: "secret" }
        },
        transport
      })
    ).toThrow("http.fetch credential origin https://other.example.com is not allowed");
    expect(() =>
      createHttpFetchProvider({
        allowedOrigins: ["https://api.example.com"],
        allowedMethods: ["GET"],
        credentials: {
          "https://api.example.com": { name: "host", value: "secret" }
        },
        transport
      })
    ).toThrow("http.fetch credential for https://api.example.com is invalid");
    expect(() =>
      createHttpFetchProvider({
        allowedOrigins: ["http://api.example.com"],
        allowedMethods: ["GET"],
        credentials: {
          "http://api.example.com": { name: "authorization", value: "secret" }
        },
        transport
      })
    ).toThrow("http.fetch credential origin http://api.example.com must use HTTPS");
    expect(() =>
      createHttpFetchProvider({
        allowedOrigins: ["https://api.example.com"],
        allowedMethods: ["GET"],
        maxRedirects: 11,
        transport
      })
    ).toThrow("http.fetch maxRedirects must be between 0 and 10");
  });

  it.each([
    [{}, "http.fetch requires url and method"],
    [
      { url: "https://api.example.com", method: "GET", extra: true },
      "http.fetch contains unsupported input fields"
    ],
    [
      { url: "https://api.example.com", method: "GET", body: "not allowed" },
      "http.fetch GET requests must not include a body"
    ],
    [{ url: "https://api.example.com", method: "CONNECT" }, "http.fetch method is invalid"],
    [
      { url: "https://user:secret@api.example.com", method: "GET" },
      "http.fetch URL must not contain credentials"
    ],
    [
      {
        url: "https://api.example.com",
        method: "GET",
        headers: { Accept: "text/plain", accept: "application/json" }
      },
      "http.fetch header accept is duplicated"
    ]
  ])("rejects malformed HTTP input %#", async (input, message) => {
    const broker = createCapabilityBroker({
      grants: {
        "http.fetch": {
          origins: ["https://api.example.com"],
          methods: ["GET"],
          requestHeaders: ["accept"]
        }
      },
      providers: { "http.fetch": vi.fn() }
    });

    await expect(broker.call("http.fetch", input)).rejects.toThrow(message);
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

  it("filters invoice.read results to granted fields", async () => {
    const broker = createCapabilityBroker({
      grants: { "invoice.read": { fields: ["id", "amountCents"] } },
      providers: {
        "invoice.read": createInvoiceReadProvider({
          tenantId: "tenant_1",
          store: {
            findInvoice: () => ({
              tenantId: "tenant_1",
              id: "inv_1",
              amountCents: 150_000,
              customerEmail: "buyer@example.com",
              internalMemo: "discount approved"
            })
          }
        })
      }
    });

    await expect(broker.call("invoice.read", { invoiceId: "inv_1" })).resolves.toEqual({
      id: "inv_1",
      amountCents: 150_000
    });
  });

  it("rejects capability calls over the per-capability rate limit and writes audit", async () => {
    const provider = vi.fn().mockResolvedValue({ ok: true });
    const audits: unknown[] = [];
    const broker = createCapabilityBroker({
      grants: { "slack.send": { channel: "C123" } },
      providers: { "slack.send": provider },
      rateLimiter: createInMemoryCapabilityRateLimiter({
        limits: { "slack.send": { limit: 1, windowMs: 1_000 } }
      }),
      auditSink: {
        writeCapabilityAudit: (record) => {
          audits.push(record);
        }
      },
      now: () => new Date("2026-06-13T01:00:00.000Z")
    });

    await expect(broker.call("slack.send", { channel: "C123", text: "one" })).resolves.toEqual({
      ok: true
    });
    await expect(broker.call("slack.send", { channel: "C123", text: "two" })).rejects.toThrow(
      "capability slack.send exceeded rate limit"
    );

    expect(provider).toHaveBeenCalledOnce();
    expect(audits).toEqual([
      {
        capability: "slack.send",
        status: "success",
        reason: "provider_completed",
        at: new Date("2026-06-13T01:00:00.000Z")
      },
      {
        capability: "slack.send",
        status: "denied",
        reason: "rate_limited",
        at: new Date("2026-06-13T01:00:00.000Z")
      }
    ]);
  });

  it("allows capability calls again after the rate-limit window resets", async () => {
    const provider = vi.fn().mockResolvedValue({ ok: true });
    const calls = [
      new Date("2026-06-13T01:00:00.000Z"),
      new Date("2026-06-13T01:00:00.500Z"),
      new Date("2026-06-13T01:00:01.001Z")
    ];
    const broker = createCapabilityBroker({
      grants: { "slack.send": { channel: "C123" } },
      providers: { "slack.send": provider },
      rateLimiter: createInMemoryCapabilityRateLimiter({
        limits: { "slack.send": { limit: 1, windowMs: 1_000 } }
      }),
      now: () => calls.shift() ?? new Date("2026-06-13T01:00:01.001Z")
    });

    await expect(broker.call("slack.send", { channel: "C123", text: "one" })).resolves.toEqual({
      ok: true
    });
    await expect(broker.call("slack.send", { channel: "C123", text: "two" })).rejects.toThrow(
      "capability slack.send exceeded rate limit"
    );
    await expect(broker.call("slack.send", { channel: "C123", text: "three" })).resolves.toEqual({
      ok: true
    });
    expect(provider).toHaveBeenCalledTimes(2);
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
