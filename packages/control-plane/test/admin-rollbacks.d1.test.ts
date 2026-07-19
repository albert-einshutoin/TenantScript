import { describe, expect, it } from "vitest";
import { createD1AdminRollbackStore } from "../src/admin-rollbacks.js";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../src/storage.js";

describe("D1 Admin rollback adapter", () => {
  it("recovers a strict stored result and rejects key reuse or extra stored fields", async () => {
    const storedResult = {
      outcome: "rolled_back",
      installationId: "installation_1",
      pluginKey: "invoice-notify",
      fromVersion: "1.3.0",
      toVersion: "1.2.2",
      revision: 4,
      auditId: "audit_rollback_1",
      completedAt: "2026-07-19T17:00:00.000Z"
    };
    const requestHash = await fingerprint(request());
    const row = {
      request_hash: requestHash,
      result_json: JSON.stringify(storedResult),
      expires_at: "2099-01-01T00:00:00.000Z"
    };

    await expect(
      createD1AdminRollbackStore(database([], { idempotencyRow: row })).rollback(request())
    ).resolves.toEqual(storedResult);
    await expect(
      createD1AdminRollbackStore(database([], { idempotencyRow: row })).rollback({
        ...request(),
        targetVersionId: "changed"
      })
    ).rejects.toMatchObject({ code: "idempotency_key_reused" });
    await expect(
      createD1AdminRollbackStore(
        database([], {
          idempotencyRow: {
            ...row,
            result_json: JSON.stringify({ ...storedResult, secret: "must-not-return" })
          }
        })
      ).rollback(request())
    ).rejects.toThrow("invalid rollback idempotency record");
  });

  it("ignores expired records and fails closed when atomic batch is unavailable", async () => {
    const expired = database([null], {
      idempotencyRow: {
        request_hash: "old",
        result_json: "{}",
        expires_at: "2000-01-01T00:00:00.000Z"
      }
    });
    await expect(createD1AdminRollbackStore(expired).rollback(request())).resolves.toBeNull();

    const unavailable = database([rollbackRow()]);
    delete (unavailable as Partial<typeof unavailable>).batch;
    await expect(createD1AdminRollbackStore(unavailable).rollback(request())).rejects.toThrow(
      "D1 batch is unavailable"
    );
  });

  it("writes one CAS-backed audit event without stored config or grant values", async () => {
    const db = database([rollbackRow()]);
    const store = createD1AdminRollbackStore(db, {
      auditId: () => "audit_rollback_1",
      now: () => new Date("2026-07-19T17:00:00.000Z")
    });

    await expect(store.rollback(request())).resolves.toEqual({
      outcome: "rolled_back",
      installationId: "installation_1",
      pluginKey: "invoice-notify",
      fromVersion: "1.3.0",
      toVersion: "1.2.2",
      revision: 4,
      auditId: "audit_rollback_1",
      completedAt: "2026-07-19T17:00:00.000Z"
    });
    expect(db.runs).toHaveLength(1);
    expect(db.bindings.flat()).not.toContain("secret-config");
    expect(db.bindings.flat()).not.toContain("secret-grant");
    expect(db.bindings.flat()).toContain("installation.rollback");
    expect(db.bindings.flat()).toContain(
      '{"versionId":"version_1_3_0","version":"1.3.0","revision":3}'
    );
    expect(db.bindings.flat()).toContain(
      '{"versionId":"version_1_2_2","version":"1.2.2","revision":4}'
    );
  });

  it("returns common missing, same-version, and stale outcomes without writing", async () => {
    const db = database([
      null,
      { ...rollbackRow(), target_version_id: "version_1_3_0" },
      rollbackRow()
    ]);
    const store = createD1AdminRollbackStore(db);

    await expect(store.rollback(request())).resolves.toBeNull();
    await expect(store.rollback(request())).resolves.toEqual({
      outcome: "same_version",
      installationId: "installation_1",
      revision: 3
    });
    await expect(store.rollback({ ...request(), expectedRevision: 2 })).resolves.toEqual({
      outcome: "conflict",
      installationId: "installation_1",
      revision: 3
    });
    expect(db.runs).toEqual([]);
  });

  it("maps an interleaving writer to a revision conflict", async () => {
    const db = database([rollbackRow(), { ...rollbackRow(), revision: 4 }], {
      runError: new Error("installation rollback conflict")
    });
    const store = createD1AdminRollbackStore(db);

    await expect(store.rollback(request())).resolves.toEqual({
      outcome: "conflict",
      installationId: "installation_1",
      revision: 4
    });
  });
});

function request() {
  return {
    appId: "app_acme",
    tenantId: "tenant_acme",
    actor: "manager-subject",
    idempotencyKey: "rollback-d1-key-0001",
    installationId: "installation_1",
    targetVersionId: "version_1_2_2",
    expectedRevision: 3
  };
}

function rollbackRow() {
  return {
    installation_id: "installation_1",
    tenant_id: "tenant_acme",
    plugin_id: "plugin_1",
    plugin_key: "invoice-notify",
    current_version_id: "version_1_3_0",
    current_version: "1.3.0",
    target_version_id: "version_1_2_2",
    target_version: "1.2.2",
    revision: 3
  };
}

function database(
  rows: readonly (ReturnType<typeof rollbackRow> | null)[],
  options: {
    runError?: Error;
    idempotencyRow?: { request_hash: string; result_json: string; expires_at: string };
  } = {}
): D1DatabaseLike & {
  bindings: unknown[][];
  runs: unknown[][];
  batch: (statements: D1PreparedStatementLike[]) => Promise<unknown>;
} {
  const bindings: unknown[][] = [];
  const runs: unknown[][] = [];
  let rowIndex = 0;
  return {
    bindings,
    runs,
    prepare: (query) => {
      const statement: D1PreparedStatementLike = {
        bind: (...values) => {
          bindings.push(values);
          return statement;
        },
        first: () =>
          Promise.resolve(
            (query.includes("admin_rollback_idempotency")
              ? (options.idempotencyRow ?? null)
              : (rows[rowIndex++] ?? null)) as never
          ),
        all: () => Promise.resolve({ results: [] }),
        run: () => {
          runs.push([]);
          return options.runError === undefined
            ? Promise.resolve(undefined)
            : Promise.reject(options.runError);
        }
      };
      return statement;
    },
    batch: () => {
      runs.push([]);
      return options.runError === undefined
        ? Promise.resolve(undefined)
        : Promise.reject(options.runError);
    }
  };
}

async function fingerprint(value: ReturnType<typeof request>): Promise<string> {
  const canonical = JSON.stringify({
    installationId: value.installationId,
    targetVersionId: value.targetVersionId,
    expectedRevision: value.expectedRevision
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
