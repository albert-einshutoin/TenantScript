import { describe, expect, it } from "vitest";
import { createD1AdminRollbackStore } from "../src/admin-rollbacks.js";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../src/storage.js";

describe("D1 Admin rollback adapter", () => {
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
  options: { runError?: Error } = {}
): D1DatabaseLike & { bindings: unknown[][]; runs: unknown[][] } {
  const bindings: unknown[][] = [];
  const runs: unknown[][] = [];
  let rowIndex = 0;
  return {
    bindings,
    runs,
    prepare: () => {
      const statement: D1PreparedStatementLike = {
        bind: (...values) => {
          bindings.push(values);
          return statement;
        },
        first: () => Promise.resolve((rows[rowIndex++] ?? null) as never),
        all: () => Promise.resolve({ results: [] }),
        run: () => {
          runs.push([]);
          return options.runError === undefined
            ? Promise.resolve(undefined)
            : Promise.reject(options.runError);
        }
      };
      return statement;
    }
  };
}
