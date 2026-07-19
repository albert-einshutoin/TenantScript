import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createD1AdminDashboardStore,
  createD1ControlPlaneStore,
  type AdminDashboardSection,
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

describe("D1 Admin dashboard read model", () => {
  it("filters every section at the SQL boundary and redacts stored payloads", async () => {
    await seedDashboard();
    const dashboard = createD1AdminDashboardStore(testEnv.DB);

    const sections: readonly AdminDashboardSection[] = [
      "installations",
      "pluginVersions",
      "approvals",
      "executions"
    ];
    const pages = await Promise.all(
      sections.map((section) =>
        dashboard.readSection({
          appId: "app_1",
          tenantId: "tenant_1",
          section,
          limit: 10
        })
      )
    );
    const serialized = JSON.stringify(pages);

    expect(serialized).toContain("tenant_1_installation_a");
    expect(serialized).toContain("tenant_1_execution");
    expect(serialized).not.toContain("tenant_2");
    expect(serialized).not.toContain("other_app");
    expect(serialized).not.toContain("secret-config");
    expect(serialized).not.toContain("customer-payload");
    expect(serialized).not.toContain("private execution error");
    expect(serialized).not.toContain("manifest-secret");
  });

  it("uses deterministic keyset pagination without duplicates or gaps", async () => {
    await seedDashboard();
    const dashboard = createD1AdminDashboardStore(testEnv.DB);

    const first = await dashboard.readSection({
      appId: "app_1",
      tenantId: "tenant_1",
      section: "installations",
      limit: 1
    });
    expect(first.section).toBe("installations");
    expect(first.items.map((item) => item.id)).toEqual(["tenant_1_installation_a"]);
    expect(first.nextPosition).toBe("tenant_1_installation_a");

    const second = await dashboard.readSection({
      appId: "app_1",
      tenantId: "tenant_1",
      section: "installations",
      limit: 1,
      position: first.nextPosition
    });
    expect(second.items.map((item) => item.id)).toEqual(["tenant_1_installation_b"]);
    expect(second.nextPosition).toBeUndefined();
  });

  it("returns an honest daily execution/runtime summary and rejects app mismatch", async () => {
    await seedDashboard();
    const dashboard = createD1AdminDashboardStore(testEnv.DB);

    await expect(
      dashboard.readUsageSummary({
        appId: "app_1",
        tenantId: "tenant_1",
        date: "2026-07-19"
      })
    ).resolves.toEqual({ date: "2026-07-19", executions: 1, runtimeMs: 12 });

    const wrongApp = await dashboard.readSection({
      appId: "app_other",
      tenantId: "tenant_1",
      section: "installations",
      limit: 10
    });
    expect(wrongApp.items).toEqual([]);
  });
});

async function seedDashboard(): Promise<void> {
  const store = createD1ControlPlaneStore(testEnv.DB);
  await store.createApp({ id: "app_1", name: "App 1" });
  await store.createApp({ id: "app_other", name: "Other app" });
  await store.createTenant({ id: "tenant_1", appId: "app_1", name: "Tenant 1" });
  await store.createTenant({ id: "tenant_2", appId: "app_1", name: "Tenant 2" });
  await store.createTenant({ id: "tenant_other_app", appId: "app_other", name: "Other" });

  await seedTenant(store, "tenant_1", "app_1", ["a", "b"]);
  await seedTenant(store, "tenant_2", "app_1", ["a"]);
  await seedTenant(store, "tenant_other_app", "app_other", ["a"]);
}

async function seedTenant(
  store: ReturnType<typeof createD1ControlPlaneStore>,
  tenantId: string,
  appId: string,
  suffixes: readonly string[]
): Promise<void> {
  const pluginId = `${tenantId}_plugin`;
  await store.createPlugin({ id: pluginId, appId, key: `${tenantId}-plugin` });
  for (const suffix of suffixes) {
    const versionId = `${tenantId}_version_${suffix}`;
    await store.createPluginVersion(pluginVersion(versionId, pluginId, suffix));
    await store.createInstallation({
      id: `${tenantId}_installation_${suffix}`,
      tenantId,
      pluginVersionId: versionId,
      enabled: true,
      priority: suffix === "a" ? 10 : 20,
      config: { value: "secret-config" },
      grants: { permission: "secret-grant" }
    });
  }
  await store.createApproval({
    id: `${tenantId}_approval`,
    tenantId,
    pluginId,
    role: "manager",
    subject: { value: "customer-payload" },
    resumeHook: "approval.decided",
    state: "pending",
    expiresAt: new Date("2026-07-20T00:00:00.000Z"),
    createdAt: new Date("2026-07-19T00:00:00.000Z")
  });
  await store.writeExecution({
    id: `${tenantId}_execution`,
    tenantId,
    pluginId,
    hookName: "invoice.created",
    version: "1.0.0",
    status: "error",
    durationMs: 12,
    error: "private execution error",
    capabilityCalls: [{ name: "slack.send", status: "error" }],
    createdAt: new Date("2026-07-19T12:00:00.000Z")
  });
}

function pluginVersion(id: string, pluginId: string, suffix: string): PluginVersionRecord {
  const manifest = {
    name: `${pluginId}-${suffix}`,
    version: `1.0.${suffix === "a" ? "0" : "1"}`,
    hooks: [{ name: "invoice.created", type: "event", timeoutMs: 250 }],
    capabilities: {},
    configSchema: { properties: { hidden: { const: "manifest-secret" } }, required: [] },
    egress: { mode: "deny" },
    limits: { cpuMs: 50, timeoutMs: 500 }
  } satisfies TenantScriptManifest;
  return {
    id,
    pluginId,
    version: manifest.version,
    artifactHash: `${id}_hash`,
    manifest
  };
}
