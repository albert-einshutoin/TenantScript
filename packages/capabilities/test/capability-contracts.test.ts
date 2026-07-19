import { vi } from "vitest";
import {
  createApprovalsRequestProvider,
  createEmailSendProvider,
  createInvoiceReadProvider,
  createMockSlackSendProvider
} from "../src/index.js";
import { runCapabilityContract } from "./contract-kit.js";

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
  expectedDeniedMessage: "invoice.read tenant tenant_other is outside tenant scope"
});
