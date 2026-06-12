import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1ControlPlaneStore } from "../src/index.js";
import type { TenantScriptManifest } from "@tenantscript/manifest";

interface TestWorkersEnv {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestWorkersEnv;

const manifest = {
  name: "large-invoice-notify",
  version: "1.0.0",
  hooks: [{ name: "invoice.created", type: "event", timeoutMs: 250 }],
  capabilities: { "slack.send": { channel: "C123" } },
  configSchema: { properties: {}, required: [] },
  egress: { mode: "deny" },
  limits: { cpuMs: 50, timeoutMs: 500 }
} satisfies TenantScriptManifest;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("D1 tenant boundary security suite", () => {
  it("does not resolve another tenant's installations, grants, or config", async () => {
    const store = createD1ControlPlaneStore(testEnv.DB);
    await seedTenant(store, "tenant_1", "C123");
    await seedTenant(store, "tenant_2", "C999");

    const installations = await store.resolveInstallationsForHook({
      tenantId: "tenant_1",
      hookName: "invoice.created"
    });

    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({
      id: "tenant_1_installation",
      tenantId: "tenant_1",
      config: { notifyChannel: "C123" },
      grants: { "slack.send": { channel: "C123" } }
    });
    expect(JSON.stringify(installations)).not.toContain("C999");
  });

  it("does not return another tenant's execution logs", async () => {
    const store = createD1ControlPlaneStore(testEnv.DB);
    await seedTenant(store, "tenant_1", "C123");
    await seedTenant(store, "tenant_2", "C999");
    await store.writeExecution({
      id: "exec_tenant_1",
      tenantId: "tenant_1",
      pluginId: "tenant_1_plugin",
      hookName: "invoice.created",
      version: "1.0.0",
      status: "success",
      durationMs: 10,
      capabilityCalls: [],
      createdAt: new Date("2026-06-12T00:00:00.000Z")
    });
    await store.writeExecution({
      id: "exec_tenant_2",
      tenantId: "tenant_2",
      pluginId: "tenant_2_plugin",
      hookName: "invoice.created",
      version: "1.0.0",
      status: "error",
      durationMs: 8,
      error: "tenant 2 only",
      capabilityCalls: [],
      createdAt: new Date("2026-06-12T00:00:01.000Z")
    });

    const records = await store.searchExecutions({ tenantId: "tenant_1" });

    expect(records.map((record) => record.id)).toEqual(["exec_tenant_1"]);
    expect(JSON.stringify(records)).not.toContain("tenant 2 only");
  });
});

async function seedTenant(
  store: ReturnType<typeof createD1ControlPlaneStore>,
  tenantId: string,
  channel: string
) {
  await store.createApp({ id: `${tenantId}_app`, name: tenantId });
  await store.createTenant({ id: tenantId, appId: `${tenantId}_app`, name: tenantId });
  await store.createPlugin({
    id: `${tenantId}_plugin`,
    appId: `${tenantId}_app`,
    key: "large-invoice-notify"
  });
  await store.createPluginVersion({
    id: `${tenantId}_version`,
    pluginId: `${tenantId}_plugin`,
    version: "1.0.0",
    artifactHash: `${tenantId}_hash`,
    manifest
  });
  await store.createInstallation({
    id: `${tenantId}_installation`,
    tenantId,
    pluginVersionId: `${tenantId}_version`,
    enabled: true,
    priority: 10,
    config: { notifyChannel: channel },
    grants: { "slack.send": { channel } }
  });
}
