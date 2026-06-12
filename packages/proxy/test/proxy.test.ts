import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryProxyMappingStore,
  handleWebhookProxy,
  type ProxyForwardRequest
} from "../src/index.js";

describe("handleWebhookProxy", () => {
  it("resolves the tenant, applies transform plugins in priority order, and forwards", async () => {
    const forwarded: ProxyForwardRequest[] = [];
    const resolveInstallations = vi
      .fn()
      .mockResolvedValue([
        installation({ id: "inst_late", pluginId: "plugin_late", priority: 20 }),
        installation({ id: "inst_first", pluginId: "plugin_first", priority: 10 })
      ]);

    const result = await handleWebhookProxy({
      request: {
        path: "/hooks/stripe",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { invoiceId: "inv_1", tags: [] }
      },
      mappingStore: {
        findProxyMappingByPath: () =>
          Promise.resolve({
            inboundPath: "/hooks/stripe",
            tenantId: "tenant_1",
            destinationUrl: "https://origin.example.com/stripe",
            transformHookName: "webhook.proxy.transform"
          })
      },
      resolveInstallations,
      executeTransform: (step, payload) => {
        const tags = Array.isArray(payload.tags)
          ? payload.tags.filter((tag): tag is string => typeof tag === "string")
          : [];
        return {
          ...payload,
          tags: [...tags, step.installationId]
        };
      },
      forward: (request) => {
        forwarded.push(request);
        return Promise.resolve({ status: 202, body: "accepted" });
      }
    });

    expect(resolveInstallations).toHaveBeenCalledWith({
      tenantId: "tenant_1",
      hookName: "webhook.proxy.transform"
    });
    expect(forwarded).toEqual([
      {
        destinationUrl: "https://origin.example.com/stripe",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { invoiceId: "inv_1", tags: ["inst_first", "inst_late"] }
      }
    ]);
    expect(result).toEqual({
      tenantId: "tenant_1",
      destinationUrl: "https://origin.example.com/stripe",
      transformed: true,
      skipped: false,
      forwardResponse: { status: 202, body: "accepted" }
    });
  });

  it("skips failed transforms and forwards the original webhook body", async () => {
    const forwarded: ProxyForwardRequest[] = [];

    const result = await handleWebhookProxy({
      request: {
        path: "/hooks/stripe",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { invoiceId: "inv_1", amountCents: 150_000 }
      },
      mappingStore: {
        findProxyMappingByPath: () =>
          Promise.resolve({
            inboundPath: "/hooks/stripe",
            tenantId: "tenant_1",
            destinationUrl: "https://origin.example.com/stripe",
            transformHookName: "webhook.proxy.transform"
          })
      },
      resolveInstallations: () =>
        Promise.resolve([installation({ id: "inst_broken", pluginId: "plugin_broken" })]),
      executeTransform: () => {
        throw new Error("transform failed");
      },
      forward: (request) => {
        forwarded.push(request);
        return Promise.resolve({ status: 200 });
      }
    });

    expect(forwarded).toEqual([
      {
        destinationUrl: "https://origin.example.com/stripe",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { invoiceId: "inv_1", amountCents: 150_000 }
      }
    ]);
    expect(result).toMatchObject({
      tenantId: "tenant_1",
      transformed: false,
      skipped: true,
      forwardResponse: { status: 200 }
    });
  });

  it("rejects requests whose inbound path has no mapping", async () => {
    await expect(
      handleWebhookProxy({
        request: {
          path: "/hooks/missing",
          method: "POST",
          headers: {},
          body: {}
        },
        mappingStore: {
          findProxyMappingByPath: () => null
        },
        resolveInstallations: () => [],
        executeTransform: (_step, payload) => payload,
        forward: () => ({ status: 200 })
      })
    ).rejects.toThrow("proxy mapping for /hooks/missing was not found");
  });
});

describe("createInMemoryProxyMappingStore", () => {
  it("creates, updates, lists, finds, and deletes proxy mappings", async () => {
    const store = createInMemoryProxyMappingStore({
      allowedDestinationOrigins: ["https://origin.example.com"]
    });

    await expect(
      store.upsertProxyMapping({
        inboundPath: "/hooks/stripe",
        tenantId: "tenant_1",
        destinationUrl: "https://origin.example.com/stripe",
        transformHookName: "webhook.proxy.transform"
      })
    ).resolves.toMatchObject({ inboundPath: "/hooks/stripe", tenantId: "tenant_1" });
    await expect(store.findProxyMappingByPath("/hooks/stripe")).resolves.toMatchObject({
      destinationUrl: "https://origin.example.com/stripe"
    });

    await store.upsertProxyMapping({
      inboundPath: "/hooks/stripe",
      tenantId: "tenant_1",
      destinationUrl: "https://origin.example.com/stripe-v2",
      transformHookName: "webhook.proxy.transform"
    });

    await expect(store.listProxyMappings()).resolves.toEqual([
      expect.objectContaining({ destinationUrl: "https://origin.example.com/stripe-v2" })
    ]);
    await expect(store.deleteProxyMapping("/hooks/stripe")).resolves.toBe(true);
    await expect(store.findProxyMappingByPath("/hooks/stripe")).resolves.toBeNull();
  });
});

function installation(overrides: {
  id: string;
  pluginId: string;
  priority?: number;
  enabled?: boolean;
}) {
  return {
    id: overrides.id,
    tenantId: "tenant_1",
    pluginId: overrides.pluginId,
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 10,
    hooks: ["webhook.proxy.transform"]
  };
}
