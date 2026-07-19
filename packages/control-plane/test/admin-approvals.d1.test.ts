import { describe, expect, it } from "vitest";
import { createD1AdminApprovalDecisionStore } from "../src/admin-approvals.js";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../src/storage.js";

describe("D1 Admin approval decision adapter", () => {
  it("writes the scoped audit command and returns correlated evidence", async () => {
    const db = database([pending()]);
    const store = createD1AdminApprovalDecisionStore(db, {
      auditId: () => "audit_1",
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    await expect(store.decide(request())).resolves.toEqual({
      approvalId: "approval_1",
      state: "approved",
      auditId: "audit_1",
      decidedAt: "2026-07-20T00:00:00.000Z"
    });
    expect(db.bindings[0]).toEqual(["approval_1", "tenant_1", "app_1"]);
    expect(db.bindings[1]).toEqual([
      "audit_1",
      "approval_1",
      "tenant_1",
      "app_1",
      "plugin_1",
      "manager",
      "manager",
      "approved",
      null,
      "2026-07-20T00:00:00.000Z"
    ]);
  });

  it.each(["owner", "admin", "tenant-admin", "manager"])(
    "allows %s to decide a Phase 1 manager approval during migration",
    async (actorRole) => {
      const db = database([pending()]);
      const store = createD1AdminApprovalDecisionStore(db, {
        auditId: () => "audit_rbac",
        now: () => new Date("2026-07-20T00:00:00.000Z")
      });

      await expect(store.decide({ ...request(), actorRole })).resolves.toMatchObject({
        state: "approved"
      });
      expect(db.bindings[1]?.[6]).toBe(actorRole);
    }
  );

  it.each([
    ["missing", null, request(), "approval_not_found"],
    ["viewer", pending(), { ...request(), actorRole: "viewer" }, "approval_role_forbidden"],
    ["wrong role", { ...pending(), role: "owner" }, request(), "approval_role_forbidden"],
    ["decided", { ...pending(), state: "rejected" }, request(), "approval_already_decided"],
    [
      "expired",
      { ...pending(), expires_at: "2026-07-20T00:00:00.000Z" },
      request(),
      "approval_expired"
    ]
  ])("rejects %s approvals before audit", async (_label, row, input, code) => {
    const db = database([row]);
    const store = createD1AdminApprovalDecisionStore(db, {
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    await expect(store.decide(input)).rejects.toMatchObject({ code });
    expect(db.runCalls).toBe(0);
  });

  it("maps a raced decision to a stable conflict", async () => {
    const db = database([pending(), { ...pending(), state: "approved" }], new Error("conflict"));
    const store = createD1AdminApprovalDecisionStore(db, {
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    await expect(store.decide(request())).rejects.toMatchObject({
      code: "approval_already_decided"
    });
  });

  it("does not hide an unrelated audit storage failure", async () => {
    const failure = new Error("storage unavailable");
    const db = database([pending(), pending()], failure);
    const store = createD1AdminApprovalDecisionStore(db, {
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    await expect(store.decide({ ...request(), reason: "validated" })).rejects.toBe(failure);
  });

  it("rejects malformed storage rows", async () => {
    const store = createD1AdminApprovalDecisionStore(database([{ ...pending(), role: null }]));
    await expect(store.decide(request())).rejects.toThrow("invalid approval decision row");
  });
});

function request() {
  return {
    appId: "app_1",
    tenantId: "tenant_1",
    actor: "manager",
    actorRole: "manager",
    approvalId: "approval_1",
    decision: "approved" as const
  };
}

function pending() {
  return {
    plugin_id: "plugin_1",
    role: "manager",
    state: "pending",
    expires_at: "2026-07-21T00:00:00.000Z"
  };
}

function database(
  rows: unknown[],
  runError?: Error
): D1DatabaseLike & {
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
          return runError === undefined ? Promise.resolve(undefined) : Promise.reject(runError);
        },
        first: <T>() => Promise.resolve((rows[rowIndex++] ?? null) as T | null),
        all: () => Promise.resolve({ results: [] })
      };
      return statement;
    }
  };
  return db;
}
