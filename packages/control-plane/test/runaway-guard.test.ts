import { describe, expect, it, vi } from "vitest";
import {
  enforceRunawayPolicyAfterExecution,
  createD1RunawayGuardStore,
  recoverRunawayInstallation,
  type D1DatabaseLike,
  type RunawayGuardState,
  type RunawayGuardStore
} from "../src/index.js";

describe("runaway guard", () => {
  it("quarantines and notifies once after consecutive failures reach the threshold", async () => {
    const store = createStore();
    const notifications = { publish: vi.fn() };

    for (const index of [1, 2]) {
      await expect(
        enforceRunawayPolicyAfterExecution({
          store,
          notifications,
          installationId: "installation_1",
          tenantId: "tenant_1",
          pluginId: "plugin_1",
          outcome: "error",
          policy: { consecutiveFailures: 3, consecutiveTimeouts: 2 },
          at: new Date(`2026-07-20T00:00:0${String(index)}.000Z`)
        })
      ).resolves.toEqual({ quarantined: false });
    }

    await expect(
      enforceRunawayPolicyAfterExecution({
        store,
        notifications,
        installationId: "installation_1",
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        outcome: "error",
        policy: { consecutiveFailures: 3, consecutiveTimeouts: 2 },
        at: new Date("2026-07-20T00:00:03.000Z")
      })
    ).resolves.toEqual({ quarantined: true, reason: "consecutive_failures" });

    expect(store.enabled).toBe(false);
    expect(notifications.publish).toHaveBeenCalledTimes(1);
    expect(notifications.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "installation.quarantined",
        installationId: "installation_1",
        reason: "consecutive_failures",
        consecutiveFailures: 3
      })
    );
  });

  it("uses the timeout threshold and a success resets only active counters", async () => {
    const store = createStore();
    const notifications = { publish: vi.fn() };
    const base = {
      store,
      notifications,
      installationId: "installation_1",
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      policy: { consecutiveFailures: 5, consecutiveTimeouts: 2 },
      at: new Date("2026-07-20T00:00:00.000Z")
    } as const;

    await enforceRunawayPolicyAfterExecution({ ...base, outcome: "timeout" });
    await enforceRunawayPolicyAfterExecution({ ...base, outcome: "success" });
    await enforceRunawayPolicyAfterExecution({ ...base, outcome: "timeout" });
    await expect(
      enforceRunawayPolicyAfterExecution({ ...base, outcome: "timeout" })
    ).resolves.toEqual({ quarantined: true, reason: "consecutive_timeouts" });

    expect(notifications.publish).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "consecutive_timeouts", consecutiveTimeouts: 2 })
    );
  });

  it("does not emit duplicate notifications for an already quarantined installation", async () => {
    const store = createStore();
    store.state = {
      consecutiveFailures: 3,
      consecutiveTimeouts: 0,
      quarantined: true,
      reason: "consecutive_failures"
    };
    store.enabled = false;
    const notifications = { publish: vi.fn() };

    await expect(
      enforceRunawayPolicyAfterExecution({
        store,
        notifications,
        installationId: "installation_1",
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        outcome: "error",
        policy: { consecutiveFailures: 3, consecutiveTimeouts: 2 },
        at: new Date("2026-07-20T00:00:04.000Z")
      })
    ).resolves.toEqual({ quarantined: true, reason: "consecutive_failures" });

    expect(notifications.publish).not.toHaveBeenCalled();
  });

  it("keeps the installation quarantined when notification delivery fails", async () => {
    const store = createStore();
    const providerFailure = new Error("synthetic queue unavailable");

    await expect(
      enforceRunawayPolicyAfterExecution({
        store,
        notifications: { publish: () => Promise.reject(providerFailure) },
        installationId: "installation_1",
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        outcome: "error",
        policy: { consecutiveFailures: 1, consecutiveTimeouts: 2 },
        at: new Date("2026-07-20T00:00:04.000Z")
      })
    ).rejects.toBe(providerFailure);

    expect(store.enabled).toBe(false);
    expect(store.state).toEqual(
      expect.objectContaining({ quarantined: true, reason: "consecutive_failures" })
    );
  });

  it("requires an explicit recovery that clears state before re-enabling", async () => {
    const store = createStore();
    store.state = {
      consecutiveFailures: 3,
      consecutiveTimeouts: 1,
      quarantined: true,
      reason: "consecutive_failures"
    };
    store.enabled = false;

    await expect(
      recoverRunawayInstallation({ store, installationId: "installation_1" })
    ).resolves.toEqual({ recovered: true });

    expect(store.state).toEqual({
      consecutiveFailures: 0,
      consecutiveTimeouts: 0,
      quarantined: false
    });
    expect(store.enabled).toBe(true);
  });

  it("rejects unsafe zero or fractional thresholds before recording an outcome", async () => {
    const store = createStore();

    await expect(
      enforceRunawayPolicyAfterExecution({
        store,
        notifications: { publish: vi.fn() },
        installationId: "installation_1",
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        outcome: "error",
        policy: { consecutiveFailures: 0, consecutiveTimeouts: 1.5 },
        at: new Date("2026-07-20T00:00:00.000Z")
      })
    ).rejects.toThrow("runaway policy thresholds must be positive safe integers");

    expect(store.state.consecutiveFailures).toBe(0);
  });
});

describe("D1 runaway guard store", () => {
  it("maps every outcome and persists quarantine and recovery transitions", async () => {
    const calls: { query: string; bindings: readonly unknown[] }[] = [];
    const db = queuedDatabase(
      [
        {
          consecutive_failures: 0,
          consecutive_timeouts: 0,
          quarantined: 0,
          quarantine_reason: null
        },
        {
          consecutive_failures: 1,
          consecutive_timeouts: 0,
          quarantined: 0,
          quarantine_reason: null
        },
        {
          consecutive_failures: 2,
          consecutive_timeouts: 1,
          quarantined: 1,
          quarantine_reason: "consecutive_timeouts"
        },
        { installation_id: "installation_1" },
        { installation_id: "installation_1" }
      ],
      calls
    );
    const store = createD1RunawayGuardStore(db);
    const at = new Date("2026-07-20T00:00:00.000Z");

    await expect(
      store.recordOutcome({ installationId: "installation_1", outcome: "success", at })
    ).resolves.toEqual({
      consecutiveFailures: 0,
      consecutiveTimeouts: 0,
      quarantined: false
    });
    await store.recordOutcome({ installationId: "installation_1", outcome: "error", at });
    await expect(
      store.recordOutcome({ installationId: "installation_1", outcome: "timeout", at })
    ).resolves.toEqual({
      consecutiveFailures: 2,
      consecutiveTimeouts: 1,
      quarantined: true,
      reason: "consecutive_timeouts"
    });
    await expect(
      store.quarantineIfEnabled({
        installationId: "installation_1",
        reason: "consecutive_timeouts",
        at
      })
    ).resolves.toBe(true);
    await expect(store.recover({ installationId: "installation_1", at })).resolves.toBe(true);

    expect(calls.map((call) => call.bindings)).toContainEqual([
      "installation_1",
      "consecutive_timeouts",
      at.toISOString()
    ]);
  });

  it("fails closed for missing writes and corrupted quarantine reasons", async () => {
    const missing = createD1RunawayGuardStore(queuedDatabase([null, null, null], []));
    const at = new Date("2026-07-20T00:00:00.000Z");

    await expect(
      missing.recordOutcome({ installationId: "missing", outcome: "error", at })
    ).rejects.toThrow("runaway outcome was not recorded");
    await expect(
      missing.quarantineIfEnabled({
        installationId: "missing",
        reason: "consecutive_failures",
        at
      })
    ).resolves.toBe(false);
    await expect(missing.recover({ installationId: "missing", at })).resolves.toBe(false);

    const corrupted = createD1RunawayGuardStore(
      queuedDatabase(
        [
          {
            consecutive_failures: 1,
            consecutive_timeouts: 0,
            quarantined: 1,
            quarantine_reason: "unexpected"
          }
        ],
        []
      )
    );
    await expect(
      corrupted.recordOutcome({ installationId: "installation_1", outcome: "error", at })
    ).rejects.toThrow("stored runaway quarantine reason is invalid");
  });
});

function createStore(): RunawayGuardStore & {
  enabled: boolean;
  state: RunawayGuardState;
} {
  return {
    enabled: true,
    state: {
      consecutiveFailures: 0,
      consecutiveTimeouts: 0,
      quarantined: false
    },
    recordOutcome(request) {
      if (request.outcome === "success") {
        this.state = { ...this.state, consecutiveFailures: 0, consecutiveTimeouts: 0 };
      } else {
        this.state = {
          ...this.state,
          consecutiveFailures: this.state.consecutiveFailures + 1,
          consecutiveTimeouts:
            request.outcome === "timeout" ? this.state.consecutiveTimeouts + 1 : 0
        };
      }
      return Promise.resolve(this.state);
    },
    quarantineIfEnabled(request) {
      if (!this.enabled || this.state.quarantined) {
        return Promise.resolve(false);
      }
      this.enabled = false;
      this.state = { ...this.state, quarantined: true, reason: request.reason };
      return Promise.resolve(true);
    },
    recover(request) {
      void request;
      this.state = {
        consecutiveFailures: 0,
        consecutiveTimeouts: 0,
        quarantined: false
      };
      this.enabled = true;
      return Promise.resolve(true);
    }
  };
}

function queuedDatabase(
  rows: readonly (Record<string, unknown> | null)[],
  calls: { query: string; bindings: readonly unknown[] }[]
): D1DatabaseLike {
  const queue = [...rows];
  return {
    prepare(query) {
      let bindings: readonly unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bindings = values;
          calls.push({ query, bindings });
          return statement;
        },
        run: () => Promise.reject(new Error("unexpected run")),
        first: <T>() => Promise.resolve((queue.shift() ?? null) as T | null),
        all: () => Promise.reject(new Error("unexpected all"))
      };
      return statement;
    }
  };
}
