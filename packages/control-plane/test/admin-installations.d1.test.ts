import { describe, expect, it } from "vitest";
import { createD1AdminInstallationDetailStore } from "../src/admin-installations.js";
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
    expect(db.queries[0]).toContain("t.id = ?1 AND t.app_id = ?2 AND i.id = ?3");
    expect(db.bindings[0]).toEqual(["tenant_acme", "app_acme", "inst_other"]);
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
