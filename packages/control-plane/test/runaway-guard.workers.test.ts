import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createD1ControlPlaneStore,
  createD1RunawayGuardStore,
  enforceRunawayPolicyAfterExecution,
  recoverRunawayInstallation,
  type PluginVersionRecord
} from "../src/index.js";
import type { TenantScriptManifest } from "@tenantscript/manifest";

interface TestWorkersEnv {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestWorkersEnv;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("D1 runaway guard", () => {
  it("atomically quarantines after consecutive timeouts and explicitly recovers", async () => {
    await seedInstallation();
    const store = createD1RunawayGuardStore(testEnv.DB);
    const notifications = { publish: vi.fn() };
    const request = {
      store,
      notifications,
      installationId: "installation_1",
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      outcome: "timeout" as const,
      policy: { consecutiveFailures: 5, consecutiveTimeouts: 2 },
      at: new Date("2026-07-20T01:00:00.000Z")
    };

    await expect(enforceRunawayPolicyAfterExecution(request)).resolves.toEqual({
      quarantined: false
    });
    await expect(enforceRunawayPolicyAfterExecution(request)).resolves.toEqual({
      quarantined: true,
      reason: "consecutive_timeouts"
    });

    await expect(installationEnabled()).resolves.toBe(0);
    await expect(runawayState()).resolves.toEqual({
      consecutive_failures: 2,
      consecutive_timeouts: 2,
      quarantined: 1,
      quarantine_reason: "consecutive_timeouts"
    });
    expect(notifications.publish).toHaveBeenCalledTimes(1);

    await expect(
      recoverRunawayInstallation({
        store,
        installationId: "installation_1",
        at: new Date("2026-07-20T01:05:00.000Z")
      })
    ).resolves.toEqual({ recovered: true });
    await expect(installationEnabled()).resolves.toBe(1);
    await expect(runawayState()).resolves.toEqual({
      consecutive_failures: 0,
      consecutive_timeouts: 0,
      quarantined: 0,
      quarantine_reason: null
    });
  });

  it("fails recovery for an installation that is not quarantined", async () => {
    await seedInstallation();
    const store = createD1RunawayGuardStore(testEnv.DB);

    await expect(
      recoverRunawayInstallation({ store, installationId: "installation_1" })
    ).rejects.toThrow("runaway installation recovery failed");
    await expect(installationEnabled()).resolves.toBe(1);
  });

  it("publishes one quarantine transition when outcomes complete concurrently", async () => {
    await seedInstallation();
    const store = createD1RunawayGuardStore(testEnv.DB);
    const notifications = { publish: vi.fn() };
    const request = {
      store,
      notifications,
      installationId: "installation_1",
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      outcome: "error" as const,
      policy: { consecutiveFailures: 1, consecutiveTimeouts: 2 },
      at: new Date("2026-07-20T01:00:00.000Z")
    };

    await Promise.all([
      enforceRunawayPolicyAfterExecution(request),
      enforceRunawayPolicyAfterExecution(request)
    ]);

    expect(notifications.publish).toHaveBeenCalledTimes(1);
    await expect(installationEnabled()).resolves.toBe(0);
  });
});

async function seedInstallation(): Promise<void> {
  const store = createD1ControlPlaneStore(testEnv.DB);
  await store.createApp({ id: "app_1", name: "App" });
  await store.createTenant({ id: "tenant_1", appId: "app_1", name: "Tenant" });
  await store.createPlugin({ id: "plugin_1", appId: "app_1", key: "billing" });
  await store.createPluginVersion(pluginVersion());
  await store.createInstallation({
    id: "installation_1",
    tenantId: "tenant_1",
    pluginVersionId: "version_1",
    enabled: true,
    priority: 10,
    config: {},
    grants: {}
  });
}

async function installationEnabled(): Promise<number | undefined> {
  return (
    await testEnv.DB.prepare("SELECT enabled FROM installations WHERE id = ?1")
      .bind("installation_1")
      .first<{ enabled: number }>()
  )?.enabled;
}

async function runawayState(): Promise<Record<string, unknown> | null> {
  return testEnv.DB.prepare(
    [
      "SELECT consecutive_failures, consecutive_timeouts, quarantined, quarantine_reason",
      "FROM installation_runaway_states WHERE installation_id = ?1"
    ].join(" ")
  )
    .bind("installation_1")
    .first();
}

function pluginVersion(): PluginVersionRecord {
  const manifest = {
    name: "billing-plugin",
    version: "1.0.0",
    hooks: [
      {
        name: "invoice.created",
        type: "event",
        timeoutMs: 250,
        schemaVersionRange: "^1.0.0"
      }
    ],
    capabilities: {},
    configSchema: { properties: {}, required: [] },
    egress: { mode: "deny" },
    limits: { cpuMs: 50, timeoutMs: 500 }
  } satisfies TenantScriptManifest;
  return {
    id: "version_1",
    pluginId: "plugin_1",
    version: manifest.version,
    artifactHash: "version_1_hash",
    manifest
  };
}
