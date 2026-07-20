import type { D1DatabaseLike } from "./storage.js";

export type RunawayExecutionOutcome = "success" | "error" | "timeout";
export type RunawayQuarantineReason = "consecutive_failures" | "consecutive_timeouts";

export interface RunawayPolicy {
  consecutiveFailures: number;
  consecutiveTimeouts: number;
}

export interface RunawayGuardState {
  consecutiveFailures: number;
  consecutiveTimeouts: number;
  quarantined: boolean;
  reason?: RunawayQuarantineReason;
}

export interface RunawayGuardStore {
  recordOutcome: (request: {
    installationId: string;
    outcome: RunawayExecutionOutcome;
    at: Date;
  }) => Promise<RunawayGuardState>;
  quarantineIfEnabled: (request: {
    installationId: string;
    reason: RunawayQuarantineReason;
    at: Date;
  }) => Promise<boolean>;
  recover: (request: { installationId: string; at: Date }) => Promise<boolean>;
}

export interface RunawayQuarantineNotification {
  type: "installation.quarantined";
  tenantId: string;
  pluginId: string;
  installationId: string;
  reason: RunawayQuarantineReason;
  consecutiveFailures: number;
  consecutiveTimeouts: number;
  emittedAt: Date;
}

export interface RunawayNotificationSink {
  publish: (event: RunawayQuarantineNotification) => Promise<void> | void;
}

export type RunawayGuardResult =
  | { quarantined: false }
  | { quarantined: true; reason: RunawayQuarantineReason };

export function createD1RunawayGuardStore(db: D1DatabaseLike): RunawayGuardStore {
  return {
    recordOutcome: async (request) => {
      const statement = db.prepare(outcomeStatement(request.outcome));
      const row = await statement
        .bind(request.installationId, request.at.toISOString())
        .first<RunawayStateRow>();
      if (row === null) {
        throw new Error("runaway outcome was not recorded");
      }
      return runawayState(row);
    },
    quarantineIfEnabled: async (request) => {
      const transitioned = await db
        .prepare(
          [
            "UPDATE installation_runaway_states",
            "SET quarantined = 1, quarantine_reason = ?2, updated_at = ?3",
            "WHERE installation_id = ?1 AND quarantined = 0",
            "RETURNING installation_id"
          ].join(" ")
        )
        .bind(request.installationId, request.reason, request.at.toISOString())
        .first<{ installation_id: string }>();
      return transitioned !== null;
    },
    recover: async (request) => {
      const recovered = await db
        .prepare(
          [
            "UPDATE installation_runaway_states",
            "SET consecutive_failures = 0, consecutive_timeouts = 0, quarantined = 0,",
            "quarantine_reason = NULL, updated_at = ?2",
            "WHERE installation_id = ?1 AND quarantined = 1",
            "RETURNING installation_id"
          ].join(" ")
        )
        .bind(request.installationId, request.at.toISOString())
        .first<{ installation_id: string }>();
      return recovered !== null;
    }
  };
}

export async function enforceRunawayPolicyAfterExecution(params: {
  store: RunawayGuardStore;
  notifications: RunawayNotificationSink;
  installationId: string;
  tenantId: string;
  pluginId: string;
  outcome: RunawayExecutionOutcome;
  policy: RunawayPolicy;
  at: Date;
}): Promise<RunawayGuardResult> {
  validatePolicy(params.policy);
  const state = await params.store.recordOutcome({
    installationId: params.installationId,
    outcome: params.outcome,
    at: params.at
  });
  const reason = state.reason ?? quarantineReason(state, params.policy);
  if (reason === undefined) {
    return { quarantined: false };
  }

  // The store performs a conditional enabled -> disabled transition. This keeps concurrent
  // completions from publishing duplicate quarantine notifications for the same incident.
  const transitioned = await params.store.quarantineIfEnabled({
    installationId: params.installationId,
    reason,
    at: params.at
  });
  if (transitioned) {
    await params.notifications.publish({
      type: "installation.quarantined",
      tenantId: params.tenantId,
      pluginId: params.pluginId,
      installationId: params.installationId,
      reason,
      consecutiveFailures: state.consecutiveFailures,
      consecutiveTimeouts: state.consecutiveTimeouts,
      emittedAt: params.at
    });
  }
  return { quarantined: true, reason };
}

export async function recoverRunawayInstallation(params: {
  store: RunawayGuardStore;
  installationId: string;
  at?: Date;
}): Promise<{ recovered: true }> {
  const recovered = await params.store.recover({
    installationId: params.installationId,
    at: params.at ?? new Date()
  });
  if (!recovered) {
    throw new Error("runaway installation recovery failed");
  }
  return { recovered: true };
}

function quarantineReason(
  state: RunawayGuardState,
  policy: RunawayPolicy
): RunawayQuarantineReason | undefined {
  if (state.consecutiveTimeouts >= policy.consecutiveTimeouts) {
    return "consecutive_timeouts";
  }
  if (state.consecutiveFailures >= policy.consecutiveFailures) {
    return "consecutive_failures";
  }
  return undefined;
}

function validatePolicy(policy: RunawayPolicy): void {
  if (
    !Number.isSafeInteger(policy.consecutiveFailures) ||
    policy.consecutiveFailures < 1 ||
    !Number.isSafeInteger(policy.consecutiveTimeouts) ||
    policy.consecutiveTimeouts < 1
  ) {
    throw new Error("runaway policy thresholds must be positive safe integers");
  }
}

function outcomeStatement(outcome: RunawayExecutionOutcome): string {
  const insertFailures = outcome === "success" ? 0 : 1;
  const insertTimeouts = outcome === "timeout" ? 1 : 0;
  const updateFailures = outcome === "success" ? "0" : "consecutive_failures + 1";
  const updateTimeouts = outcome === "timeout" ? "consecutive_timeouts + 1" : "0";
  return [
    "INSERT INTO installation_runaway_states",
    "(installation_id, consecutive_failures, consecutive_timeouts, quarantined, quarantine_reason, updated_at)",
    `VALUES (?1, ${String(insertFailures)}, ${String(insertTimeouts)}, 0, NULL, ?2)`,
    "ON CONFLICT(installation_id) DO UPDATE SET",
    `consecutive_failures = ${updateFailures}, consecutive_timeouts = ${updateTimeouts},`,
    "updated_at = excluded.updated_at",
    "RETURNING consecutive_failures, consecutive_timeouts, quarantined, quarantine_reason"
  ].join(" ");
}

function runawayState(row: RunawayStateRow): RunawayGuardState {
  const reason = quarantineReasonValue(row.quarantine_reason);
  return {
    consecutiveFailures: row.consecutive_failures,
    consecutiveTimeouts: row.consecutive_timeouts,
    quarantined: row.quarantined === 1,
    ...(reason === undefined ? {} : { reason })
  };
}

function quarantineReasonValue(value: string | null): RunawayQuarantineReason | undefined {
  if (value === null) {
    return undefined;
  }
  if (value === "consecutive_failures" || value === "consecutive_timeouts") {
    return value;
  }
  throw new Error("stored runaway quarantine reason is invalid");
}

interface RunawayStateRow {
  consecutive_failures: number;
  consecutive_timeouts: number;
  quarantined: number;
  quarantine_reason: string | null;
}
