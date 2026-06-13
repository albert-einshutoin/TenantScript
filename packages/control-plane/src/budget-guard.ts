import type { ControlPlaneExecutionRecord } from "./api.js";
import type { DailyUsageCounter, DailyUsageRecord } from "./usage-counter.js";

export interface BudgetGuardStore {
  setInstallationEnabled: (request: { id: string; enabled: boolean }) => Promise<void> | void;
  writeExecution: (
    record: ControlPlaneExecutionRecord
  ) => Promise<ControlPlaneExecutionRecord> | ControlPlaneExecutionRecord;
}

export interface DailyBudget {
  dailyExecutions: number;
  dailyCpuMs: number;
}

export interface BudgetExceededNotification {
  type: "budget.exceeded";
  tenantId: string;
  pluginId: string;
  installationId: string;
  usage: DailyUsageRecord;
  budget: DailyBudget;
  emittedAt: Date;
}

export interface BudgetNotificationSink {
  publish: (event: BudgetExceededNotification) => Promise<void> | void;
}

export type BudgetGuardResult = { ok: true } | { ok: false; reason: "budget_exceeded" };

export async function enforceBudgetBeforeExecution(params: {
  store: BudgetGuardStore;
  usageCounter: DailyUsageCounter;
  notifications: BudgetNotificationSink;
  installationId: string;
  tenantId: string;
  pluginId: string;
  hookName: string;
  version: string;
  executionId: string;
  budget: DailyBudget;
  at: Date;
}): Promise<BudgetGuardResult> {
  const usage = await params.usageCounter.getDailyUsage({
    tenantId: params.tenantId,
    pluginId: params.pluginId,
    at: params.at
  });

  if (!isBudgetExceeded(usage, params.budget)) {
    return { ok: true };
  }

  await params.store.setInstallationEnabled({ id: params.installationId, enabled: false });
  await params.store.writeExecution({
    id: params.executionId,
    tenantId: params.tenantId,
    pluginId: params.pluginId,
    hookName: params.hookName,
    version: params.version,
    status: "budget_exceeded",
    durationMs: 0,
    error: budgetExceededMessage(usage, params.budget),
    capabilityCalls: [],
    createdAt: params.at
  });
  await params.notifications.publish({
    type: "budget.exceeded",
    tenantId: params.tenantId,
    pluginId: params.pluginId,
    installationId: params.installationId,
    usage,
    budget: params.budget,
    emittedAt: params.at
  });

  return { ok: false, reason: "budget_exceeded" };
}

export async function reEnableBudgetDisabledInstallation(params: {
  store: Pick<BudgetGuardStore, "setInstallationEnabled">;
  installationId: string;
}): Promise<{ ok: true }> {
  await params.store.setInstallationEnabled({ id: params.installationId, enabled: true });
  return { ok: true };
}

function isBudgetExceeded(usage: DailyUsageRecord, budget: DailyBudget): boolean {
  return usage.executions >= budget.dailyExecutions || usage.cpuMs >= budget.dailyCpuMs;
}

function budgetExceededMessage(usage: DailyUsageRecord, budget: DailyBudget): string {
  return `daily budget exceeded: executions ${String(usage.executions)}/${String(
    budget.dailyExecutions
  )}, cpuMs ${String(usage.cpuMs)}/${String(budget.dailyCpuMs)}`;
}
