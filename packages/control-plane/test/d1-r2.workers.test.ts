import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactAlreadyExistsError,
  createD1ControlPlaneStore,
  createR2ArtifactStore,
  type PluginVersionRecord
} from "../src/index.js";
import type { TenantScriptManifest } from "@tenantscript/manifest";

interface TestWorkersEnv {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  PROBE_DO: DurableObjectNamespace;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestWorkersEnv;

const manifest = {
  name: "large-invoice-notify",
  version: "1.0.0",
  hooks: [{ name: "invoice.created", type: "event", timeoutMs: 250, schemaVersionRange: "^1.0.0" }],
  capabilities: { "slack.send": { channel: "C123" } },
  configSchema: { properties: {}, required: [] },
  egress: { mode: "deny" },
  limits: { cpuMs: 50, timeoutMs: 500 }
} satisfies TenantScriptManifest;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("D1 control-plane store", () => {
  it("applies migrations and performs CRUD smoke for core tables", async () => {
    const store = createD1ControlPlaneStore(testEnv.DB);
    await seedInstallation(store, { enabled: true });

    await expect(store.findAppById("app_1")).resolves.toEqual({
      id: "app_1",
      name: "Example SaaS"
    });
    await expect(store.findTenantById("tenant_1")).resolves.toEqual({
      id: "tenant_1",
      appId: "app_1",
      name: "Acme"
    });
    await store.writeExecution({
      id: "exec_1",
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      hookName: "invoice.created",
      version: "1.0.0",
      status: "success",
      durationMs: 12,
      capabilityCalls: [{ name: "slack.send", status: "success" }],
      createdAt: new Date("2026-06-12T00:00:00.000Z")
    });

    await expect(store.searchExecutions({ tenantId: "tenant_1" })).resolves.toHaveLength(1);
  });

  it("resolves active tenant installations into host-sdk planner input", async () => {
    const store = createD1ControlPlaneStore(testEnv.DB);
    await seedInstallation(store, { enabled: true });
    await store.createTenant({ id: "tenant_2", appId: "app_1", name: "Other Tenant" });
    await store.createInstallation({
      id: "inst_other_tenant",
      tenantId: "tenant_2",
      pluginVersionId: "version_1",
      enabled: true,
      priority: 0,
      config: {},
      grants: {}
    });
    await store.createInstallation({
      id: "inst_disabled",
      tenantId: "tenant_1",
      pluginVersionId: "version_1",
      enabled: false,
      priority: 0,
      config: {},
      grants: {}
    });

    const installations = await store.resolveInstallationsForHook({
      tenantId: "tenant_1",
      hookName: "invoice.created"
    });

    expect(installations.map((installation) => installation.id)).toEqual(["inst_1"]);
    expect(installations[0]).toMatchObject({
      pluginId: "plugin_1",
      hooks: ["invoice.created"],
      version: "1.0.0"
    });
  });

  it("finds plugins by app key and lists immutable versions", async () => {
    const store = createD1ControlPlaneStore(testEnv.DB);
    await seedInstallation(store, { enabled: true });

    const plugin = await store.findPluginByKey({
      appId: "app_1",
      key: "large-invoice-notify"
    });
    const versions = plugin === null ? [] : await store.listPluginVersions({ pluginId: plugin.id });

    expect(plugin).toMatchObject({
      id: "plugin_1",
      appId: "app_1",
      key: "large-invoice-notify"
    });
    expect(versions).toEqual([
      expect.objectContaining({
        id: "version_1",
        pluginId: "plugin_1",
        version: "1.0.0",
        artifactHash: "hash_1",
        manifest
      })
    ]);
    await expect(
      store.findPluginVersion({ pluginId: "plugin_1", version: "1.0.0" })
    ).resolves.toEqual(expect.objectContaining({ id: "version_1" }));
  });
});

describe("R2 artifact store", () => {
  it("round-trips artifacts by hash and rejects overwrites", async () => {
    const store = createR2ArtifactStore(testEnv.ARTIFACTS);
    await store.putArtifact("hash_1", "bundle-code");

    const content = await store.getArtifact("hash_1");
    expect(new TextDecoder().decode(content ?? new ArrayBuffer(0))).toBe("bundle-code");
    await expect(store.putArtifact("hash_1", "replacement")).rejects.toThrow(
      ArtifactAlreadyExistsError
    );
  });
});

describe("Durable Object binding", () => {
  it("persists state inside the workerd test runtime", async () => {
    const id = testEnv.PROBE_DO.newUniqueId();
    const stub = testEnv.PROBE_DO.get(id);

    await expect((await stub.fetch("https://example.com")).text()).resolves.toBe("1");
    await expect((await stub.fetch("https://example.com")).text()).resolves.toBe("2");
  });
});

async function seedInstallation(
  store: ReturnType<typeof createD1ControlPlaneStore>,
  options: { enabled: boolean }
) {
  await store.createApp({ id: "app_1", name: "Example SaaS" });
  await store.createTenant({ id: "tenant_1", appId: "app_1", name: "Acme" });
  await store.createPlugin({ id: "plugin_1", appId: "app_1", key: "large-invoice-notify" });
  await store.createPluginVersion(pluginVersion());
  await store.createInstallation({
    id: "inst_1",
    tenantId: "tenant_1",
    pluginVersionId: "version_1",
    enabled: options.enabled,
    priority: 10,
    config: { notifyChannel: "C123" },
    grants: { "slack.send": { channel: "C123" } }
  });
}

function pluginVersion(): PluginVersionRecord {
  return {
    id: "version_1",
    pluginId: "plugin_1",
    version: "1.0.0",
    artifactHash: "hash_1",
    manifest
  };
}
