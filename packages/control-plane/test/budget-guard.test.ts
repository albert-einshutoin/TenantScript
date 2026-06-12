import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryDailyUsageCounter,
  enforceBudgetBeforeExecution,
  reEnableBudgetDisabledInstallation,
  type BudgetGuardStore,
  type ControlPlaneExecutionRecord
} from "../src/index.js";

describe("budget guard", () => {
  it("rejects the next execution after daily budget is exhausted and disables the installation", async () => {
    const usageCounter = createInMemoryDailyUsageCounter();
    await usageCounter.recordExecution({
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      cpuMs: 50,
      at: new Date("2026-06-13T01:00:00.000Z")
    });
    const store = createBudgetGuardStore();
    const notifications = { publish: vi.fn() };

    await expect(
      enforceBudgetBeforeExecution({
        store,
        usageCounter,
        notifications,
        installationId: "installation_1",
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        hookName: "invoice.created",
        version: "1.0.0",
        executionId: "exec_budget_1",
        budget: { dailyExecutions: 1, dailyCpuMs: 100 },
        at: new Date("2026-06-13T02:00:00.000Z")
      })
    ).resolves.toEqual({ ok: false, reason: "budget_exceeded" });

    expect(store.enabled).toBe(false);
    expect(store.executions).toEqual([
      expect.objectContaining({
        id: "exec_budget_1",
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        hookName: "invoice.created",
        version: "1.0.0",
        status: "budget_exceeded"
      })
    ]);
    expect(notifications.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "budget.exceeded",
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        installationId: "installation_1"
      })
    );
  });

  it("allows an explicit re-enable recovery step", async () => {
    const store = createBudgetGuardStore();
    store.enabled = false;

    await expect(
      reEnableBudgetDisabledInstallation({ store, installationId: "installation_1" })
    ).resolves.toEqual({ ok: true });

    expect(store.enabled).toBe(true);
  });
});

function createBudgetGuardStore(): BudgetGuardStore & {
  enabled: boolean;
  executions: ControlPlaneExecutionRecord[];
} {
  return {
    enabled: true,
    executions: [],
    setInstallationEnabled(request) {
      this.enabled = request.enabled;
      return Promise.resolve();
    },
    writeExecution(record) {
      this.executions.push(record);
      return Promise.resolve(record);
    }
  };
}
