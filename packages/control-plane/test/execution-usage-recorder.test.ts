import { describe, expect, it, vi } from "vitest";
import {
  createExecutionUsageRecorder,
  type ControlPlaneExecutionRecord,
  type UsageMeter
} from "../src/index.js";

describe("execution usage recorder", () => {
  it("persists the execution before deriving one usage event from its authority", async () => {
    const order: string[] = [];
    const record = execution();
    const writeExecution = vi.fn((candidate: ControlPlaneExecutionRecord) => {
      order.push("execution");
      return Promise.resolve({
        ...candidate,
        tenantId: "tenant_authoritative",
        pluginId: "plugin_authoritative"
      });
    });
    const recordExecutionUsage = vi.fn<UsageMeter["recordExecutionUsage"]>((request) => {
      order.push("usage");
      return Promise.resolve(summary(request.tenantId, request.pluginId));
    });
    const recorder = createExecutionUsageRecorder({
      store: { writeExecution },
      usageMeter: usageMeter(recordExecutionUsage)
    });

    await expect(
      recorder.record({
        execution: record,
        metrics: { hookType: "event", cpuMs: 7, subrequests: 2, workflowRuns: 1 }
      })
    ).resolves.toMatchObject({
      id: record.id,
      tenantId: "tenant_authoritative",
      pluginId: "plugin_authoritative"
    });

    expect(order).toEqual(["execution", "usage"]);
    expect(writeExecution).toHaveBeenCalledTimes(1);
    expect(recordExecutionUsage).toHaveBeenCalledTimes(1);
    expect(recordExecutionUsage).toHaveBeenCalledWith({
      tenantId: "tenant_authoritative",
      pluginId: "plugin_authoritative",
      hookType: "event",
      status: "success",
      cpuMs: 7,
      subrequests: 2,
      workflowRuns: 1,
      at: record.createdAt
    });
  });

  it("does not record usage when execution persistence fails", async () => {
    const recordExecutionUsage = vi.fn();
    const recorder = createExecutionUsageRecorder({
      store: {
        writeExecution: () => Promise.reject(new Error("execution-write-secret-sentinel"))
      },
      usageMeter: usageMeter(recordExecutionUsage)
    });

    await expect(
      recorder.record({
        execution: execution(),
        metrics: { hookType: "transform", cpuMs: 0, subrequests: 0, workflowRuns: 0 }
      })
    ).rejects.toThrow("execution-write-secret-sentinel");
    expect(recordExecutionUsage).not.toHaveBeenCalled();
  });

  it("keeps a persisted execution successful when usage and failure reporting fail", async () => {
    const failures: unknown[] = [];
    const persisted = execution();
    const recordExecutionUsage = vi.fn(() =>
      Promise.reject(new Error("usage-provider-secret-sentinel"))
    );
    const reportFailure = vi.fn((failure) => {
      failures.push(failure);
      return Promise.reject(new Error("reporter-secret-sentinel"));
    });
    const recorder = createExecutionUsageRecorder({
      store: { writeExecution: () => Promise.resolve(persisted) },
      usageMeter: usageMeter(recordExecutionUsage),
      reportFailure
    });

    await expect(
      recorder.record({
        execution: persisted,
        metrics: { hookType: "policy", cpuMs: 3, subrequests: 1, workflowRuns: 0 }
      })
    ).resolves.toEqual(persisted);

    expect(recordExecutionUsage).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([
      {
        code: "execution_usage_recording_failed",
        tenantId: persisted.tenantId,
        pluginId: persisted.pluginId
      }
    ]);
    expect(JSON.stringify(failures)).not.toContain("secret-sentinel");
  });

  it("rejects an invalid persisted record before metering it", async () => {
    const recordExecutionUsage = vi.fn();
    const recorder = createExecutionUsageRecorder({
      store: {
        writeExecution: (record) => Promise.resolve({ ...record, createdAt: new Date(Number.NaN) })
      },
      usageMeter: usageMeter(recordExecutionUsage)
    });

    await expect(
      recorder.record({
        execution: execution(),
        metrics: { hookType: "event", cpuMs: 1, subrequests: 0, workflowRuns: 0 }
      })
    ).rejects.toMatchObject({ code: "execution_usage_invalid_request" });
    expect(recordExecutionUsage).not.toHaveBeenCalled();
  });

  it("rejects widened recorder configuration without reflecting it", () => {
    let thrown: unknown;
    try {
      createExecutionUsageRecorder({
        store: { writeExecution: (record: ControlPlaneExecutionRecord) => record },
        usageMeter: usageMeter(vi.fn()),
        secret: "secret-sentinel"
      } as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: "execution_usage_invalid_request" });
    expect(JSON.stringify(thrown)).not.toContain("secret-sentinel");
  });

  it.each([
    {
      name: "extra top-level field",
      request: {
        execution: execution(),
        metrics: { hookType: "event", cpuMs: 1, subrequests: 0, workflowRuns: 0 },
        token: "secret-sentinel"
      }
    },
    {
      name: "extra metric field",
      request: {
        execution: execution(),
        metrics: {
          hookType: "event",
          cpuMs: 1,
          subrequests: 0,
          workflowRuns: 0,
          tenantId: "attacker"
        }
      }
    },
    {
      name: "negative CPU",
      request: {
        execution: execution(),
        metrics: { hookType: "event", cpuMs: -1, subrequests: 0, workflowRuns: 0 }
      }
    },
    {
      name: "fractional subrequests",
      request: {
        execution: execution(),
        metrics: { hookType: "event", cpuMs: 1, subrequests: 0.5, workflowRuns: 0 }
      }
    },
    {
      name: "invalid execution date",
      request: {
        execution: { ...execution(), createdAt: new Date(Number.NaN) },
        metrics: { hookType: "event", cpuMs: 1, subrequests: 0, workflowRuns: 0 }
      }
    }
  ])("rejects $name before either mutation without reflecting input", async ({ request }) => {
    const writeExecution = vi.fn();
    const recordExecutionUsage = vi.fn();
    const recorder = createExecutionUsageRecorder({
      store: { writeExecution },
      usageMeter: usageMeter(recordExecutionUsage)
    });

    let thrown: unknown;
    try {
      await recorder.record(request as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: "execution_usage_invalid_request" });
    expect(JSON.stringify(thrown)).not.toContain("secret-sentinel");
    expect(writeExecution).not.toHaveBeenCalled();
    expect(recordExecutionUsage).not.toHaveBeenCalled();
  });
});

function execution(): ControlPlaneExecutionRecord {
  return {
    id: "exec_284",
    tenantId: "tenant_1",
    pluginId: "plugin_1",
    hookName: "invoice.created",
    version: "1.0.0",
    status: "success",
    durationMs: 9,
    capabilityCalls: [{ name: "slack.send", status: "success" }],
    createdAt: new Date("2026-07-21T05:00:00.000Z")
  };
}

function usageMeter(recordExecutionUsage: UsageMeter["recordExecutionUsage"]): UsageMeter {
  return {
    recordExecutionUsage,
    getDailyUsageSummary: () => Promise.reject(new Error("unexpected usage query")),
    getDailyUsageSummaries: () => Promise.reject(new Error("unexpected usage query"))
  };
}

function summary(tenantId: string, pluginId: string) {
  return {
    tenantId,
    pluginId,
    date: "2026-07-21",
    executions: 1,
    cpuMs: 0,
    subrequests: 0,
    workflowRuns: 0
  };
}
