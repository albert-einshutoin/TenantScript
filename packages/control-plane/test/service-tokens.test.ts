import { describe, expect, it } from "vitest";
import {
  ServiceTokenError,
  createServiceTokenManager,
  createServiceTokenIdentityResolver,
  createServiceTokenAwareIdentityResolver,
  type ServiceTokenManager,
  type ServiceTokenRecord,
  type ServiceTokenStore
} from "../src/service-tokens.js";

const now = new Date("2026-07-20T00:00:00.000Z");

describe("service tokens", () => {
  it("returns the credential once while persisting only its SHA-256 digest", async () => {
    const store = memoryStore();
    const manager = createServiceTokenManager({
      store,
      now: () => now,
      generateId: () => "st_01",
      generateSecret: () => "secret-value-with-sufficient-entropy"
    });

    const issued = await manager.issue({
      appId: "app_1",
      tenantId: "tenant_1",
      actor: "owner_1",
      actorRole: "owner",
      label: "deployment bot",
      role: "operator",
      scopes: ["session:read", "dashboard:read"],
      expiresAt: new Date("2026-07-21T00:00:00.000Z")
    });

    expect(issued).toMatchObject({
      id: "st_01",
      token: "ts_service_secret-value-with-sufficient-entropy",
      label: "deployment bot",
      role: "operator",
      scopes: ["session:read", "dashboard:read"]
    });
    expect(store.records).toHaveLength(1);
    expect(store.records[0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(store.records)).not.toContain(issued.token);
    expect(JSON.stringify(store.records)).not.toContain("secret-value-with-sufficient-entropy");
  });

  it("resolves active credentials with their explicit operation scope", async () => {
    const store = memoryStore();
    const manager = managerFor(store);
    const issued = await manager.issue(validIssue());
    const resolver = createServiceTokenIdentityResolver(store, { now: () => now });

    await expect(resolver.resolveToken(issued.token)).resolves.toEqual({
      subject: "service-token:st_01",
      role: "operator",
      appId: "app_1",
      tenantId: "tenant_1",
      allowedOperations: ["session:read", "dashboard:read"]
    });
    await expect(resolver.resolveToken("unrelated-token")).resolves.toBeNull();
  });

  it("rejects expired and immediately revoked credentials", async () => {
    const store = memoryStore();
    const manager = managerFor(store);
    const issued = await manager.issue(validIssue());
    const resolver = createServiceTokenIdentityResolver(store, { now: () => now });

    await expect(
      manager.revoke({
        id: issued.id,
        appId: "app_1",
        tenantId: "tenant_1",
        actor: "owner_1",
        actorRole: "owner"
      })
    ).resolves.toBe(true);
    await expect(resolver.resolveToken(issued.token)).resolves.toBeNull();

    const expiredResolver = createServiceTokenIdentityResolver(store, {
      now: () => new Date("2026-07-22T00:00:00.000Z")
    });
    await expect(expiredResolver.resolveToken(issued.token)).resolves.toBeNull();
  });

  it("prevents role escalation, out-of-role scopes, and token-minting scopes", async () => {
    const manager = managerFor(memoryStore());

    await expect(
      manager.issue({ ...validIssue(), actorRole: "admin", role: "owner" })
    ).rejects.toMatchObject({ code: "service_token_role_escalation" });
    await expect(
      manager.issue({ ...validIssue(), role: "viewer", scopes: ["installation:manage"] })
    ).rejects.toMatchObject({ code: "service_token_scope_forbidden" });
    await expect(
      manager.issue({ ...validIssue(), scopes: ["service-token:issue"] })
    ).rejects.toMatchObject({ code: "service_token_scope_forbidden" });
  });

  it("rejects empty, duplicate, past, and overlong grants before persistence", async () => {
    const store = memoryStore();
    const manager = managerFor(store);
    const cases: Array<Parameters<ServiceTokenManager["issue"]>[0]> = [
      { ...validIssue(), scopes: [] },
      { ...validIssue(), scopes: ["session:read", "session:read"] },
      { ...validIssue(), expiresAt: now },
      { ...validIssue(), expiresAt: new Date("2026-10-19T00:00:00.001Z") }
    ];

    for (const input of cases) {
      await expect(manager.issue(input)).rejects.toBeInstanceOf(ServiceTokenError);
    }
    expect(store.records).toHaveLength(0);
  });

  it("uses cryptographic defaults and rejects invalid generator output", async () => {
    const store = memoryStore();
    const generated = await createServiceTokenManager({ store, now: () => now }).issue(
      validIssue()
    );
    expect(generated.id).toMatch(/^st_[0-9a-f-]{36}$/u);
    expect(generated.token).toMatch(/^ts_service_[a-f0-9]{64}$/u);

    await expect(
      createServiceTokenManager({
        store,
        now: () => now,
        generateId: () => "invalid",
        generateSecret: () => "secret-value-with-sufficient-entropy"
      }).issue(validIssue())
    ).rejects.toThrow("service token generator returned invalid output");
    await expect(
      createServiceTokenManager({
        store,
        now: () => now,
        generateId: () => "st_valid",
        generateSecret: () => "short"
      }).issue(validIssue())
    ).rejects.toThrow("service token generator returned invalid output");
  });

  it("denies unauthorized revocation and never falls managed tokens back to bootstrap", async () => {
    const store = memoryStore();
    const manager = managerFor(store);
    expect(() =>
      manager.revoke({
        id: "st_01",
        appId: "app_1",
        tenantId: "tenant_1",
        actor: "viewer_1",
        actorRole: "viewer"
      })
    ).toThrow(ServiceTokenError);

    const resolver = createServiceTokenAwareIdentityResolver({
      serviceTokens: { resolveToken: () => null },
      bootstrap: {
        resolveToken: (token) =>
          token === "ts_service_revoked" || token === "bootstrap"
            ? { subject: "bootstrap", role: "owner" }
            : null
      }
    });
    expect(await resolver.resolveToken("ts_service_revoked")).toBeNull();
    expect(await resolver.resolveToken("bootstrap")).toMatchObject({
      subject: "bootstrap"
    });
    expect(
      await createServiceTokenAwareIdentityResolver({
        serviceTokens: { resolveToken: () => null }
      }).resolveToken("unknown")
    ).toBeNull();
  });
});

function validIssue() {
  return {
    appId: "app_1",
    tenantId: "tenant_1",
    actor: "owner_1",
    actorRole: "owner",
    label: "deployment bot",
    role: "operator" as const,
    scopes: ["session:read", "dashboard:read"] as const,
    expiresAt: new Date("2026-07-21T00:00:00.000Z")
  };
}

function managerFor(store: ServiceTokenStore) {
  return createServiceTokenManager({
    store,
    now: () => now,
    generateId: () => "st_01",
    generateSecret: () => "secret-value-with-sufficient-entropy"
  });
}

function memoryStore(): ServiceTokenStore & { records: ServiceTokenRecord[] } {
  const records: ServiceTokenRecord[] = [];
  return {
    records,
    create: (record) => {
      records.push(structuredClone(record));
      return Promise.resolve();
    },
    findByTokenHash: (tokenHash) =>
      Promise.resolve(records.find((record) => record.tokenHash === tokenHash) ?? null),
    revoke: ({ id, appId, tenantId, revokedAt, revokedBy }) => {
      const record = records.find(
        (candidate) =>
          candidate.id === id && candidate.appId === appId && candidate.tenantId === tenantId
      );
      if (record === undefined) return Promise.resolve(false);
      record.revokedAt ??= revokedAt;
      record.revokedBy ??= revokedBy;
      return Promise.resolve(true);
    }
  };
}
