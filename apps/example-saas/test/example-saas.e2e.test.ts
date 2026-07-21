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
    const usage = await app.usage.getDailyUsageSummary({
      tenantId: "tenant_1",
      pluginId: "large-invoice-notify",
      date: "2026-06-12"
    });
    expect(usage).toEqual({
      tenantId: "tenant_1",
      pluginId: "large-invoice-notify",
      date: "2026-06-12",
      executions: 1,
      cpuMs: 0,
      subrequests: 0,
      workflowRuns: 0
    });
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
    await expect(
      app.usage.getDailyUsageSummary({
        tenantId: "tenant_1",
        pluginId: "payload-transformer",
        date: "2026-06-12"
      })
    ).resolves.toEqual(
      expect.objectContaining({
        executions: 1,
        subrequests: 0,
        workflowRuns: 0
      })
    );
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
    await expect(
      app.usage.getDailyUsageSummary({
        tenantId: "tenant_1",
        pluginId: "payload-transformer",
        date: "2026-06-12"
      })
    ).resolves.toEqual(expect.objectContaining({ executions: 1 }));
  });

  it("aggregates repeated executions exactly once per dispatch", async () => {
    const app = createExampleSaasDemo();
    const payload = {
      invoiceId: "inv_repeated",
      customerId: "cust_1",
      amountCents: 5_000
    };

    await app.emitInvoiceCreated(payload);
    await app.emitInvoiceCreated(payload);

    expect(app.executionLog.searchExecutions({ hookName: "invoice.created" })).toHaveLength(2);
    const usage = await app.usage.getDailyUsageSummary({
      tenantId: "tenant_1",
      pluginId: "large-invoice-notify",
      date: "2026-06-12"
    });
    expect(usage).toEqual(expect.objectContaining({ executions: 2, cpuMs: 0 }));
  });

  it("emits safe hook and persisted outcome dimensions to a configured usage sink", async () => {
    const points: unknown[] = [];
    const app = createExampleSaasDemo({
      usageAnalytics: {
        writeDataPoint: (point) => points.push(point)
      }
    });

    await app.emitInvoiceCreated({
      invoiceId: "inv_metrics",
      customerId: "cust_1",
      amountCents: 5_000
    });
    await app.transformWebhookOutbound({ headers: {}, body: {} });

    expect(points).toEqual([
      expect.objectContaining({
        blobs: ["tenant_1", "large-invoice-notify", "event", "success"]
      }),
      expect.objectContaining({
        blobs: ["tenant_1", "payload-transformer", "transform", "success"]
      })
    ]);
  });
});
