import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryProxyMappingStore,
  handleWebhookProxy,
  type ProxyForwardRequest
} from "../src/index.js";

describe("handleWebhookProxy", () => {
  it("resolves the tenant, applies the transform, and forwards", async () => {
    const forwarded: ProxyForwardRequest[] = [];
    const resolveInstallations = vi
      .fn()
      .mockResolvedValue([
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
            transformHookName: "webhook.outbound"
          })
      },
      resolveInstallations,
      executeTransform: (step, payload) => {
        const tags = Array.isArray(payload.tags)
          ? payload.tags.filter((tag): tag is string => typeof tag === "string")
          : [];
        return {
          status: "transformed",
          output: {
            ...payload,
            tags: [...tags, step.installationId]
          }
        };
      },
      forward: (request) => {
        forwarded.push(request);
        return Promise.resolve({ status: 202, body: "accepted" });
      }
    });

    expect(resolveInstallations).toHaveBeenCalledWith({
      tenantId: "tenant_1",
      hookName: "webhook.outbound"
    });
    expect(forwarded).toEqual([
      {
        destinationUrl: "https://origin.example.com/stripe",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { invoiceId: "inv_1", tags: ["inst_first"] }
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

  it("fails closed unless exactly one active transform is installed", async () => {
    const forward = vi.fn(() => Promise.resolve({ status: 202 }));
    const request = {
      path: "/hooks/stripe",
      method: "POST",
      headers: {},
      body: { invoiceId: "inv_1" }
    };
    const mappingStore = {
      findProxyMappingByPath: () =>
        Promise.resolve({
          inboundPath: "/hooks/stripe",
          tenantId: "tenant_1",
          destinationUrl: "https://origin.example.com/stripe",
          transformHookName: "webhook.outbound"
        })
    };
    const executeTransform = (
      _step: { installationId: string; pluginId: string; priority: number },
      payload: Record<string, unknown>
    ) => ({
      status: "transformed" as const,
      output: payload
    });
    const run = (installations: readonly ReturnType<typeof installation>[]) =>
      handleWebhookProxy({
        request,
        mappingStore,
        resolveInstallations: () => installations,
        executeTransform,
        forward
      });

    await expect(run([])).rejects.toMatchObject({
      name: "ProxyContractError",
      code: "input_invalid"
    });
    await expect(
      run([
        installation({ id: "inst_1", pluginId: "plugin_1" }),
        installation({ id: "inst_2", pluginId: "plugin_2" })
      ])
    ).rejects.toMatchObject({
      name: "ProxyContractError",
      code: "input_invalid"
    });
    expect(forward).not.toHaveBeenCalled();
  });

  it("fails closed when a transform fails", async () => {
    const forwarded: ProxyForwardRequest[] = [];

    const result = handleWebhookProxy({
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
            transformHookName: "webhook.outbound"
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

    await expect(result).rejects.toMatchObject({
      name: "ProxyContractError",
      code: "plugin_result_invalid"
    });
    expect(forwarded).toEqual([]);
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
        executeTransform: (_step, payload) => ({ status: "transformed", output: payload }),
        forward: () => ({ status: 200 })
      })
    ).rejects.toMatchObject({ name: "ProxyContractError", code: "input_invalid" });
  });

  it("rejects a mapping that declares a non-transform hook", async () => {
    await expect(
      handleWebhookProxy({
        request: {
          path: "/hooks/policy",
          method: "POST",
          headers: {},
          body: {}
        },
        mappingStore: {
          findProxyMappingByPath: () => ({
            inboundPath: "/hooks/policy",
            tenantId: "tenant_1",
            destinationUrl: "https://origin.example.com/policy",
            transformHookName: "webhook.outbound",
            hookType: "policy"
          })
        },
        resolveInstallations: () => [],
        executeTransform: (_step, payload) => ({ status: "transformed", output: payload }),
        forward: () => ({ status: 200 })
      })
    ).rejects.toMatchObject({ name: "ProxyContractError", code: "input_invalid" });
  });

  it("rejects a mapping that targets a non-canonical transform hook", async () => {
    await expect(
      handleWebhookProxy({
        request: {
          path: "/hooks/custom",
          method: "POST",
          headers: {},
          body: {}
        },
        mappingStore: {
          findProxyMappingByPath: () => ({
            inboundPath: "/hooks/custom",
            tenantId: "tenant_1",
            destinationUrl: "https://origin.example.com/custom",
            transformHookName: "invoice.transform",
            hookType: "transform"
          })
        },
        resolveInstallations: () => [],
        executeTransform: (_step, payload) => ({ status: "transformed", output: payload }),
        forward: () => ({ status: 200 })
      })
    ).rejects.toMatchObject({ name: "ProxyContractError", code: "input_invalid" });
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
        transformHookName: "webhook.outbound"
      })
    ).resolves.toMatchObject({ inboundPath: "/hooks/stripe", tenantId: "tenant_1" });
    await expect(store.findProxyMappingByPath("/hooks/stripe")).resolves.toMatchObject({
      destinationUrl: "https://origin.example.com/stripe"
    });

    await store.upsertProxyMapping({
      inboundPath: "/hooks/stripe",
      tenantId: "tenant_1",
      destinationUrl: "https://origin.example.com/stripe-v2",
      transformHookName: "webhook.outbound"
    });

    await expect(store.listProxyMappings()).resolves.toEqual([
      expect.objectContaining({ destinationUrl: "https://origin.example.com/stripe-v2" })
    ]);
    await expect(store.deleteProxyMapping("/hooks/stripe")).resolves.toBe(true);
    await expect(store.findProxyMappingByPath("/hooks/stripe")).resolves.toBeNull();
  });

  it("rejects non-canonical transform hook names", async () => {
    const store = createInMemoryProxyMappingStore({
      allowedDestinationOrigins: ["https://origin.example.com"]
    });

    await expect(
      store.upsertProxyMapping({
        inboundPath: "/hooks/custom",
        tenantId: "tenant_1",
        destinationUrl: "https://origin.example.com/custom",
        transformHookName: "invoice.transform"
      })
    ).rejects.toMatchObject({ name: "ProxyContractError", code: "input_invalid" });
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
    hooks: ["webhook.outbound"]
  };
}
