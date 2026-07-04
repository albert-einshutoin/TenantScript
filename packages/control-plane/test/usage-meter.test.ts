import { describe, expect, it } from "vitest";
import {
  createInMemoryUsageMeter,
  type AnalyticsEngineDataPoint,
  type AnalyticsEngineDatasetLike
} from "../src/index.js";

describe("execution usage meter", () => {
  it("writes one Analytics Engine data point per execution and aggregates daily usage", async () => {
    const analytics = new RecordingAnalyticsDataset();
    const meter = createInMemoryUsageMeter({ analytics });
    const at = new Date("2026-06-14T12:00:00.000Z");

    await meter.recordExecutionUsage({
      executionId: "exec_1",
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      hookName: "invoice.created",
      status: "success",
      cpuMs: 17,
      subrequests: 2,
      workflowRuns: 1,
      at
    });
    await meter.recordExecutionUsage({
      executionId: "exec_2",
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      hookName: "invoice.created",
      status: "error",
      cpuMs: 4,
      subrequests: 1,
      workflowRuns: 0,
      at
    });

    expect(analytics.points).toEqual([
      {
        indexes: ["tenant_1:plugin_1"],
        blobs: ["tenant_1", "plugin_1", "exec_1", "invoice.created", "success", "2026-06-14"],
        doubles: [1, 17, 2, 1]
      },
      {
        indexes: ["tenant_1:plugin_1"],
        blobs: ["tenant_1", "plugin_1", "exec_2", "invoice.created", "error", "2026-06-14"],
        doubles: [1, 4, 1, 0]
      }
    ]);
    await expect(
      meter.getDailyUsageSummary({
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        date: "2026-06-14"
      })
    ).resolves.toEqual({
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      date: "2026-06-14",
      executions: 2,
      cpuMs: 21,
      subrequests: 3,
      workflowRuns: 1
    });
  });

  it("separates daily summaries by tenant, plugin, and UTC date", async () => {
    const meter = createInMemoryUsageMeter();

    await meter.recordExecutionUsage({
      executionId: "exec_1",
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      hookName: "invoice.created",
      status: "success",
      cpuMs: 10,
      subrequests: 1,
      workflowRuns: 0,
      at: new Date("2026-06-14T23:59:59.000Z")
    });
    await meter.recordExecutionUsage({
      executionId: "exec_2",
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      hookName: "invoice.created",
      status: "success",
      cpuMs: 7,
      subrequests: 2,
      workflowRuns: 1,
      at: new Date("2026-06-15T00:00:00.000Z")
    });
    await meter.recordExecutionUsage({
      executionId: "exec_3",
      tenantId: "tenant_1",
      pluginId: "plugin_2",
      hookName: "invoice.created",
      status: "success",
      cpuMs: 99,
      subrequests: 9,
      workflowRuns: 9,
      at: new Date("2026-06-14T12:00:00.000Z")
    });

    await expect(
      meter.getDailyUsageSummary({
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        date: "2026-06-14"
      })
    ).resolves.toMatchObject({ executions: 1, cpuMs: 10, subrequests: 1, workflowRuns: 0 });
  });

  it("rejects invalid counters before writing Analytics Engine data", async () => {
    const analytics = new RecordingAnalyticsDataset();
    const meter = createInMemoryUsageMeter({ analytics });

    await expect(
      meter.recordExecutionUsage({
        executionId: "exec_1",
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        hookName: "invoice.created",
        status: "success",
        cpuMs: -1,
        subrequests: 0,
        workflowRuns: 0,
        at: new Date("2026-06-14T12:00:00.000Z")
      })
    ).rejects.toThrow("cpuMs must be a non-negative finite number");
    expect(analytics.points).toEqual([]);
  });

  it("serializes concurrent daily summary increments for the same tenant and plugin", async () => {
    const meter = createInMemoryUsageMeter();

    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        meter.recordExecutionUsage({
          executionId: `exec_${String(index)}`,
          tenantId: "tenant_1",
          pluginId: "plugin_1",
          hookName: "invoice.created",
          status: "success",
          cpuMs: 3,
          subrequests: 2,
          workflowRuns: 1,
          at: new Date("2026-06-14T12:00:00.000Z")
        })
      )
    );

    await expect(
      meter.getDailyUsageSummary({
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        date: "2026-06-14"
      })
    ).resolves.toMatchObject({
      executions: 25,
      cpuMs: 75,
      subrequests: 50,
      workflowRuns: 25
    });
  });
});

class RecordingAnalyticsDataset implements AnalyticsEngineDatasetLike {
  readonly points: AnalyticsEngineDataPoint[] = [];

  writeDataPoint(event?: AnalyticsEngineDataPoint): void {
    if (event !== undefined) {
      this.points.push(event);
    }
  }
}
