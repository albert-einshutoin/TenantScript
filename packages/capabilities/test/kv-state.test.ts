import { describe, expect, it } from "vitest";
import {
  createCapabilityBroker,
  createInMemoryKvStateStorage,
  createKvStateProvider,
  type KvStateLimits,
  type KvStateScope
} from "../src/index.js";

const limits: KvStateLimits = {
  maxKeyBytes: 128,
  maxValueBytes: 1_024,
  maxTotalBytes: 8_192,
  maxEntries: 32
};

describe("kv.state capability", () => {
  it("isolates durable state by tenant, plugin, and version facets", async () => {
    const storage = createInMemoryKvStateStorage();
    const scopes: KvStateScope[] = [
      { tenantId: "tenant_a", pluginName: "billing", version: "1.0.0" },
      { tenantId: "tenant_b", pluginName: "billing", version: "1.0.0" },
      { tenantId: "tenant_a", pluginName: "shipping", version: "1.0.0" },
      { tenantId: "tenant_a", pluginName: "billing", version: "2.0.0" }
    ];
    const brokers = scopes.map((scope) =>
      createKvBroker({ scope, storage, limits, operations: ["get", "put"] })
    );

    await Promise.all(
      brokers.map((broker, index) =>
        broker.call("kv.state", {
          operation: "put",
          key: "settings:mode",
          value: { owner: scopes[index], index }
        })
      )
    );

    await expect(
      Promise.all(
        brokers.map((broker) => broker.call("kv.state", { operation: "get", key: "settings:mode" }))
      )
    ).resolves.toEqual(
      scopes.map((scope, index) => ({ found: true, value: { owner: scope, index } }))
    );
  });

  it("enforces UTF-8 key, value, facet, total, and entry limits before mutation", async () => {
    const storage = createInMemoryKvStateStorage();
    const broker = createKvBroker({
      scope: { tenantId: "tenant_a", pluginName: "billing", version: "1.0.0" },
      storage,
      limits: {
        maxKeyBytes: 4,
        maxValueBytes: 7,
        maxTotalBytes: 12,
        maxEntries: 2
      },
      operations: ["get", "put"]
    });

    await expect(
      broker.call("kv.state", { operation: "put", key: "a", value: "one" })
    ).resolves.toEqual({ ok: true, totalBytes: 6 });
    await expect(
      broker.call("kv.state", { operation: "put", key: "b", value: "two" })
    ).resolves.toEqual({ ok: true, totalBytes: 12 });
    await expect(
      broker.call("kv.state", { operation: "put", key: "界界", value: "x" })
    ).rejects.toThrow("kv.state key exceeds 4 bytes");
    await expect(
      broker.call("kv.state", { operation: "put", key: "b", value: "three" })
    ).rejects.toThrow("kv.state facet exceeds 12 bytes");
    await expect(
      broker.call("kv.state", { operation: "put", key: "c", value: "x" })
    ).rejects.toThrow("kv.state facet exceeds 2 entries");
    await expect(
      broker.call("kv.state", { operation: "put", key: "a", value: "界界" })
    ).rejects.toThrow("kv.state value exceeds 7 bytes");
    await expect(broker.call("kv.state", { operation: "get", key: "b" })).resolves.toEqual({
      found: true,
      value: "two"
    });
  });

  it("deletes only the bound facet entry and releases quota", async () => {
    const storage = createInMemoryKvStateStorage();
    const broker = createKvBroker({
      scope: { tenantId: "tenant_a", pluginName: "billing", version: "1.0.0" },
      storage,
      limits,
      operations: ["get", "put", "delete"]
    });

    await broker.call("kv.state", { operation: "put", key: "cache:item", value: [1, 2, 3] });
    await expect(
      broker.call("kv.state", { operation: "delete", key: "cache:item" })
    ).resolves.toEqual({ deleted: true, totalBytes: 0 });
    await expect(
      broker.call("kv.state", { operation: "delete", key: "cache:item" })
    ).resolves.toEqual({ deleted: false, totalBytes: 0 });
    await expect(broker.call("kv.state", { operation: "get", key: "cache:item" })).resolves.toEqual(
      { found: false }
    );
  });
});

function createKvBroker(params: {
  scope: KvStateScope;
  storage: ReturnType<typeof createInMemoryKvStateStorage>;
  limits: KvStateLimits;
  operations: readonly string[];
}) {
  return createCapabilityBroker({
    grants: {
      "kv.state": {
        operations: params.operations,
        keyPrefixes: ["settings:", "cache:", "a", "b", "c", "界"]
      }
    },
    providers: {
      "kv.state": createKvStateProvider({
        scope: params.scope,
        limits: params.limits,
        storage: params.storage
      })
    }
  });
}
