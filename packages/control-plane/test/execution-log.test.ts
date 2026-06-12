import { describe, expect, it } from "vitest";
import {
  createInMemoryExecutionLogStore,
  type CapabilityCallRecord,
  type ExecutionRecord
} from "../src/index.js";

describe("createInMemoryExecutionLogStore", () => {
  it("records execution status, duration, error, capability calls, and version", () => {
    const store = createInMemoryExecutionLogStore();
    const record = execution({
      id: "exec_1",
      status: "error",
      error: "handler failed",
      capabilityCalls: [{ name: "slack.send", status: "denied" }],
      version: "1.2.3"
    });

    store.writeExecution(record);

    expect(store.searchExecutions({})).toEqual([record]);
  });

  it("searches executions by tenant, plugin, hook, and status", () => {
    const store = createInMemoryExecutionLogStore();
    store.writeExecution(execution({ id: "exec_1", tenantId: "tenant_a", pluginId: "plugin_a" }));
    store.writeExecution(
      execution({
        id: "exec_2",
        tenantId: "tenant_a",
        pluginId: "plugin_b",
        hookName: "webhook.outbound",
        status: "egress_denied"
      })
    );
    store.writeExecution(execution({ id: "exec_3", tenantId: "tenant_b", pluginId: "plugin_a" }));

    expect(
      store
        .searchExecutions({
          tenantId: "tenant_a",
          pluginId: "plugin_b",
          hookName: "webhook.outbound",
          status: "egress_denied"
        })
        .map((record) => record.id)
    ).toEqual(["exec_2"]);
  });

  it("returns defensive copies so callers cannot mutate the log", () => {
    const store = createInMemoryExecutionLogStore();
    const written = store.writeExecution(execution({ id: "exec_1" }));
    (written.capabilityCalls as CapabilityCallRecord[])[0] = {
      name: "tampered",
      status: "success"
    };

    expect(store.searchExecutions({})[0]?.capabilityCalls).toEqual([
      { name: "slack.send", status: "success" }
    ]);
  });
});

function execution(overrides: Partial<ExecutionRecord>): ExecutionRecord {
  return {
    id: "exec",
    tenantId: "tenant",
    pluginId: "plugin",
    hookName: "invoice.created",
    version: "0.1.0",
    status: "success",
    durationMs: 12,
    capabilityCalls: [{ name: "slack.send", status: "success" }],
    createdAt: new Date("2026-06-12T00:00:00.000Z"),
    ...overrides
  };
}
