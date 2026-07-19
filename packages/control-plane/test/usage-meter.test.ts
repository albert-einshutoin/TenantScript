import { describe, expect, it, vi } from "vitest";
import {
  createAnalyticsEngineUsageSink,
  createInMemoryUsageMeter,
  createUsageMeter,
  createInMemoryDailyUsageSummaryStore,
  type AnalyticsEngineDataPoint,
  type AnalyticsEngineDatasetLike
} from "../src/index.js";

describe("execution usage meter", () => {
  it("writes one Analytics Engine data point per execution and aggregates daily usage", async () => {
    const analytics = new RecordingAnalyticsDataset();
    const meter = createInMemoryUsageMeter({ analytics });
    const at = new Date("2026-06-14T12:00:00.000Z");

    await meter.recordExecutionUsage({
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      hookType: "event",
      status: "success",
      cpuMs: 17,
      subrequests: 2,
      workflowRuns: 1,
      at
    });
    await meter.recordExecutionUsage({
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      hookType: "event",
      status: "error",
      cpuMs: 4,
      subrequests: 1,
      workflowRuns: 0,
      at
    });

    expect(analytics.points).toEqual([
      {
        indexes: ["tenant_1:plugin_1"],
        blobs: ["tenant_1", "plugin_1", "event", "success"],
        doubles: [1, 17, 2, 1]
      },
      {
        indexes: ["tenant_1:plugin_1"],
        blobs: ["tenant_1", "plugin_1", "event", "error"],
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
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      hookType: "event",
      status: "success",
      cpuMs: 10,
      subrequests: 1,
      workflowRuns: 0,
      at: new Date("2026-06-14T23:59:59.000Z")
    });
    await meter.recordExecutionUsage({
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      hookType: "event",
      status: "success",
      cpuMs: 7,
      subrequests: 2,
      workflowRuns: 1,
      at: new Date("2026-06-15T00:00:00.000Z")
    });
    await meter.recordExecutionUsage({
      tenantId: "tenant_1",
      pluginId: "plugin_2",
      hookType: "event",
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
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        hookType: "event",
        status: "success",
        cpuMs: -1,
        subrequests: 0,
        workflowRuns: 0,
        at: new Date("2026-06-14T12:00:00.000Z")
      })
    ).rejects.toThrow("cpuMs must be a non-negative finite number");
    expect(analytics.points).toEqual([]);
  });

  it("keeps execution accounting available when Analytics Engine rejects a write", async () => {
    const reportFailure = vi.fn();
    const meter = createUsageMeter({
      sink: {
        writeUsage: () => {
          throw new Error("provider token and payload must not escape");
        }
      },
      summaries: createInMemoryDailyUsageSummaryStore(),
      reportFailure
    });

    await expect(
      meter.recordExecutionUsage({
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        hookType: "event",
        status: "success",
        cpuMs: 8,
        subrequests: 1,
        workflowRuns: 0,
        at: new Date("2026-06-14T12:00:00.000Z")
      })
    ).resolves.toMatchObject({ executions: 1, cpuMs: 8 });
    expect(reportFailure).toHaveBeenCalledWith({
      code: "usage_sink_write_failed",
      tenantId: "tenant_1",
      pluginId: "plugin_1"
    });
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain("provider token");
  });

  it("queries UTC daily summaries by tenant, optional plugin, and inclusive date range", async () => {
    const meter = createInMemoryUsageMeter();
    const record = (tenantId: string, pluginId: string, at: string, cpuMs: number) =>
      meter.recordExecutionUsage({
        tenantId,
        pluginId,
        hookType: "event",
        status: "success",
        cpuMs,
        subrequests: 0,
        workflowRuns: 0,
        at: new Date(at)
      });
    await record("tenant_1", "plugin_2", "2026-06-13T23:59:59.000Z", 2);
    await record("tenant_1", "plugin_1", "2026-06-14T00:00:00.000Z", 3);
    await record("tenant_1", "plugin_2", "2026-06-15T12:00:00.000Z", 5);
    await record("tenant_2", "plugin_1", "2026-06-14T12:00:00.000Z", 99);

    await expect(
      meter.getDailyUsageSummaries({
        tenantId: "tenant_1",
        fromDate: "2026-06-14",
        toDate: "2026-06-15"
      })
    ).resolves.toEqual([
      expect.objectContaining({ date: "2026-06-14", pluginId: "plugin_1", cpuMs: 3 }),
      expect.objectContaining({ date: "2026-06-15", pluginId: "plugin_2", cpuMs: 5 })
    ]);
    await expect(
      meter.getDailyUsageSummaries({
        tenantId: "tenant_1",
        pluginId: "plugin_2",
        fromDate: "2026-06-13",
        toDate: "2026-06-15"
      })
    ).resolves.toHaveLength(2);
  });

  it("rejects invalid or unbounded UTC aggregation ranges", async () => {
    const meter = createInMemoryUsageMeter();

    await expect(
      meter.getDailyUsageSummaries({
        tenantId: "tenant_1",
        fromDate: "2026-02-30",
        toDate: "2026-03-01"
      })
    ).rejects.toThrow("usage date must be a valid UTC date");
    await expect(
      meter.getDailyUsageSummaries({
        tenantId: "tenant_1",
        fromDate: "2026-03-02",
        toDate: "2026-03-01"
      })
    ).rejects.toThrow("fromDate must not be after toDate");
    await expect(
      meter.getDailyUsageSummaries({
        tenantId: "tenant_1",
        fromDate: "2025-01-01",
        toDate: "2026-01-02"
      })
    ).rejects.toThrow("usage summary range must not exceed 366 UTC days");
  });

  it("emits a fixed internal warning when no failure reporter is configured", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const meter = createUsageMeter({
      sink: { writeUsage: () => Promise.reject(new Error("raw provider failure")) },
      summaries: createInMemoryDailyUsageSummaryStore()
    });

    await meter.recordExecutionUsage({
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      hookType: "event",
      status: "error",
      cpuMs: 1,
      subrequests: 0,
      workflowRuns: 0,
      at: new Date("2026-06-14T12:00:00.000Z")
    });

    expect(warning).toHaveBeenCalledWith("TenantScript usage metering failed", {
      code: "usage_sink_write_failed",
      tenantId: "tenant_1",
      pluginId: "plugin_1"
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("raw provider failure");
    warning.mockRestore();
  });

  it("projects only billing-safe fields into Analytics Engine", async () => {
    const analytics = new RecordingAnalyticsDataset();
    const sink = createAnalyticsEngineUsageSink(analytics);
    const request = {
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      hookType: "policy" as const,
      status: "success" as const,
      executions: 1 as const,
      cpuMs: 4,
      subrequests: 1,
      workflowRuns: 0,
      payload: "customer-payload",
      config: "private-config",
      secret: "provider-secret"
    };

    await sink.writeUsage(request);

    expect(analytics.points).toEqual([
      {
        indexes: ["tenant_1:plugin_1"],
        blobs: ["tenant_1", "plugin_1", "policy", "success"],
        doubles: [1, 4, 1, 0]
      }
    ]);
    expect(JSON.stringify(analytics.points)).not.toMatch(
      /customer-payload|private-config|provider-secret/
    );
  });

  it("serializes concurrent daily summary increments for the same tenant and plugin", async () => {
    const meter = createInMemoryUsageMeter();

    await Promise.all(
      Array.from({ length: 25 }, () =>
        meter.recordExecutionUsage({
          tenantId: "tenant_1",
          pluginId: "plugin_1",
          hookType: "event",
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
