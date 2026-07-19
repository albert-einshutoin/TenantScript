import { describe, expect, it } from "vitest";
import { createD1ServiceTokenStore, type ServiceTokenRecord } from "../src/service-tokens.js";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../src/storage.js";

describe("D1 service token adapter", () => {
  it("persists only digest and scoped metadata", async () => {
    const db = database([]);
    const store = createD1ServiceTokenStore(db);

    await store.create(record());

    expect(db.bindings[0]).toEqual([
      "st_01",
      "a".repeat(64),
      "deployment bot",
      "operator",
      "app_1",
      "tenant_1",
      '["session:read","dashboard:read"]',
      "owner_1",
      "2026-07-20T00:00:00.000Z",
      "2026-07-21T00:00:00.000Z"
    ]);
    expect(JSON.stringify(db.bindings)).not.toContain("ts_service_");
  });

  it("loads a valid row and fails closed for malformed scopes", async () => {
    const valid = row();
    await expect(
      createD1ServiceTokenStore(database([valid])).findByTokenHash("a".repeat(64))
    ).resolves.toEqual(record());
    await expect(
      createD1ServiceTokenStore(
        database([{ ...valid, scopes_json: '["rbac:manage"]' }])
      ).findByTokenHash("a".repeat(64))
    ).rejects.toThrow("invalid service token row");
    await expect(
      createD1ServiceTokenStore(database([{ ...valid, scopes_json: "[" }])).findByTokenHash(
        "a".repeat(64)
      )
    ).rejects.toThrow("invalid service token row");
    await expect(
      createD1ServiceTokenStore(
        database([{ ...valid, revoked_at: valid.created_at, revoked_by: "owner_1" }])
      ).findByTokenHash("a".repeat(64))
    ).resolves.toMatchObject({ revokedAt: valid.created_at, revokedBy: "owner_1" });
    await expect(
      createD1ServiceTokenStore(database([null])).findByTokenHash("a".repeat(64))
    ).resolves.toBeNull();
  });

  it("scopes revocation by app and tenant", async () => {
    const found = database([{ id: "st_01" }]);
    const store = createD1ServiceTokenStore(found);

    await expect(
      store.revoke({
        id: "st_01",
        appId: "app_1",
        tenantId: "tenant_1",
        revokedAt: "2026-07-20T01:00:00.000Z",
        revokedBy: "owner_1"
      })
    ).resolves.toBe(true);
    expect(found.bindings).toEqual([
      ["st_01", "app_1", "tenant_1"],
      ["2026-07-20T01:00:00.000Z", "owner_1", "st_01", "app_1", "tenant_1"]
    ]);

    const missing = database([null]);
    await expect(
      createD1ServiceTokenStore(missing).revoke({
        id: "st_other",
        appId: "app_1",
        tenantId: "tenant_1",
        revokedAt: "2026-07-20T01:00:00.000Z",
        revokedBy: "owner_1"
      })
    ).resolves.toBe(false);
    expect(missing.runCalls).toBe(0);

    const corrupt = database([{ id: "st_different" }]);
    await expect(
      createD1ServiceTokenStore(corrupt).revoke({
        id: "st_other",
        appId: "app_1",
        tenantId: "tenant_1",
        revokedAt: "2026-07-20T01:00:00.000Z",
        revokedBy: "owner_1"
      })
    ).resolves.toBe(false);
  });
});

function record(): ServiceTokenRecord {
  return {
    id: "st_01",
    tokenHash: "a".repeat(64),
    label: "deployment bot",
    role: "operator",
    appId: "app_1",
    tenantId: "tenant_1",
    scopes: ["session:read", "dashboard:read"],
    createdBy: "owner_1",
    createdAt: "2026-07-20T00:00:00.000Z",
    expiresAt: "2026-07-21T00:00:00.000Z"
  };
}

function row() {
  return {
    id: "st_01",
    token_hash: "a".repeat(64),
    label: "deployment bot",
    role: "operator",
    app_id: "app_1",
    tenant_id: "tenant_1",
    scopes_json: '["session:read","dashboard:read"]',
    created_by: "owner_1",
    created_at: "2026-07-20T00:00:00.000Z",
    expires_at: "2026-07-21T00:00:00.000Z",
    revoked_at: null,
    revoked_by: null
  };
}

function database(rows: unknown[]): D1DatabaseLike & {
  bindings: unknown[][];
  runCalls: number;
} {
  const bindings: unknown[][] = [];
  let rowIndex = 0;
  const db = {
    bindings,
    runCalls: 0,
    prepare: () => {
      const statement: D1PreparedStatementLike = {
        bind: (...values) => {
          bindings.push(values);
          return statement;
        },
        run: () => {
          db.runCalls += 1;
          return Promise.resolve(undefined);
        },
        first: <T>() => Promise.resolve((rows[rowIndex++] ?? null) as T | null),
        all: () => Promise.resolve({ results: [] })
      };
      return statement;
    }
  };
  return db;
}
