import { describe, expect, it } from "vitest";
import {
  createDurableObjectNamespaceOAuthStateStore,
  OAuthStateStoreDurableObject,
  OAuthStateStoreError
} from "../src/index.js";

const redirectUri = "https://admin.example.test/oauth/slack/callback";
const browserBinding = "browser_session_abcdefghijklmnopqrstuvwxyz012345";

describe("OAuth state store", () => {
  it("issues an opaque state and consumes its server-owned bindings exactly once", async () => {
    const harness = createHarness(new Date("2026-07-21T00:00:00.000Z"));
    const store = createDurableObjectNamespaceOAuthStateStore(harness.namespace, {
      now: harness.now
    });

    const issued = await store.issue({
      provider: "slack",
      appId: "app_1",
      tenantId: "tenant_1",
      actorSubject: "manager_1",
      browserBinding,
      redirectUri
    });

    expect(issued.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(issued.expiresAt).toEqual(new Date("2026-07-21T00:05:00.000Z"));
    await expect(store.consume({ state: issued.state, browserBinding })).resolves.toEqual({
      provider: "slack",
      appId: "app_1",
      tenantId: "tenant_1",
      actorSubject: "manager_1",
      redirectUri,
      issuedAt: new Date("2026-07-21T00:00:00.000Z"),
      expiresAt: new Date("2026-07-21T00:05:00.000Z")
    });
    await expectStateFailure(store.consume({ state: issued.state, browserBinding }));
  });

  it("never persists the plaintext state or browser binding", async () => {
    const harness = createHarness(new Date("2026-07-21T00:00:00.000Z"));
    const store = createDurableObjectNamespaceOAuthStateStore(harness.namespace, {
      now: harness.now
    });

    const issued = await store.issue({
      provider: "slack",
      appId: "app_1",
      tenantId: "tenant_1",
      actorSubject: "manager_1",
      browserBinding,
      redirectUri
    });

    const persisted = JSON.stringify(harness.persistedEntries());
    expect(persisted).not.toContain(issued.state);
    expect(persisted).not.toContain(browserBinding);
    expect(persisted).not.toContain("secret-sentinel");
  });

  it("rejects a different browser binding without consuming the legitimate state", async () => {
    const harness = createHarness(new Date("2026-07-21T00:00:00.000Z"));
    const store = createDurableObjectNamespaceOAuthStateStore(harness.namespace, {
      now: harness.now
    });
    const issued = await store.issue({
      provider: "slack",
      appId: "app_1",
      tenantId: "tenant_1",
      actorSubject: "manager_1",
      browserBinding,
      redirectUri
    });

    await expectStateFailure(
      store.consume({
        state: issued.state,
        browserBinding: "different_session_abcdefghijklmnopqrstuvwxyz012345"
      })
    );
    await expect(store.consume({ state: issued.state, browserBinding })).resolves.toMatchObject({
      tenantId: "tenant_1",
      actorSubject: "manager_1"
    });
  });

  it("expires at the exact server-owned deadline and removes the stale record", async () => {
    const harness = createHarness(new Date("2026-07-21T00:00:00.000Z"));
    const store = createStore(harness);
    const issued = await store.issue(validIssueInput());

    harness.setNow(issued.expiresAt);

    await expectStateFailure(store.consume({ state: issued.state, browserBinding }));
    expect(JSON.stringify(harness.persistedEntries())).not.toContain("tenant_1");
  });

  it("returns one success when the same state is consumed concurrently", async () => {
    const harness = createHarness(new Date("2026-07-21T00:00:00.000Z"));
    const store = createStore(harness);
    const issued = await store.issue(validIssueInput());

    const results = await Promise.allSettled([
      store.consume({ state: issued.state, browserBinding }),
      store.consume({ state: issued.state, browserBinding })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status !== "rejected") throw new Error("expected one rejected consumer");
    expect(rejected.reason).toBeInstanceOf(OAuthStateStoreError);
    expect(rejected.reason).toMatchObject({ code: "oauth_state_invalid" });
  });

  it("classifies an unknown but well-formed state without reflecting it", async () => {
    const harness = createHarness(new Date("2026-07-21T00:00:00.000Z"));
    const store = createStore(harness);
    const unknownState = "A".repeat(43);

    const failure = await captureStateError(store.consume({ state: unknownState, browserBinding }));

    expect(failure.toJSON()).toEqual({ code: "oauth_state_invalid" });
    expect(JSON.stringify(failure)).not.toContain(unknownState);
    expect(JSON.stringify(failure)).not.toContain(browserBinding);
  });

  it.each([
    ["unknown issue field", { ...validIssueInput(), extra: "secret-sentinel" }],
    ["unknown provider", { ...validIssueInput(), provider: "github" }],
    ["weak browser binding", { ...validIssueInput(), browserBinding: "short" }],
    ["HTTP redirect", { ...validIssueInput(), redirectUri: "http://admin.example.test/callback" }],
    ["redirect userinfo", { ...validIssueInput(), redirectUri: "https://user@example.test/cb" }],
    ["redirect fragment", { ...validIssueInput(), redirectUri: `${redirectUri}#fragment` }]
  ])("rejects %s before Durable Object access", async (_label, input) => {
    const harness = createHarness(new Date("2026-07-21T00:00:00.000Z"));
    const store = createStore(harness);

    const failure = await captureStateError(store.issue(input as never));

    expect(failure.toJSON()).toEqual({ code: "oauth_state_invalid_request" });
    expect(harness.objectCount()).toBe(0);
    expect(JSON.stringify(failure)).not.toContain("secret-sentinel");
  });

  it.each([59_999, 600_001, Number.NaN])("rejects invalid TTL %s", (ttlMs) => {
    const harness = createHarness(new Date("2026-07-21T00:00:00.000Z"));

    expect(() =>
      createDurableObjectNamespaceOAuthStateStore(harness.namespace, {
        ttlMs,
        now: harness.now
      })
    ).toThrow(expect.objectContaining({ code: "oauth_state_invalid_configuration" }));
  });

  it("keeps the earliest alarm and sweeps only expired records", async () => {
    const harness = createHarness(new Date("2026-07-21T00:00:00.000Z"));
    const firstExpiry = new Date("2026-07-21T00:05:00.000Z");
    const secondExpiry = new Date("2026-07-21T00:06:00.000Z");
    const issue = (stateDigest: string, tenantId: string, expiresAt: Date) =>
      harness.requestShard("oauth-state-v1-aa", "/v1/issue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stateDigest,
          browserBindingDigest: "b".repeat(64),
          provider: "slack",
          appId: "app_1",
          tenantId,
          actorSubject: "manager_1",
          redirectUri,
          issuedAtMs: harness.now().getTime(),
          expiresAtMs: expiresAt.getTime()
        })
      });

    expect((await issue(`aa${"0".repeat(62)}`, "tenant_1", firstExpiry)).status).toBe(204);
    expect((await issue(`aa${"1".repeat(62)}`, "tenant_2", secondExpiry)).status).toBe(204);

    expect(harness.alarms()).toEqual([firstExpiry.getTime()]);

    harness.setNow(firstExpiry);
    await harness.runDueAlarms();

    const persisted = JSON.stringify(harness.persistedEntries());
    expect(persisted).not.toContain("tenant_1");
    expect(persisted).toContain("tenant_2");
    expect(harness.alarms()).toEqual([secondExpiry.getTime()]);
  });

  it("rejects malformed, oversized, and unknown internal requests without reflection", async () => {
    const harness = createHarness(new Date("2026-07-21T00:00:00.000Z"));
    const wrongContentType = await harness.requestShard("oauth-state-v1-aa", "/v1/issue", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({
        stateDigest: `aa${"2".repeat(62)}`,
        browserBindingDigest: "b".repeat(64),
        provider: "slack",
        appId: "app_1",
        tenantId: "tenant_1",
        actorSubject: "manager_1",
        redirectUri,
        issuedAtMs: harness.now().getTime(),
        expiresAtMs: harness.now().getTime() + 300_000
      })
    });
    const malformed = await harness.requestShard("oauth-state-v1-aa", "/v1/issue", {
      method: "POST",
      body: "{not-json-secret-sentinel"
    });
    const oversized = await harness.requestShard("oauth-state-v1-aa", "/v1/issue", {
      method: "POST",
      body: JSON.stringify({ unexpected: "x".repeat(17_000) })
    });
    const unknownField = await harness.requestShard("oauth-state-v1-aa", "/v1/consume", {
      method: "POST",
      body: JSON.stringify({
        stateDigest: "a".repeat(64),
        browserBindingDigest: "b".repeat(64),
        secret: "secret-sentinel"
      })
    });
    const unknownPath = await harness.requestShard("oauth-state-v1-aa", "/v1/export", {
      method: "POST",
      body: "{}"
    });

    expect(wrongContentType.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(unknownField.status).toBe(400);
    expect(unknownPath.status).toBe(404);
    const publicSurface = JSON.stringify([
      await malformed.text(),
      await oversized.text(),
      await unknownField.text(),
      await unknownPath.text()
    ]);
    expect(publicSurface).not.toContain("secret-sentinel");
    expect(malformed.headers.get("Cache-Control")).toBe("no-store");
  });
});

async function expectStateFailure(value: Promise<unknown>): Promise<void> {
  const failure = await captureStateError(value);
  expect(failure.toJSON()).toEqual({ code: "oauth_state_invalid" });
  expect(JSON.stringify(failure)).not.toContain("secret-sentinel");
}

async function captureStateError(value: Promise<unknown>): Promise<OAuthStateStoreError> {
  let failure: unknown;
  try {
    await value;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(OAuthStateStoreError);
  return failure as OAuthStateStoreError;
}

function validIssueInput() {
  return {
    provider: "slack" as const,
    appId: "app_1",
    tenantId: "tenant_1",
    actorSubject: "manager_1",
    browserBinding,
    redirectUri
  };
}

function createStore(harness: ReturnType<typeof createHarness>) {
  return createDurableObjectNamespaceOAuthStateStore(harness.namespace, {
    now: harness.now
  });
}

function createHarness(initialNow: Date): {
  namespace: never;
  now: () => Date;
  setNow: (value: Date) => void;
  persistedEntries: () => unknown[];
  objectCount: () => number;
  alarms: () => number[];
  runDueAlarms: () => Promise<void>;
  requestShard: (id: string, path: string, init: RequestInit) => Promise<Response>;
} {
  const objects = new Map<
    string,
    { instance: OAuthStateStoreDurableObject; storage: InMemoryDurableObjectStorage }
  >();
  let now = initialNow;
  const getObject = (id: string) => {
    let object = objects.get(id);
    if (object === undefined) {
      const storage = new InMemoryDurableObjectStorage();
      object = {
        storage,
        instance: new OAuthStateStoreDurableObject(
          {
            storage,
            blockConcurrencyWhile: <T>(closure: () => Promise<T>) => closure()
          },
          {},
          { now: () => new Date(now) }
        )
      };
      objects.set(id, object);
    }
    return object;
  };
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: (input: string, init: RequestInit) => {
        return getObject(id).instance.fetch(new Request(input, init));
      }
    })
  };
  return {
    namespace: namespace as never,
    now: () => new Date(now),
    setNow: (value) => {
      now = value;
    },
    persistedEntries: () =>
      [...objects.values()].flatMap(({ storage }) => [...storage.values.entries()]),
    objectCount: () => objects.size,
    alarms: () => [...objects.values()].flatMap(({ storage }) => storage.alarm ?? []),
    runDueAlarms: async () => {
      for (const { instance, storage } of objects.values()) {
        if (storage.alarm !== null && storage.alarm <= now.getTime()) await instance.alarm();
      }
    },
    requestShard: (id, path, init) =>
      getObject(id).instance.fetch(new Request(`https://oauth-state-store.internal${path}`, init))
  };
}

class InMemoryDurableObjectStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }

  list<T>(): Promise<Map<string, T>> {
    return Promise.resolve(new Map(this.values as Map<string, T>));
  }

  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarm);
  }

  setAlarm(value: number): Promise<void> {
    this.alarm = value;
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarm = null;
    return Promise.resolve();
  }

  transaction<T>(
    closure: (transaction: InMemoryDurableObjectTransaction) => Promise<T>
  ): Promise<T> {
    return closure(new InMemoryDurableObjectTransaction(this));
  }
}

class InMemoryDurableObjectTransaction {
  constructor(private readonly storage: InMemoryDurableObjectStorage) {}

  get<T>(key: string): Promise<T | undefined> {
    return this.storage.get<T>(key);
  }

  put(key: string, value: unknown): Promise<void> {
    return this.storage.put(key, value);
  }

  delete(key: string): Promise<boolean> {
    return this.storage.delete(key);
  }

  list<T>(): Promise<Map<string, T>> {
    return this.storage.list<T>();
  }
}
