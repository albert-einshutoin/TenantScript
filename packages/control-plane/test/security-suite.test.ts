import { describe, expect, it } from "vitest";
import { createInMemoryExecutionLogStore } from "../src/index.js";

describe("control-plane security suite", () => {
  it("does not return another tenant's execution logs when scoped by tenant", () => {
    const store = createInMemoryExecutionLogStore();

    store.writeExecution({
      id: "exec_tenant_1",
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      hookName: "invoice.created",
      version: "1.0.0",
      status: "success",
      durationMs: 12,
      capabilityCalls: [],
      createdAt: new Date("2026-06-12T00:00:00.000Z")
    });
    store.writeExecution({
      id: "exec_tenant_2",
      tenantId: "tenant_2",
      pluginId: "plugin_1",
      hookName: "invoice.created",
      version: "1.0.0",
      status: "error",
      durationMs: 10,
      error: "should not leak",
      capabilityCalls: [],
      createdAt: new Date("2026-06-12T00:00:01.000Z")
    });

    expect(store.searchExecutions({ tenantId: "tenant_1" }).map((record) => record.id)).toEqual([
      "exec_tenant_1"
    ]);
  });
});
