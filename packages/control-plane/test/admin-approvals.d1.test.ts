import { describe, expect, it, vi } from "vitest";
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

  it("atomically creates the installation and both audit records for an approved grant request", async () => {
    const db = database([
      { ...pending(), role: "admin", resume_hook: "installation.request" },
      installationRequest()
    ]);
    const store = createD1AdminApprovalDecisionStore(db, {
      auditId: () => "approval_audit_1",
      installationAuditId: () => "installation_audit_1",
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    await expect(
      store.decide({ ...request(), actor: "admin-subject", actorRole: "admin" })
    ).resolves.toMatchObject({
      state: "approved",
      installation: {
        id: "installation_1",
        versionId: "version_1",
        enabled: false,
        priority: 10,
        revision: 0
      }
    });
    expect(db.batch).toHaveBeenCalledTimes(1);
    const statements = db.batch.mock.calls[0]?.[0] ?? [];
    expect(statements).toHaveLength(3);
    expect(db.bindings[3]).toContain(JSON.stringify({ channel: "C123" }));
    expect(db.bindings[3]).toContain(JSON.stringify({ "slack.send": { channel: "C123" } }));
    expect(db.bindings[4]).toContain(
      JSON.stringify({
        enabled: false,
        priority: 10,
        revision: 0,
        configFields: ["channel"],
        capabilities: ["slack.send"]
      })
    );
    expect(JSON.stringify(db.bindings[4])).not.toContain("C123");
  });

  it("fails closed when an installation approval has no scoped proposal or D1 batch", async () => {
    const approval = { ...pending(), role: "admin", resume_hook: "installation.request" };
    await expect(
      createD1AdminApprovalDecisionStore(database([approval, null])).decide({
        ...request(),
        actorRole: "admin"
      })
    ).rejects.toThrow("installation approval request unavailable");

    const db = database([approval, installationRequest()]);
    delete (db as Partial<typeof db>).batch;
    await expect(
      createD1AdminApprovalDecisionStore(db).decide({ ...request(), actorRole: "admin" })
    ).rejects.toThrow("D1 batch is unavailable");
  });

  it.each([
    ["invalid config JSON", { config_json: "{" }],
    ["non-object config", { config_json: "[]" }],
    ["non-object grants", { grants_json: "[]" }],
    ["non-array capabilities", { capabilities_json: "{}" }],
    ["non-string capability", { capabilities_json: '["slack.send",1]' }],
    ["missing installation id", { installation_id: null }],
    ["invalid enabled flag", { enabled: 2 }],
    ["unsafe priority", { priority: 1.5 }]
  ])("rejects %s in a stored installation proposal", async (_label, mutation) => {
    const approval = { ...pending(), role: "admin", resume_hook: "installation.request" };
    const store = createD1AdminApprovalDecisionStore(
      database([approval, { ...installationRequest(), ...mutation }])
    );

    await expect(store.decide({ ...request(), actorRole: "admin" })).rejects.toThrow(
      "invalid installation approval request"
    );
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
    expires_at: "2026-07-21T00:00:00.000Z",
    resume_hook: "approval.decided"
  };
}

function installationRequest() {
  return {
    installation_id: "installation_1",
    plugin_id: "plugin_1",
    version_id: "version_1",
    plugin_key: "invoice-notify",
    version: "1.0.0",
    config_json: JSON.stringify({ channel: "C123" }),
    grants_json: JSON.stringify({ "slack.send": { channel: "C123" } }),
    capabilities_json: JSON.stringify(["slack.send"]),
    enabled: 0,
    priority: 10
  };
}

function database(
  rows: unknown[],
  runError?: Error
): D1DatabaseLike & {
  bindings: unknown[][];
  runCalls: number;
  batch: ReturnType<typeof vi.fn<(statements: D1PreparedStatementLike[]) => Promise<unknown>>>;
} {
  const bindings: unknown[][] = [];
  let rowIndex = 0;
  const db = {
    bindings,
    runCalls: 0,
    batch: vi
      .fn<(statements: D1PreparedStatementLike[]) => Promise<unknown>>()
      .mockResolvedValue([]),
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
