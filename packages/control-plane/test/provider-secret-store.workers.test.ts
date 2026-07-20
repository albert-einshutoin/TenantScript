import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createDurableObjectNamespaceSecretStore } from "../src/index.js";

interface TestWorkersEnv {
  PROVIDER_SECRET_STORE_DO: DurableObjectNamespace;
}

const testEnv = env as unknown as TestWorkersEnv;

beforeEach(async () => {
  await reset();
});

describe("production provider secret store Durable Object", () => {
  it("round-trips encrypted provider secrets and compares updates atomically", async () => {
    const store = createDurableObjectNamespaceSecretStore(testEnv.PROVIDER_SECRET_STORE_DO);
    const ref = { provider: "slack", tenantId: "tenant_1", secretId: "workspace:T123" };

    await expect(store.getSecret(ref)).resolves.toBeNull();
    await expect(store.putSecret({ ref, value: "oauth-token-v1" })).resolves.toEqual(ref);
    await expect(store.getSecret(ref)).resolves.toBe("oauth-token-v1");
    const objectName = await tenantObjectName(ref.tenantId);
    const stub = testEnv.PROVIDER_SECRET_STORE_DO.get(
      testEnv.PROVIDER_SECRET_STORE_DO.idFromName(objectName)
    );
    const persisted = await runInDurableObject(stub, (_instance, state) =>
      state.storage.list<string>()
    );
    expect(JSON.stringify([...persisted.values()])).not.toContain("oauth-token-v1");
    await expect(
      store.compareAndSwapSecret({
        ref,
        expectedValue: "wrong-token",
        nextValue: "oauth-token-v2"
      })
    ).resolves.toEqual({ matched: false, changed: false });
    await expect(
      store.compareAndSwapSecret({
        ref,
        expectedValue: "oauth-token-v1",
        nextValue: "oauth-token-v2"
      })
    ).resolves.toEqual({ matched: true, changed: true });
    await expect(store.getSecret(ref)).resolves.toBe("oauth-token-v2");
    await expect(store.rewrapSecret(ref)).resolves.toMatchObject({
      previousKeyId: "test-key-v1",
      currentKeyId: "test-key-v1",
      changed: false
    });
  });

  it("isolates the same provider secret ID by tenant", async () => {
    const store = createDurableObjectNamespaceSecretStore(testEnv.PROVIDER_SECRET_STORE_DO);
    const tenantOne = { provider: "slack", tenantId: "tenant_1", secretId: "workspace:T123" };
    const tenantTwo = { ...tenantOne, tenantId: "tenant_2" };

    await store.putSecret({ ref: tenantOne, value: "tenant-one-token" });
    await store.putSecret({ ref: tenantTwo, value: "tenant-two-token" });

    await expect(store.getSecret(tenantOne)).resolves.toBe("tenant-one-token");
    await expect(store.getSecret(tenantTwo)).resolves.toBe("tenant-two-token");
  });

  it("returns stable failures without reflecting secret values", async () => {
    const store = createDurableObjectNamespaceSecretStore(testEnv.PROVIDER_SECRET_STORE_DO);
    const secret = "secret-sentinel-" + "x".repeat(70_000);

    let failure: unknown;
    try {
      await store.putSecret({
        ref: { provider: "slack", tenantId: "tenant_1", secretId: "workspace:T123" },
        value: secret
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("provider secret store unavailable");
    expect(String(failure)).not.toContain("secret-sentinel");
  });

  it("rejects provider tokens larger than the symmetric 16 KiB round-trip limit", async () => {
    const store = createDurableObjectNamespaceSecretStore(testEnv.PROVIDER_SECRET_STORE_DO);

    await expect(
      store.putSecret({
        ref: { provider: "slack", tenantId: "tenant_1", secretId: "workspace:T123" },
        value: "é".repeat(8_193)
      })
    ).rejects.toThrow("provider secret store unavailable");
  });

  it("rejects malformed, oversized, and unknown internal requests without reflection", async () => {
    const stub = testEnv.PROVIDER_SECRET_STORE_DO.get(
      testEnv.PROVIDER_SECRET_STORE_DO.idFromName("protocol-security-test")
    );
    const malformed = await stub.fetch("https://provider-secret-store.internal/v1/put", {
      method: "POST",
      body: JSON.stringify({ token: "secret-sentinel" })
    });
    const oversized = await stub.fetch("https://provider-secret-store.internal/v1/put", {
      method: "POST",
      body: JSON.stringify({ token: "x".repeat(70_000) })
    });
    const unknown = await stub.fetch("https://provider-secret-store.internal/v1/export", {
      method: "POST",
      body: "{}"
    });

    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(unknown.status).toBe(404);
    expect(await malformed.text()).not.toContain("secret-sentinel");
    expect(oversized.headers.get("cache-control")).toBe("no-store");
    expect(unknown.headers.get("cache-control")).toBe("no-store");
  });
});

async function tenantObjectName(tenantId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tenantId));
  return `provider-secrets-v1-${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
