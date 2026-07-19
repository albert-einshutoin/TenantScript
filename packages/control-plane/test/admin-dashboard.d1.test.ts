import { describe, expect, it } from "vitest";
import { createD1AdminDashboardStore } from "../src/admin-dashboard.js";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../src/storage.js";

describe("D1 Admin dashboard adapter", () => {
  it("maps bounded pages for every section without returning storage-only columns", async () => {
    const dashboard = createD1AdminDashboardStore(
      database({
        installations: [
          {
            id: "inst_1",
            plugin_key: "safe-plugin",
            version: "1.0.0",
            enabled: 1,
            priority: 10,
            revision: 0
          },
          {
            id: "inst_2",
            plugin_key: "next-plugin",
            version: "2.0.0",
            enabled: 0,
            priority: 20,
            revision: 1
          }
        ],
        pluginVersions: [
          {
            id: "version_1",
            plugin_id: "plugin_1",
            version: "1.0.0",
            artifact_hash: "hash",
            created_at: "2026-07-18T00:00:00.000Z"
          },
          {
            id: "version_2",
            plugin_id: "plugin_1",
            version: "2.0.0",
            artifact_hash: "hash-2",
            created_at: "2026-07-19T00:00:00.000Z"
          }
        ],
        approvals: [
          {
            id: "approval_1",
            plugin_id: "plugin_1",
            role: "manager",
            resume_hook: "approval.decided",
            state: "pending",
            expires_at: "2026-07-20T00:00:00.000Z",
            created_at: "2026-07-19T00:00:00.000Z"
          },
          {
            id: "approval_2",
            plugin_id: "plugin_1",
            role: "manager",
            resume_hook: "approval.decided",
            state: "approved",
            expires_at: "2026-07-20T00:00:00.000Z",
            created_at: "2026-07-19T01:00:00.000Z"
          }
        ],
        executions: [
          {
            id: "exec_2",
            plugin_id: "plugin_1",
            hook_name: "invoice.created",
            version: "1.0.0",
            status: "success",
            duration_ms: 12,
            capability_calls_json: '[{"name":"slack.send","status":"success"}]',
            created_at: "2026-07-19T02:00:00.000Z"
          },
          {
            id: "exec_1",
            plugin_id: "plugin_1",
            hook_name: "invoice.created",
            version: "1.0.0",
            status: "error",
            duration_ms: 20,
            capability_calls_json: "[]",
            created_at: "2026-07-19T01:00:00.000Z"
          }
        ],
        usage: { executions: 2, runtime_ms: 32 }
      })
    );

    const installations = await dashboard.readSection(scope("installations", 1));
    const versions = await dashboard.readSection(scope("pluginVersions", 1));
    const approvals = await dashboard.readSection(scope("approvals", 1));
    const executions = await dashboard.readSection(scope("executions", 1));
    const usage = await dashboard.readUsageSummary({
      appId: "app_1",
      tenantId: "tenant_1",
      date: "2026-07-19"
    });

    expect(installations).toEqual({
      section: "installations",
      items: [
        {
          id: "inst_1",
          pluginKey: "safe-plugin",
          version: "1.0.0",
          enabled: true,
          priority: 10,
          revision: 0
        }
      ],
      nextPosition: "inst_1"
    });
    expect(versions).toMatchObject({ section: "pluginVersions", nextPosition: "version_1" });
    expect(approvals).toMatchObject({ section: "approvals", nextPosition: "approval_1" });
    expect(executions).toEqual({
      section: "executions",
      items: [expect.objectContaining({ id: "exec_2", capabilityNames: ["slack.send"] })],
      nextPosition: "2026-07-19T02:00:00.000Z\texec_2"
    });
    expect(usage).toEqual({ date: "2026-07-19", executions: 2, runtimeMs: 32 });
  });

  it("returns empty terminal pages and a zero usage summary", async () => {
    const dashboard = createD1AdminDashboardStore(database({}));

    await expect(dashboard.readSection(scope("installations", 20))).resolves.toEqual({
      section: "installations",
      items: []
    });
    await expect(
      dashboard.readUsageSummary({ appId: "app_1", tenantId: "tenant_1", date: "2026-07-19" })
    ).resolves.toEqual({ date: "2026-07-19", executions: 0, runtimeMs: 0 });
  });

  it("rejects malformed stored summaries and cursor positions", async () => {
    const invalidApproval = createD1AdminDashboardStore(
      database({
        approvals: [
          {
            id: "approval_1",
            plugin_id: "plugin_1",
            role: "manager",
            resume_hook: "approval.decided",
            state: "unknown",
            expires_at: "2026-07-20T00:00:00.000Z",
            created_at: "2026-07-19T00:00:00.000Z"
          }
        ]
      })
    );
    await expect(invalidApproval.readSection(scope("approvals", 20))).rejects.toThrow(
      "invalid approval state"
    );

    const invalidExecution = createD1AdminDashboardStore(
      database({
        executions: [
          {
            id: "exec_1",
            plugin_id: "plugin_1",
            hook_name: "invoice.created",
            version: "1.0.0",
            status: "unknown",
            duration_ms: 1,
            capability_calls_json: "{}",
            created_at: "2026-07-19T00:00:00.000Z"
          }
        ]
      })
    );
    await expect(invalidExecution.readSection(scope("executions", 20))).rejects.toThrow(
      "invalid execution status"
    );
    await expect(
      invalidExecution.readSection({ ...scope("executions", 20), position: "malformed" })
    ).rejects.toThrow("invalid execution cursor position");
    await expect(
      invalidExecution.readUsageSummary({
        appId: "app_1",
        tenantId: "tenant_1",
        date: "not-a-date"
      })
    ).rejects.toThrow("invalid usage summary date");
  });

  it("rejects invalid capability summaries", async () => {
    const baseExecution = {
      id: "exec_1",
      plugin_id: "plugin_1",
      hook_name: "invoice.created",
      version: "1.0.0",
      status: "success",
      duration_ms: 1,
      created_at: "2026-07-19T00:00:00.000Z"
    };
    for (const capability_calls_json of ["{}", "[{}]"]) {
      const dashboard = createD1AdminDashboardStore(
        database({ executions: [{ ...baseExecution, capability_calls_json }] })
      );
      await expect(dashboard.readSection(scope("executions", 20))).rejects.toThrow(
        "invalid capability call summary"
      );
    }
  });
});

function scope(
  section: Parameters<ReturnType<typeof createD1AdminDashboardStore>["readSection"]>[0]["section"],
  limit: number
) {
  return { appId: "app_1", tenantId: "tenant_1", section, limit };
}

interface DatabaseRows {
  installations?: unknown[];
  pluginVersions?: unknown[];
  approvals?: unknown[];
  executions?: unknown[];
  usage?: unknown;
}

function database(rows: DatabaseRows): D1DatabaseLike {
  return {
    prepare: (query) => statement(query, rows)
  };
}

function statement(query: string, rows: DatabaseRows): D1PreparedStatementLike {
  const result = query.includes("FROM installations")
    ? rows.installations
    : query.includes("FROM plugin_versions")
      ? rows.pluginVersions
      : query.includes("FROM approvals")
        ? rows.approvals
        : rows.executions;
  const prepared: D1PreparedStatementLike = {
    bind: () => prepared,
    run: () => Promise.resolve(undefined),
    first: () => Promise.resolve((rows.usage ?? null) as never),
    all: () => Promise.resolve({ results: result ?? [] })
  };
  return prepared;
}
