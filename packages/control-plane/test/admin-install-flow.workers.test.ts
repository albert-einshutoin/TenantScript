import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createD1AdminDashboardStore,
  createD1AdminInstallFlowStore,
  createD1ControlPlaneStore
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
  await seedCatalog();
});

describe("D1 Admin install flow", () => {
  it("lists uninstalled app versions and returns a value-free install preview", async () => {
    const dashboard = createD1AdminDashboardStore(testEnv.DB);
    const versions = await dashboard.readSection({
      appId: "app_1",
      tenantId: "tenant_1",
      section: "pluginVersions",
      limit: 10
    });

    expect(versions.items).toEqual([
      expect.objectContaining({
        id: "version_1",
        pluginId: "plugin_1",
        pluginKey: "invoice-notify",
        version: "1.0.0"
      })
    ]);

    const flow = createD1AdminInstallFlowStore(testEnv.DB);
    const preview = await flow.readVersion({ appId: "app_1", versionId: "version_1" });
    expect(preview).toEqual({
      versionId: "version_1",
      pluginKey: "invoice-notify",
      version: "1.0.0",
      configFields: [
        { name: "enabledForInvoices", type: "boolean", required: false, hasDefault: true },
        { name: "notifyChannel", type: "string", required: true, hasDefault: false }
      ],
      capabilities: [
        {
          name: "slack.send",
          scopeKeys: ["channel"],
          configReferences: ["notifyChannel"]
        }
      ],
      egress: { mode: "deny", allowlistedHostCount: 0 }
    });
    expect(JSON.stringify(preview)).not.toContain("manifest-default-secret");
    await expect(
      flow.readVersion({ appId: "app_1", versionId: "other_version" })
    ).resolves.toBeNull();
  });

  it("validates config and exact capability confirmation before atomically installing and auditing", async () => {
    const flow = createD1AdminInstallFlowStore(testEnv.DB, {
      installationId: () => "installation_new",
      auditId: () => "installation_install_audit"
    });

    await expect(
      flow.install({
        appId: "app_1",
        tenantId: "tenant_1",
        actor: "manager-subject",
        versionId: "version_1",
        config: { notifyChannel: "C123" },
        confirmedCapabilities: ["slack.send"],
        enabled: true,
        priority: 20
      })
    ).resolves.toEqual({
      id: "installation_new",
      pluginKey: "invoice-notify",
      version: "1.0.0",
      enabled: true,
      priority: 20,
      revision: 0
    });

    await expect(
      testEnv.DB.prepare(
        "SELECT tenant_id, plugin_version_id, enabled, priority, config_json, grants_json, revision FROM installations WHERE id = ?"
      )
        .bind("installation_new")
        .first()
    ).resolves.toEqual({
      tenant_id: "tenant_1",
      plugin_version_id: "version_1",
      enabled: 1,
      priority: 20,
      config_json: JSON.stringify({ notifyChannel: "C123", enabledForInvoices: true }),
      grants_json: JSON.stringify({ "slack.send": { channel: "C123" } }),
      revision: 0
    });
    const audit = await testEnv.DB.prepare(
      "SELECT actor, action, before_json, after_json FROM admin_audit_events WHERE id = ?"
    )
      .bind("installation_install_audit")
      .first();
    expect(audit).toEqual({
      actor: "manager-subject",
      action: "installation.install",
      before_json: "{}",
      after_json: JSON.stringify({
        enabled: true,
        priority: 20,
        revision: 0,
        configFields: ["enabledForInvoices", "notifyChannel"],
        capabilities: ["slack.send"]
      })
    });
    expect(JSON.stringify(audit)).not.toContain("C123");
  });

  it("rejects missing config, unconfirmed grants, viewer-like scope injection, and rolls back audit failure", async () => {
    const flow = createD1AdminInstallFlowStore(testEnv.DB, {
      installationId: () => "installation_rejected",
      auditId: () => "duplicate_audit"
    });
    await testEnv.DB.prepare(
      "INSERT INTO admin_audit_events (id, installation_id, tenant_id, app_id, plugin_id, revision, actor, action, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        "duplicate_audit",
        "seed_installation",
        "tenant_1",
        "app_1",
        "plugin_1",
        0,
        "seed",
        "installation.seed",
        "{}",
        "{}",
        "2026-07-19T00:00:00.000Z"
      )
      .run();

    await expect(
      flow.install({
        appId: "app_1",
        tenantId: "tenant_1",
        actor: "manager-subject",
        versionId: "version_1",
        config: {},
        confirmedCapabilities: ["slack.send"],
        enabled: true,
        priority: 20
      })
    ).rejects.toMatchObject({ code: "invalid_config" });
    await expect(
      flow.install({
        appId: "app_1",
        tenantId: "tenant_1",
        actor: "manager-subject",
        versionId: "version_1",
        config: { notifyChannel: "C123" },
        confirmedCapabilities: [],
        enabled: true,
        priority: 20
      })
    ).rejects.toMatchObject({ code: "capability_confirmation_mismatch" });
    await expect(
      flow.install({
        appId: "app_1",
        tenantId: "tenant_other_app",
        actor: "manager-subject",
        versionId: "version_1",
        config: { notifyChannel: "C123" },
        confirmedCapabilities: ["slack.send"],
        enabled: true,
        priority: 20
      })
    ).resolves.toBeNull();
    await expect(
      flow.install({
        appId: "app_1",
        tenantId: "tenant_1",
        actor: "manager-subject",
        versionId: "version_1",
        config: { notifyChannel: "C123" },
        confirmedCapabilities: ["slack.send"],
        enabled: true,
        priority: 20
      })
    ).rejects.toThrow();
    await expect(
      testEnv.DB.prepare("SELECT COUNT(*) AS count FROM installations WHERE id = ?")
        .bind("installation_rejected")
        .first()
    ).resolves.toEqual({ count: 0 });
  });
});

async function seedCatalog(): Promise<void> {
  const store = createD1ControlPlaneStore(testEnv.DB);
  await store.createApp({ id: "app_1", name: "App 1" });
  await store.createApp({ id: "app_other", name: "Other app" });
  await store.createTenant({ id: "tenant_1", appId: "app_1", name: "Tenant 1" });
  await store.createTenant({ id: "tenant_other_app", appId: "app_other", name: "Other" });
  await store.createPlugin({ id: "plugin_1", appId: "app_1", key: "invoice-notify" });
  await store.createPlugin({ id: "plugin_other", appId: "app_other", key: "other-plugin" });
  await store.createPluginVersion({
    id: "version_1",
    pluginId: "plugin_1",
    version: "1.0.0",
    artifactHash: "hash_1",
    manifest: manifest("invoice-notify", "1.0.0")
  });
  await store.createPluginVersion({
    id: "other_version",
    pluginId: "plugin_other",
    version: "1.0.0",
    artifactHash: "other_hash",
    manifest: manifest("other-plugin", "1.0.0")
  });
  await store.createInstallation({
    id: "seed_installation",
    tenantId: "tenant_1",
    pluginVersionId: "version_1",
    enabled: true,
    priority: 10,
    config: { notifyChannel: "seed" },
    grants: { "slack.send": { channel: "seed" } }
  });
}

function manifest(name: string, version: string): TenantScriptManifest {
  return {
    name,
    version,
    hooks: [{ name: "invoice.created", type: "event", timeoutMs: 250 }],
    capabilities: { "slack.send": { channel: "$config.notifyChannel" } },
    configSchema: {
      properties: {
        notifyChannel: { type: "string" },
        enabledForInvoices: { type: "boolean", default: true }
      },
      required: ["notifyChannel"]
    },
    egress: { mode: "deny" },
    limits: { cpuMs: 50, timeoutMs: 500 }
  };
}
