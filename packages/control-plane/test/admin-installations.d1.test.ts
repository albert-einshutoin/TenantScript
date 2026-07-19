import { describe, expect, it } from "vitest";
import {
  createD1AdminInstallationCommandStore,
  createD1AdminInstallationDetailStore
} from "../src/admin-installations.js";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../src/storage.js";

describe("D1 admin installation detail adapter", () => {
  it("projects schema and capability metadata without returning config, grants, or manifests", async () => {
    const store = createD1AdminInstallationDetailStore(
      database({
        id: "inst_1",
        plugin_key: "invoice-notify",
        version: "1.2.3",
        enabled: 1,
        priority: 10,
        revision: 0,
        config_json: '{"notifyChannel":"C123","retries":3}',
        grants_json: '{"slack.send":{"channel":"C123"},"invoice.read":{"fields":["id"]}}',
        manifest_json: JSON.stringify({
          configSchema: {
            properties: {
              notifyChannel: { type: "string" },
              retries: { type: "number", default: 1 },
              dryRun: { type: "boolean", default: false }
            },
            required: ["notifyChannel"]
          },
          capabilities: {
            "slack.send": { channel: "$config.notifyChannel" },
            "invoice.read": { fields: ["id"] },
            "audit.write": { destination: "$config.auditDestination" }
          },
          egress: { mode: "allowlist", hosts: ["api.example.com", "audit.example.com"] }
        })
      })
    );

    const detail = await store.readInstallation({
      appId: "app_acme",
      tenantId: "tenant_acme",
      id: "inst_1"
    });

    expect(detail).toEqual({
      id: "inst_1",
      pluginKey: "invoice-notify",
      version: "1.2.3",
      enabled: true,
      priority: 10,
      revision: 0,
      egress: { mode: "allowlist", allowlistedHostCount: 2 },
      configFields: [
        { name: "dryRun", type: "boolean", required: false, configured: false, hasDefault: true },
        {
          name: "notifyChannel",
          type: "string",
          required: true,
          configured: true,
          hasDefault: false
        },
        { name: "retries", type: "number", required: false, configured: true, hasDefault: true }
      ],
      capabilities: [
        {
          name: "audit.write",
          scopeKeys: ["destination"],
          configReferences: ["auditDestination"],
          status: "missing"
        },
        { name: "invoice.read", scopeKeys: ["fields"], configReferences: [], status: "granted" },
        {
          name: "slack.send",
          scopeKeys: ["channel"],
          configReferences: ["notifyChannel"],
          status: "granted"
        }
      ]
    });
    expect(JSON.stringify(detail)).not.toContain("C123");
    expect(JSON.stringify(detail)).not.toContain("manifest_json");
  });

  it("uses both app and tenant scope in the D1 join and returns null when not found", async () => {
    const db = database(null);
    const store = createD1AdminInstallationDetailStore(db);

    await expect(
      store.readInstallation({ appId: "app_acme", tenantId: "tenant_acme", id: "inst_other" })
    ).resolves.toBeNull();
    expect(db.queries[0]).toContain(
      "t.id = ?1 AND t.app_id = ?2 AND p.app_id = t.app_id AND i.id = ?3"
    );
    expect(db.bindings[0]).toEqual(["tenant_acme", "app_acme", "inst_other"]);
  });
});

describe("D1 admin installation command adapter", () => {
  it("uses a revision CAS batch and writes only structured before/after audit values", async () => {
    const db = commandDatabase([{ ...commandRow(), revision: 0 }]);
    const store = createD1AdminInstallationCommandStore(db, { auditId: () => "audit_1" });

    await expect(
      store.updateInstallation({
        appId: "app_acme",
        tenantId: "tenant_acme",
        actor: 'manager"subject',
        id: "inst_1",
        expectedRevision: 0,
        enabled: false
      })
    ).resolves.toEqual({
      outcome: "updated",
      id: "inst_1",
      enabled: false,
      priority: 10,
      revision: 1,
      changed: true
    });
    expect(db.batches).toHaveLength(1);
    expect(db.bindings.flat()).not.toContain("secret-config");
    expect(db.bindings.flat()).not.toContain("secret-grant");
    expect(db.bindings.flat()).toContain('{"enabled":true,"priority":10,"revision":0}');
    expect(db.bindings.flat()).toContain('{"enabled":false,"priority":10,"revision":1}');
  });

  it("does not create a batch for no-op or already-stale revisions", async () => {
    const db = commandDatabase([{ ...commandRow(), revision: 2 }, { ...commandRow(), revision: 2 }]);
    const store = createD1AdminInstallationCommandStore(db);
    await expect(
      store.updateInstallation({
        appId: "app_acme",
        tenantId: "tenant_acme",
        actor: "manager",
        id: "inst_1",
        expectedRevision: 2,
        enabled: true
      })
    ).resolves.toMatchObject({ outcome: "updated", changed: false, revision: 2 });
    await expect(
      store.updateInstallation({
        appId: "app_acme",
        tenantId: "tenant_acme",
        actor: "manager",
        id: "inst_1",
        expectedRevision: 1,
        priority: 4
      })
    ).resolves.toEqual({ outcome: "conflict", id: "inst_1", revision: 2 });
    expect(db.batches).toEqual([]);
  });

  it("maps an audit uniqueness failure after a raced CAS to a conflict", async () => {
    const db = commandDatabase([{ ...commandRow(), revision: 0 }, { ...commandRow(), revision: 1 }], {
      batchError: new Error("UNIQUE constraint failed: admin_audit_events.installation_id")
    });
    const store = createD1AdminInstallationCommandStore(db);
    await expect(
      store.updateInstallation({
        appId: "app_acme",
        tenantId: "tenant_acme",
        actor: "manager",
        id: "inst_1",
        expectedRevision: 0,
        priority: 4
      })
    ).resolves.toEqual({ outcome: "conflict", id: "inst_1", revision: 1 });
  });
});

function database(row: unknown): D1DatabaseLike & { queries: string[]; bindings: unknown[][] } {
  const queries: string[] = [];
  const bindings: unknown[][] = [];
  return {
    queries,
    bindings,
    prepare: (query) => {
      queries.push(query);
      const statement: D1PreparedStatementLike = {
        bind: (...values) => {
          bindings.push(values);
          return statement;
        },
        run: () => Promise.resolve(undefined),
        all: () => Promise.resolve({ results: [] }),
        first: () => Promise.resolve(row as never)
      };
      return statement;
    }
  };
}

function commandRow() {
  return {
    id: "inst_1",
    enabled: 1,
    priority: 10,
    revision: 0,
    tenant_id: "tenant_acme",
    plugin_id: "plugin_1"
  };
}

function commandDatabase(
  rows: readonly ReturnType<typeof commandRow>[],
  options: { batchError?: Error } = {}
): D1DatabaseLike & { bindings: unknown[][]; batches: unknown[][] } & {
  batch: (statements: readonly D1PreparedStatementLike[]) => Promise<readonly unknown[]>;
} {
  const bindings: unknown[][] = [];
  const batches: unknown[][] = [];
  let rowIndex = 0;
  return {
    bindings,
    batches,
    prepare: () => {
      const statement: D1PreparedStatementLike = {
        bind: (...values) => {
          bindings.push(values);
          return statement;
        },
        run: () => Promise.resolve(undefined),
        all: () => Promise.resolve({ results: [] }),
        first: <T>() => Promise.resolve((rows[rowIndex++] ?? null) as unknown as T | null)
      };
      return statement;
    },
    batch: (statements) => {
      batches.push([...statements]);
      if (options.batchError !== undefined) return Promise.reject(options.batchError);
      return Promise.resolve([]);
    }
  };
}
