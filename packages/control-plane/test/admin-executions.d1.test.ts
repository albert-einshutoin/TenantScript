import { describe, expect, it } from "vitest";
import { createD1AdminExecutionDetailStore } from "../src/admin-executions.js";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../src/storage.js";

describe("D1 Admin execution detail adapter", () => {
  it("projects safe metadata and status-derived errors without raw stored error text", async () => {
    const db = database({
      id: "exec_1",
      plugin_id: "plugin_1",
      hook_name: "invoice.created",
      version: "1.0.0",
      status: "error",
      duration_ms: 21,
      error: "provider secret and customer payload",
      capability_calls_json: '[{"name":"slack.send","status":"error"}]',
      created_at: "2026-07-19T00:00:00.000Z"
    });
    const store = createD1AdminExecutionDetailStore(db);

    const detail = await store.readExecution({
      appId: "app_1",
      tenantId: "tenant_1",
      id: "exec_1"
    });

    expect(detail).toEqual({
      id: "exec_1",
      pluginId: "plugin_1",
      hookName: "invoice.created",
      version: "1.0.0",
      status: "error",
      durationMs: 21,
      errorCode: "execution_failed",
      capabilityCalls: [{ name: "slack.send", status: "error" }],
      createdAt: "2026-07-19T00:00:00.000Z"
    });
    expect(JSON.stringify(detail)).not.toContain("provider secret");
    expect(JSON.stringify(detail)).not.toContain("customer payload");
    expect(db.bindings[0]).toEqual(["tenant_1", "app_1", "exec_1"]);
    expect(db.queries[0]).toContain("t.id = ?1 AND t.app_id = ?2 AND p.app_id = t.app_id");
  });
});

function database(row: unknown): D1DatabaseLike & {
  queries: string[];
  bindings: unknown[][];
} {
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
        first: () => Promise.resolve(row as never),
        all: () => Promise.resolve({ results: [] }),
        run: () => Promise.resolve(undefined)
      };
      return statement;
    }
  };
}
