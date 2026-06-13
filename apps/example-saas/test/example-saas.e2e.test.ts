import { describe, expect, it } from "vitest";
import { createExampleSaasDemo } from "../src/index.js";

describe("example-saas TenantScript E2E demo", () => {
  it("routes invoice.created through an installed plugin and mock Slack capability", async () => {
    const app = createExampleSaasDemo();

    await app.emitInvoiceCreated({
      invoiceId: "inv_1",
      customerId: "cust_1",
      amountCents: 150_000
    });

    expect(app.slackMessages).toEqual([
      {
        channel: "C123",
        text: "Large invoice inv_1: 150000"
      }
    ]);
    expect(app.executionLog.searchExecutions({ hookName: "invoice.created" })).toEqual([
      expect.objectContaining({
        tenantId: "tenant_1",
        pluginId: "large-invoice-notify",
        hookName: "invoice.created",
        status: "success",
        capabilityCalls: [{ name: "slack.send", status: "success" }]
      })
    ]);
  });

  it("records invoice.created executions without notifying Slack for small invoices", async () => {
    const app = createExampleSaasDemo();

    await app.emitInvoiceCreated({
      invoiceId: "inv_small",
      customerId: "cust_1",
      amountCents: 5_000
    });

    expect(app.slackMessages).toEqual([]);
    expect(app.executionLog.searchExecutions({ hookName: "invoice.created" })).toHaveLength(1);
  });

  it("routes webhook.outbound through a transform chain and records execution logs", async () => {
    const app = createExampleSaasDemo();

    const transformed = await app.transformWebhookOutbound({
      headers: { "content-type": "application/json" },
      body: { invoiceId: "inv_1" }
    });

    expect(transformed).toEqual({
      headers: {
        "content-type": "application/json",
        "x-tenantscript-demo": "payload-transformer"
      },
      body: {
        invoiceId: "inv_1",
        transformedBy: "payload-transformer"
      }
    });
    expect(app.executionLog.searchExecutions({ hookName: "webhook.outbound" })).toEqual([
      expect.objectContaining({
        tenantId: "tenant_1",
        pluginId: "payload-transformer",
        hookName: "webhook.outbound",
        status: "success"
      })
    ]);
  });

  it("falls back to the original webhook payload when a transform plugin is missing", async () => {
    const app = createExampleSaasDemo({ omitTransformPlugin: true });
    const payload = {
      headers: { "content-type": "application/json" },
      body: { invoiceId: "inv_1" }
    };

    await expect(app.transformWebhookOutbound(payload)).resolves.toEqual(payload);
    expect(app.executionLog.searchExecutions({ hookName: "webhook.outbound" })).toEqual([
      expect.objectContaining({
        status: "error",
        error: "MissingHandlerError"
      })
    ]);
  });
});
