import { vi } from "vitest";
import {
  createApprovalsRequestProvider,
  createEmailSendProvider,
  createGitHubIssueCreateProvider,
  createHttpFetchProvider,
  createInvoiceReadProvider,
  createInMemoryKvStateStorage,
  createKvStateProvider,
  createMockSlackSendProvider,
  createSlackSendProvider
} from "../src/index.js";
import { runCapabilityContract } from "./contract-kit.js";

runCapabilityContract({
  capability: "kv.state",
  grant: {
    operations: ["get"],
    keyPrefixes: ["settings:"]
  },
  allowedInput: { operation: "get", key: "settings:theme" },
  deniedInput: { operation: "delete", key: "settings:theme" },
  createProvider: () =>
    createKvStateProvider({
      scope: { tenantId: "tenant_contract", pluginName: "billing", version: "1.0.0" },
      limits: {
        maxKeyBytes: 128,
        maxValueBytes: 1_024,
        maxTotalBytes: 8_192,
        maxEntries: 32
      },
      storage: createInMemoryKvStateStorage()
    }),
  expectedAllowedResult: { found: false },
  expectedDeniedMessage: "kv.state operation delete is outside granted scope"
});

runCapabilityContract({
  capability: "http.fetch",
  grant: {
    origins: ["https://api.example.com"],
    methods: ["GET"],
    requestHeaders: ["accept"]
  },
  allowedInput: {
    url: "https://api.example.com/v1/invoices",
    method: "GET",
    headers: { accept: "application/json" }
  },
  deniedInput: {
    url: "https://api.example.com.attacker.invalid/v1/invoices",
    method: "GET",
    headers: { accept: "application/json" }
  },
  createProvider: () =>
    createHttpFetchProvider({
      allowedOrigins: ["https://api.example.com"],
      allowedMethods: ["GET"],
      credentials: {
        "https://api.example.com": {
          name: "authorization",
          value: "Bearer http-contract-secret"
        }
      },
      transport: vi.fn().mockResolvedValue({
        status: 200,
        headers: { "content-type": "application/json" },
        body: "[]"
      })
    }),
  expectedAllowedResult: {
    status: 200,
    headers: { "content-type": "application/json" },
    body: "[]"
  },
  expectedDeniedMessage:
    "http.fetch origin https://api.example.com.attacker.invalid is outside granted scope",
  sensitiveValue: "http-contract-secret"
});

runCapabilityContract({
  capability: "email.send",
  grant: {
    recipientDomains: ["example.com"],
    templates: ["invoice-ready"]
  },
  allowedInput: {
    to: "buyer@example.com",
    template: "invoice-ready",
    variables: { invoiceId: "inv_1" }
  },
  deniedInput: {
    to: "buyer@example.com.attacker.invalid",
    template: "invoice-ready",
    variables: { invoiceId: "inv_1" }
  },
  createProvider: () =>
    createEmailSendProvider({
      apiKey: "email-contract-secret",
      templates: {
        "invoice-ready": {
          subject: "Invoice {{invoiceId}} is ready",
          text: "Invoice {{invoiceId}} is ready."
        }
      },
      deliver: vi.fn()
    }),
  expectedAllowedResult: { ok: true, provider: "email" },
  expectedDeniedMessage:
    "email.send recipient domain example.com.attacker.invalid is outside granted scope",
  sensitiveValue: "email-contract-secret"
});

runCapabilityContract({
  capability: "slack.send",
  grant: { channel: "C123" },
  allowedInput: { channel: "C123", text: "hello" },
  deniedInput: { channel: "C999", text: "blocked" },
  createProvider: () =>
    createMockSlackSendProvider({ token: "xoxb-contract-secret", deliver: vi.fn() }),
  expectedAllowedResult: { ok: true, provider: "mock-slack" },
  expectedDeniedMessage: "slack.send channel C999 is outside granted scope",
  sensitiveValue: "xoxb-contract-secret"
});

runCapabilityContract({
  capability: "slack.send",
  grant: { channel: "C123" },
  allowedInput: { channel: "C123", text: "hello" },
  deniedInput: { channel: "C999", text: "blocked" },
  createProvider: () =>
    createSlackSendProvider({
      resolveAccessToken: () => Promise.resolve("xoxb-production-contract-secret"),
      fetcher: vi.fn().mockResolvedValue(
        Response.json({
          ok: true,
          channel: "C123",
          ts: "1712345678.123456",
          message: { type: "message", text: "hello", ts: "1712345678.123456" }
        })
      )
    }),
  expectedAllowedResult: { channel: "C123", timestamp: "1712345678.123456" },
  expectedDeniedMessage: "slack.send channel C999 is outside granted scope",
  sensitiveValue: "xoxb-production-contract-secret"
});

runCapabilityContract({
  capability: "github.issue.create",
  grant: { repositories: ["tenantscript/core"] },
  allowedInput: {
    repository: "tenantscript/core",
    title: "Contract issue",
    body: "Created by the accountless contract fixture."
  },
  deniedInput: {
    repository: "tenantscript/core-private",
    title: "Must be denied"
  },
  createProvider: () =>
    createGitHubIssueCreateProvider({
      resolveTokens: () => ({
        active: { id: "github-contract-v1", value: "github-contract-secret" }
      }),
      createIssue: vi.fn().mockResolvedValue({
        number: 42,
        url: "https://github.com/tenantscript/core/issues/42"
      })
    }),
  expectedAllowedResult: {
    number: 42,
    url: "https://github.com/tenantscript/core/issues/42"
  },
  expectedDeniedMessage:
    "github.issue.create repository tenantscript/core-private is outside granted scope",
  sensitiveValue: "github-contract-secret"
});

runCapabilityContract({
  capability: "approvals.request",
  grant: { roles: ["manager"], resumeHooks: ["onApproved"] },
  allowedInput: {
    role: "manager",
    subject: { invoiceId: "inv_1" },
    resumeHook: "onApproved",
    expiresAt: "2026-07-21T00:00:00.000Z"
  },
  deniedInput: {
    role: "owner",
    subject: { invoiceId: "inv_1" },
    resumeHook: "onApproved",
    expiresAt: "2026-07-21T00:00:00.000Z"
  },
  createProvider: () =>
    createApprovalsRequestProvider({
      store: { createApproval: (record) => record },
      generateId: () => "approval_contract",
      now: () => new Date("2026-07-20T00:00:00.000Z")
    }),
  expectedAllowedResult: { ok: true, approvalId: "approval_contract", state: "pending" },
  expectedDeniedMessage: "approvals.request role owner is outside granted scope"
});

runCapabilityContract({
  capability: "invoice.read",
  grant: { fields: ["id", "amountCents"] },
  allowedInput: { invoiceId: "inv_1" },
  deniedInput: { tenantId: "tenant_other", invoiceId: "inv_1" },
  createProvider: () =>
    createInvoiceReadProvider({
      tenantId: "tenant_contract",
      store: {
        findInvoice: ({ invoiceId }) => ({
          tenantId: "tenant_contract",
          id: invoiceId,
          amountCents: 1_000,
          customerEmail: "hidden@example.com"
        })
      }
    }),
  expectedAllowedResult: { id: "inv_1", amountCents: 1_000 },
  expectedDeniedMessage: "invoice.read tenant tenant_other is outside tenant scope",
  expectedDeniedAuditReason: "provider_denied"
});
