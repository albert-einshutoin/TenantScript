import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SchemaMigrationBlockedError,
  createD1ControlPlaneStore,
  createD1SchemaMigrationTracker,
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

describe("D1 schema migration tracker", () => {
  it("aggregates selected schema versions across an app and blocks removal until usage is zero", async () => {
    const store = createD1ControlPlaneStore(testEnv.DB);
    await store.createApp({ id: "app_1", name: "App" });
    await store.createTenant({ id: "tenant_a", appId: "app_1", name: "Tenant A" });
    await store.createTenant({ id: "tenant_b", appId: "app_1", name: "Tenant B" });
    await store.createPlugin({ id: "plugin_1", appId: "app_1", key: "billing" });
    await store.createPluginVersion(pluginVersion("version_v1", "^1.0.0"));
    await store.createPluginVersion(
      pluginVersion("version_both", ">=1.0.0 <3.0.0", "plugin_1", "1.1.0")
    );
    await store.createInstallation({
      id: "installation_v1",
      tenantId: "tenant_a",
      pluginVersionId: "version_v1",
      enabled: false,
      priority: 10,
      config: {},
      grants: {}
    });
    await store.createInstallation({
      id: "installation_v2",
      tenantId: "tenant_b",
      pluginVersionId: "version_both",
      enabled: true,
      priority: 10,
      config: {},
      grants: {}
    });
    const tracker = createD1SchemaMigrationTracker(testEnv.DB, {
      "invoice.created": ["1.0.0", "2.0.0"]
    });

    await expect(tracker.readStatus({ appId: "app_1" })).resolves.toEqual([
      {
        hookName: "invoice.created",
        incompatibleInstallations: [],
        versions: [
          {
            version: "1.0.0",
            installationCount: 1,
            removable: false,
            blockingInstallations: [
              {
                installationId: "installation_v1",
                pluginKey: "billing",
                pluginVersion: "1.0.0",
                schemaRange: "^1.0.0"
              }
            ]
          },
          {
            version: "2.0.0",
            installationCount: 1,
            removable: false,
            blockingInstallations: [
              {
                installationId: "installation_v2",
                pluginKey: "billing",
                pluginVersion: "1.1.0",
                schemaRange: ">=1.0.0 <3.0.0"
              }
            ]
          }
        ]
      }
    ]);
    await expect(
      tracker.assertVersionRemovable({
        appId: "app_1",
        hookName: "invoice.created",
        version: "1.0.0"
      })
    ).rejects.toEqual(
      new SchemaMigrationBlockedError("invoice.created@1.0.0 is still required by 1 installation", [
        "installation_v1"
      ])
    );

    await testEnv.DB.prepare("DELETE FROM installations WHERE id = ?1")
      .bind("installation_v1")
      .run();
    await expect(
      tracker.assertVersionRemovable({
        appId: "app_1",
        hookName: "invoice.created",
        version: "1.0.0"
      })
    ).resolves.toEqual({ hookName: "invoice.created", version: "1.0.0", removable: true });
  });

  it("does not expose another app's installations and flags ranges outside the catalog", async () => {
    const store = createD1ControlPlaneStore(testEnv.DB);
    await store.createApp({ id: "app_1", name: "App 1" });
    await store.createApp({ id: "app_2", name: "App 2" });
    await store.createTenant({ id: "tenant_1", appId: "app_1", name: "Tenant 1" });
    await store.createTenant({ id: "tenant_2", appId: "app_2", name: "Tenant 2" });
    await store.createPlugin({ id: "plugin_1", appId: "app_1", key: "billing" });
    await store.createPlugin({ id: "plugin_2", appId: "app_2", key: "private-plugin" });
    await store.createPluginVersion(pluginVersion("version_v3", "^3.0.0", "plugin_1"));
    await store.createPluginVersion(pluginVersion("version_other", "^1.0.0", "plugin_2"));
    for (const [id, tenantId, pluginVersionId] of [
      ["installation_v3", "tenant_1", "version_v3"],
      ["private_installation", "tenant_2", "version_other"]
    ] as const) {
      await store.createInstallation({
        id,
        tenantId,
        pluginVersionId,
        enabled: true,
        priority: 10,
        config: {},
        grants: {}
      });
    }
    const tracker = createD1SchemaMigrationTracker(testEnv.DB, {
      "invoice.created": ["1.0.0", "2.0.0"]
    });

    const status = await tracker.readStatus({ appId: "app_1" });

    expect(status[0]?.incompatibleInstallations).toEqual([
      {
        installationId: "installation_v3",
        pluginKey: "billing",
        pluginVersion: "1.0.0",
        schemaRange: "^3.0.0"
      }
    ]);
    expect(JSON.stringify(status)).not.toContain("private");
  });
});

function pluginVersion(
  id: string,
  schemaVersionRange: string,
  pluginId = "plugin_1",
  version = "1.0.0"
): PluginVersionRecord {
  const manifest = {
    name: `${pluginId.replaceAll("_", "-")}-plugin`,
    version,
    hooks: [
      {
        name: "invoice.created",
        type: "event",
        timeoutMs: 250,
        schemaVersionRange
      }
    ],
    capabilities: {},
    configSchema: { properties: {}, required: [] },
    egress: { mode: "deny" },
    limits: { cpuMs: 50, timeoutMs: 500 }
  } satisfies TenantScriptManifest;
  return { id, pluginId, version: manifest.version, artifactHash: `${id}_hash`, manifest };
}
