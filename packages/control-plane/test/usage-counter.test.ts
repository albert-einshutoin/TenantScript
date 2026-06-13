import { describe, expect, it } from "vitest";
import { createInMemoryDailyUsageCounter } from "../src/index.js";

describe("daily usage counter", () => {
  it("accumulates executions and cpuMs per tenant, plugin, and day", async () => {
    const counter = createInMemoryDailyUsageCounter();

    await counter.recordExecution({
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      cpuMs: 12,
      at: new Date("2026-06-13T23:59:00.000Z")
    });
    await counter.recordExecution({
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      cpuMs: 8,
      at: new Date("2026-06-13T23:59:30.000Z")
    });

    await expect(
      counter.getDailyUsage({
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        at: new Date("2026-06-13T23:59:59.000Z")
      })
    ).resolves.toEqual({
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      date: "2026-06-13",
      executions: 2,
      cpuMs: 20
    });
  });

  it("resets counters across UTC day boundaries", async () => {
    const counter = createInMemoryDailyUsageCounter();

    await counter.recordExecution({
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      cpuMs: 10,
      at: new Date("2026-06-13T23:59:59.000Z")
    });
    await counter.recordExecution({
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      cpuMs: 7,
      at: new Date("2026-06-14T00:00:00.000Z")
    });

    await expect(
      counter.getDailyUsage({
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        at: new Date("2026-06-14T00:00:00.000Z")
      })
    ).resolves.toMatchObject({ date: "2026-06-14", executions: 1, cpuMs: 7 });
  });

  it("serializes concurrent increments for the same tenant and plugin", async () => {
    const counter = createInMemoryDailyUsageCounter();

    await Promise.all(
      Array.from({ length: 25 }, () =>
        counter.recordExecution({
          tenantId: "tenant_1",
          pluginId: "plugin_1",
          cpuMs: 3,
          at: new Date("2026-06-13T01:00:00.000Z")
        })
      )
    );

    await expect(
      counter.getDailyUsage({
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        at: new Date("2026-06-13T23:00:00.000Z")
      })
    ).resolves.toMatchObject({ executions: 25, cpuMs: 75 });
  });
});
