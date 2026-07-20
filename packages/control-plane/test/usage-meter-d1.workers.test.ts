import { env, exports } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1DailyUsageSummaryStore, createUsageMeter } from "../src/index.js";

interface TestWorkersEnv {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestWorkersEnv;
const worker = exports as unknown as {
  default: { fetch: (request: Request) => Promise<Response> };
};

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("production D1 usage metering", () => {
  it("atomically aggregates concurrent usage and keeps tenant queries isolated", async () => {
    const meter = createUsageMeter({ summaries: createD1DailyUsageSummaryStore(testEnv.DB) });

    await Promise.all([
      record(meter, "tenant_worker", "plugin_a", "2026-07-20T23:59:59.000Z", 3),
      record(meter, "tenant_worker", "plugin_a", "2026-07-21T00:00:00.000Z", 5),
      record(meter, "tenant_worker", "plugin_a", "2026-07-21T00:00:01.000Z", 11),
      record(meter, "tenant_worker", "plugin_b", "2026-07-21T12:00:00.000Z", 7),
      record(meter, "tenant_other", "plugin_a", "2026-07-21T12:00:00.000Z", 101)
    ]);

    await expect(
      meter.getDailyUsageSummaries({
        tenantId: "tenant_worker",
        fromDate: "2026-07-20",
        toDate: "2026-07-21"
      })
    ).resolves.toEqual([
      {
        tenantId: "tenant_worker",
        pluginId: "plugin_a",
        date: "2026-07-20",
        executions: 1,
        cpuMs: 3,
        subrequests: 1,
        workflowRuns: 0
      },
      {
        tenantId: "tenant_worker",
        pluginId: "plugin_a",
        date: "2026-07-21",
        executions: 2,
        cpuMs: 16,
        subrequests: 2,
        workflowRuns: 0
      },
      {
        tenantId: "tenant_worker",
        pluginId: "plugin_b",
        date: "2026-07-21",
        executions: 1,
        cpuMs: 7,
        subrequests: 1,
        workflowRuns: 0
      }
    ]);
    await expect(
      meter.getDailyUsageSummaries({
        tenantId: "tenant_worker",
        pluginId: "plugin_b",
        fromDate: "2026-07-21",
        toDate: "2026-07-21"
      })
    ).resolves.toEqual([
      {
        tenantId: "tenant_worker",
        pluginId: "plugin_b",
        date: "2026-07-21",
        executions: 1,
        cpuMs: 7,
        subrequests: 1,
        workflowRuns: 0
      }
    ]);
  });

  it("wires the persistent meter into the production Worker usage endpoint", async () => {
    const meter = createUsageMeter({ summaries: createD1DailyUsageSummaryStore(testEnv.DB) });
    await record(meter, "tenant_worker", "plugin_a", "2026-07-21T12:00:00.000Z", 8);
    await record(meter, "tenant_other", "plugin_a", "2026-07-21T12:00:00.000Z", 99);

    const response = await worker.default.fetch(
      new Request(
        "https://control-plane.example.com/v1/admin/usage?fromDate=2026-07-21&toDate=2026-07-21",
        { headers: { Authorization: "Bearer worker-manager-token" } }
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        {
          tenantId: "tenant_worker",
          pluginId: "plugin_a",
          date: "2026-07-21",
          executions: 1,
          cpuMs: 8,
          subrequests: 1,
          workflowRuns: 0
        }
      ]
    });
  });
});

function record(
  meter: ReturnType<typeof createUsageMeter>,
  tenantId: string,
  pluginId: string,
  at: string,
  cpuMs: number
) {
  return meter.recordExecutionUsage({
    tenantId,
    pluginId,
    hookType: "event",
    status: "success",
    cpuMs,
    subrequests: 1,
    workflowRuns: 0,
    at: new Date(at)
  });
}
