import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createInMemoryProxyMappingStore,
  handleWebhookProxy,
  type ProxyForwardRequest,
  type ProxyMapping,
  type ProxyWebhookBody
} from "@tenantscript/proxy";

const quickstartPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../docs/quickstarts/zero-integration-proxy-mode.md"
);

describe("zero-integration proxy mode quickstart", () => {
  it("executes the quickstart snippets as an end-to-end proxy flow", async () => {
    const quickstart = await readFile(quickstartPath, "utf8");
    const allowlist = extractJsonSnippet(
      quickstart,
      "tenantscript-proxy-allowlist"
    ) as readonly string[];
    const mapping = extractJsonSnippet(quickstart, "tenantscript-proxy-mapping") as ProxyMapping;
    const stripeEvent = extractJsonSnippet(
      quickstart,
      "stripe-invoice-payment-succeeded"
    ) as ProxyWebhookBody;
    const expectedForwardedBody = extractJsonSnippet(
      quickstart,
      "billing-webhook-forwarded-body"
    ) as ProxyWebhookBody;
    const mappingStore = createInMemoryProxyMappingStore({
      allowedDestinationOrigins: allowlist
    });
    const forwarded: ProxyForwardRequest[] = [];

    await mappingStore.upsertProxyMapping(mapping);
    const result = await handleWebhookProxy({
      request: {
        path: mapping.inboundPath,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "t=1781308800,v1=quickstart"
        },
        body: stripeEvent
      },
      mappingStore,
      resolveInstallations: ({ tenantId, hookName }) => [
        {
          id: "stripe_invoice_transformer",
          tenantId,
          pluginId: "stripe-webhook-normalizer",
          enabled: true,
          priority: 10,
          hooks: [hookName]
        }
      ],
      executeTransform: (_step, payload) => normalizeStripeInvoicePaid(payload),
      forward: (request) => {
        forwarded.push(request);
        return { status: 202, body: { accepted: true } };
      }
    });

    expect(forwarded).toEqual([
      {
        destinationUrl: mapping.destinationUrl,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "t=1781308800,v1=quickstart"
        },
        body: expectedForwardedBody
      }
    ]);
    expect(result).toMatchObject({
      tenantId: mapping.tenantId,
      transformed: true,
      skipped: false,
      forwardResponse: { status: 202, body: { accepted: true } }
    });
  });
});

function extractJsonSnippet(markdown: string, label: string): unknown {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\\`\\\`\\\`json ${escapedLabel}\\n([\\s\\S]*?)\\n\\\`\\\`\\\``).exec(
    markdown
  );
  const json = match?.[1];
  if (json === undefined) {
    throw new Error(`missing quickstart JSON snippet: ${label}`);
  }
  return JSON.parse(json) as unknown;
}

function normalizeStripeInvoicePaid(payload: ProxyWebhookBody): ProxyWebhookBody {
  const data = readRecord(payload, "data");
  const invoice = readRecord(data, "object");

  return {
    eventType: payload.type,
    invoiceId: invoice.id,
    customerId: invoice.customer,
    amountPaidCents: invoice.amount_paid,
    currency: invoice.currency,
    livemode: payload.livemode,
    transformedBy: "tenantscript-zero-integration"
  };
}

function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`quickstart payload field ${key} must be an object`);
  }
  return value as Record<string, unknown>;
}
