import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1AdminRollbackStore, createD1ControlPlaneStore } from "../src/index.js";
import type { TenantScriptManifest } from "@tenantscript/manifest";

interface TestWorkersEnv {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestWorkersEnv;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  const store = createD1ControlPlaneStore(testEnv.DB);
  await store.createApp({ id: "app_1", name: "App 1" });
  await store.createApp({ id: "app_other", name: "Other" });
  await store.createTenant({ id: "tenant_1", appId: "app_1", name: "Tenant 1" });
  await store.createTenant({ id: "tenant_other", appId: "app_other", name: "Other" });
  await store.createPlugin({ id: "plugin_1", appId: "app_1", key: "invoice-notify" });
  await store.createPlugin({ id: "plugin_other", appId: "app_other", key: "other" });
  await store.createPluginVersion(version("version_1_2_2", "plugin_1", "1.2.2"));
  await store.createPluginVersion(version("version_1_3_0", "plugin_1", "1.3.0"));
  await store.createPluginVersion(version("version_other", "plugin_other", "1.0.0"));
  await store.createInstallation({
    id: "installation_1",
    tenantId: "tenant_1",
    pluginVersionId: "version_1_3_0",
    enabled: true,
    priority: 10,
    config: { notifyChannel: "secret-config" },
    grants: { "slack.send": { channel: "secret-grant" } }
  });
});

describe("D1 Admin rollback transaction", () => {
  it("moves the pin and appends its audit atomically", async () => {
    const rollback = createD1AdminRollbackStore(testEnv.DB, {
      auditId: () => "audit_rollback_1",
      now: () => new Date("2026-07-19T17:00:00.000Z")
    });

    await expect(rollback.rollback(request())).resolves.toMatchObject({
      outcome: "rolled_back",
      fromVersion: "1.3.0",
      toVersion: "1.2.2",
      revision: 1
    });
    await expect(
      testEnv.DB.prepare("SELECT plugin_version_id, revision FROM installations WHERE id = ?")
        .bind("installation_1")
        .first()
    ).resolves.toEqual({ plugin_version_id: "version_1_2_2", revision: 1 });
    const audit = await testEnv.DB.prepare(
      "SELECT actor, action, before_json, after_json FROM admin_audit_events WHERE id = ?"
    )
      .bind("audit_rollback_1")
      .first<{ actor: string; action: string; before_json: string; after_json: string }>();
    expect(audit).toEqual({
      actor: "manager-subject",
      action: "installation.rollback",
      before_json: '{"versionId":"version_1_3_0","version":"1.3.0","revision":0}',
      after_json: '{"versionId":"version_1_2_2","version":"1.2.2","revision":1}'
    });
    expect(JSON.stringify(audit)).not.toContain("secret-config");
    expect(JSON.stringify(audit)).not.toContain("secret-grant");
  });

  it("rejects cross-app targets and stale retries without side effects", async () => {
    const rollback = createD1AdminRollbackStore(testEnv.DB);
    await expect(rollback.rollback({ ...request(), targetVersionId: "version_other" })).resolves.toBeNull();
    await expect(rollback.rollback({ ...request(), expectedRevision: 1 })).resolves.toMatchObject({
      outcome: "conflict",
      revision: 0
    });
    await expect(
      testEnv.DB.prepare("SELECT COUNT(*) AS count FROM admin_audit_events").first()
    ).resolves.toEqual({ count: 0 });
  });
});

function request() {
  return {
    appId: "app_1",
    tenantId: "tenant_1",
    actor: "manager-subject",
    installationId: "installation_1",
    targetVersionId: "version_1_2_2",
    expectedRevision: 0
  };
}

function version(id: string, pluginId: string, versionNumber: string) {
  return {
    id,
    pluginId,
    version: versionNumber,
    artifactHash: `hash_${versionNumber}`,
    manifest: manifest(versionNumber)
  };
}

function manifest(version: string): TenantScriptManifest {
  return {
    name: "invoice-notify",
    version,
    hooks: [{ name: "invoice.created", type: "event", timeoutMs: 250 }],
    capabilities: { "slack.send": { channel: "$config.notifyChannel" } },
    configSchema: { properties: { notifyChannel: { type: "string" } }, required: ["notifyChannel"] },
    egress: { mode: "deny" },
    limits: { cpuMs: 50, timeoutMs: 500 }
  };
}
