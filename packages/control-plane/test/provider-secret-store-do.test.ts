import { describe, expect, it } from "vitest";
import {
  createDurableObjectNamespaceSecretStore,
  ProviderSecretStoreDurableObject
} from "../src/index.js";

const ref = { provider: "slack", tenantId: "tenant_1", secretId: "workspace:T123" };
const keyringJson = JSON.stringify({
  currentKeyId: "test-key-v1",
  keys: [{ id: "test-key-v1", material: "A".repeat(43) }]
});

describe("provider secret store namespace client", () => {
  it("round-trips put, get, compare-and-swap, rewrap, and delete", async () => {
    const namespace = inProcessNamespace();
    const store = createDurableObjectNamespaceSecretStore(namespace);

    await expect(store.getSecret(ref)).resolves.toBeNull();
    await expect(store.putSecret({ ref, value: "oauth-token-v1" })).resolves.toEqual(ref);
    await expect(store.getSecret(ref)).resolves.toBe("oauth-token-v1");
    await expect(
      store.compareAndSwapSecret({ ref, expectedValue: "wrong", nextValue: "oauth-token-v2" })
    ).resolves.toEqual({ matched: false, changed: false });
    await expect(
      store.compareAndSwapSecret({
        ref,
        expectedValue: "oauth-token-v1",
        nextValue: "oauth-token-v2"
      })
    ).resolves.toEqual({ matched: true, changed: true });
    await expect(store.rewrapSecret(ref)).resolves.toMatchObject({
      previousKeyId: "test-key-v1",
      currentKeyId: "test-key-v1",
      changed: false
    });
    await expect(
      store.compareAndSwapSecret({ ref, expectedValue: "oauth-token-v2", nextValue: null })
    ).resolves.toEqual({ matched: true, changed: true });
    await expect(store.getSecret(ref)).resolves.toBeNull();
    await expect(store.rewrapSecret(ref)).resolves.toBeNull();
  });

  it("rejects a successful response with the wrong operation status", async () => {
    const store = createDurableObjectNamespaceSecretStore(responseNamespace(Response.json({})));

    await expect(store.putSecret({ ref, value: "oauth-token" })).rejects.toThrow(
      "provider secret store unavailable"
    );
  });

  it.each([
    ["get shape", () => responseNamespace(Response.json({ value: 1 }))],
    ["CAS shape", () => responseNamespace(Response.json({ matched: true, changed: "yes" }))],
    ["rewrap shape", () => responseNamespace(Response.json({ result: { changed: false } }))],
    ["malformed JSON", () => responseNamespace(new Response("{"))],
    [
      "oversized response",
      () => responseNamespace(new Response("{}", { headers: { "Content-Length": "70000" } }))
    ],
    ["missing response body", () => responseNamespace(new Response(null, { status: 200 }))],
    ["transport failure", () => throwingNamespace()]
  ])("rejects an invalid %s without provider response reflection", async (_label, namespace) => {
    const store = createDurableObjectNamespaceSecretStore(namespace());

    await expect(store.getSecret(ref)).rejects.toThrow("provider secret store unavailable");
  });

  it("rejects invalid references before namespace access", async () => {
    let accessed = false;
    const store = createDurableObjectNamespaceSecretStore({
      idFromName: (name) => name,
      get: () => {
        accessed = true;
        return { fetch: () => Promise.resolve(new Response(null, { status: 204 })) };
      }
    });

    await expect(store.getSecret({ ...ref, tenantId: "" })).rejects.toThrow(
      "provider secret store unavailable"
    );
    expect(accessed).toBe(false);
  });
});

describe("ProviderSecretStoreDurableObject protocol", () => {
  it.each([
    ["wrong method", "GET", "/v1/get", "{}", 404],
    ["unknown path", "POST", "/v1/export", "{}", 404],
    ["malformed JSON", "POST", "/v1/get", "{", 400],
    ["unknown field", "POST", "/v1/get", JSON.stringify({ ref, unknown: true }), 400],
    ["empty secret", "POST", "/v1/put", JSON.stringify({ ref, value: "" }), 400],
    ["oversized secret", "POST", "/v1/put", JSON.stringify({ ref, value: "é".repeat(8_193) }), 400],
    [
      "empty CAS value",
      "POST",
      "/v1/compare-and-swap",
      JSON.stringify({ ref, expectedValue: "", nextValue: null }),
      400
    ]
  ])("rejects %s with a stable response", async (_label, method, path, body, status) => {
    const object = createObject();
    const response = await object.fetch(
      new Request(`https://provider-secret-store.internal${path}`, {
        method,
        ...(method === "GET" ? {} : { body })
      })
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("oauth-token");
  });

  it.each([
    ["missing", null],
    ["malformed", "{"],
    ["wrong shape", "[]"],
    ["unknown field", JSON.stringify({ currentKeyId: "test-key-v1", keys: [], unknown: true })],
    ["missing key", JSON.stringify({ currentKeyId: "test-key-v1", keys: [] })],
    [
      "invalid material",
      JSON.stringify({
        currentKeyId: "test-key-v1",
        keys: [{ id: "test-key-v1", material: "secret-sentinel" }]
      })
    ]
  ])("fails closed for %s keyring configuration", async (_label, configuration) => {
    const object = createObject(configuration);
    const response = await object.fetch(
      new Request("https://provider-secret-store.internal/v1/put", {
        method: "POST",
        body: JSON.stringify({ ref, value: "oauth-token" })
      })
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":{"code":"provider_secret_store_unavailable"}}');
  });
});

function inProcessNamespace() {
  const objects = new Map<string, ProviderSecretStoreDurableObject>();
  return {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: (input: string, init: RequestInit) => {
        let object = objects.get(id);
        if (object === undefined) {
          object = createObject();
          objects.set(id, object);
        }
        return object.fetch(new Request(input, init));
      }
    })
  };
}

function responseNamespace(response: Response) {
  return {
    idFromName: (name: string) => name,
    get: () => ({ fetch: () => Promise.resolve(response.clone()) })
  };
}

function throwingNamespace() {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: () => Promise.reject(new Error("provider secret-sentinel"))
    })
  };
}

function createObject(
  configuration: string | null = keyringJson
): ProviderSecretStoreDurableObject {
  const records = new Map<string, string>();
  const transaction = {
    get: <T>(key: string) => Promise.resolve(records.get(key) as T | undefined),
    put: (key: string, value: string) => {
      records.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => Promise.resolve(records.delete(key))
  };
  const state = {
    storage: {
      get: transaction.get,
      put: transaction.put,
      transaction: <T>(closure: (value: typeof transaction) => Promise<T>) => closure(transaction)
    },
    blockConcurrencyWhile: <T>(closure: () => Promise<T>) => closure()
  };
  return new ProviderSecretStoreDurableObject(state, {
    ...(configuration === null ? {} : { PROVIDER_SECRET_KEYRING_JSON: configuration })
  });
}
