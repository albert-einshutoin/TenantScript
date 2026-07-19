import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createControlPlaneApi,
  createD1AdminApprovalDecisionStore,
  createD1AdminInstallFlowStore,
  createD1AdminRollbackStore,
  createD1ControlPlaneStore
} from "../src/index.js";
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
  it("rejects installing an app plugin into another app's tenant", async () => {
    const store = createD1ControlPlaneStore(testEnv.DB);
    const api = createControlPlaneApi({
      store,
      artifacts: {
        putArtifact: (hash) => Promise.resolve({ hash })
      }
    });

    await store.createApp({ id: "app_1", name: "Example SaaS" });
    await store.createApp({ id: "app_2", name: "Other SaaS" });
    await store.createTenant({ id: "tenant_other", appId: "app_2", name: "Other Tenant" });
    await store.createPlugin({ id: "plugin_1", appId: "app_1", key: "large-invoice-notify" });
    await store.createPluginVersion({
      id: "version_1",
      pluginId: "plugin_1",
      version: "1.0.0",
      artifactHash: "hash_1",
      manifest
    });

    await expect(
      api.installPlugin({
        id: "inst_cross_scope",
        appId: "app_1",
        tenantId: "tenant_other",
        pluginKey: "large-invoice-notify",
        version: "1.0.0",
        config: {},
        grants: { "slack.send": { channel: "C123" } },
        priority: 10
      })
    ).rejects.toMatchObject({ status: 404, code: "tenant_not_found" });
    await expect(
      store.resolveInstallationsForHook({
        tenantId: "tenant_other",
        hookName: "invoice.created"
      })
    ).resolves.toEqual([]);
  });

  it("keeps Admin install creation and resolved grants behind the app/tenant D1 boundary", async () => {
    const store = createD1ControlPlaneStore(testEnv.DB);
    await store.createApp({ id: "app_1", name: "Example SaaS" });
    await store.createApp({ id: "app_2", name: "Other SaaS" });
    await store.createTenant({ id: "tenant_1", appId: "app_1", name: "Tenant 1" });
    await store.createTenant({ id: "tenant_2", appId: "app_2", name: "Tenant 2" });
    await store.createPlugin({ id: "plugin_1", appId: "app_1", key: "large-invoice-notify" });
    await store.createPluginVersion({
      id: "version_1",
      pluginId: "plugin_1",
      version: "1.0.0",
      artifactHash: "hash_1",
      manifest
    });
    const flow = createD1AdminInstallFlowStore(testEnv.DB, {
      installationId: () => "admin_install",
      auditId: () => "admin_install_audit"
    });

    await expect(
      flow.install({
        appId: "app_1",
        tenantId: "tenant_2",
        actor: "manager",
        idempotencyKey: "install-security-key-0001",
        versionId: "version_1",
        config: {},
        confirmedCapabilities: ["slack.send"],
        enabled: false,
        priority: 10
      })
    ).resolves.toBeNull();
    await expect(
      testEnv.DB.prepare("SELECT COUNT(*) AS count FROM installations WHERE id = ?")
        .bind("admin_install")
        .first()
    ).resolves.toEqual({ count: 0 });
  });

  it("cannot rollback an installation to another app's version", async () => {
    const store = createD1ControlPlaneStore(testEnv.DB);
    await store.createApp({ id: "app_1", name: "App 1" });
    await store.createApp({ id: "app_2", name: "App 2" });
    await store.createTenant({ id: "tenant_1", appId: "app_1", name: "Tenant 1" });
    await store.createPlugin({ id: "plugin_1", appId: "app_1", key: "safe-plugin" });
    await store.createPlugin({ id: "plugin_2", appId: "app_2", key: "other-plugin" });
    await store.createPluginVersion({
      id: "version_current",
      pluginId: "plugin_1",
      version: "2.0.0",
      artifactHash: "hash_current",
      manifest: { ...manifest, name: "safe-plugin", version: "2.0.0" }
    });
    await store.createPluginVersion({
      id: "version_other",
      pluginId: "plugin_2",
      version: "1.0.0",
      artifactHash: "hash_other",
      manifest: { ...manifest, name: "other-plugin", version: "1.0.0" }
    });
    await store.createInstallation({
      id: "installation_1",
      tenantId: "tenant_1",
      pluginVersionId: "version_current",
      enabled: true,
      priority: 10,
      config: { customerSecret: "must-stay-private" },
      grants: {}
    });
    const rollback = createD1AdminRollbackStore(testEnv.DB);

    await expect(
      rollback.rollback({
        appId: "app_1",
        tenantId: "tenant_1",
        actor: "manager",
        idempotencyKey: "rollback-security-key-0001",
        installationId: "installation_1",
        targetVersionId: "version_other",
        expectedRevision: 0
      })
    ).resolves.toBeNull();
    await expect(
      testEnv.DB.prepare("SELECT plugin_version_id, revision FROM installations WHERE id = ?")
        .bind("installation_1")
        .first()
    ).resolves.toEqual({ plugin_version_id: "version_current", revision: 0 });
    await expect(
      testEnv.DB.prepare("SELECT COUNT(*) AS count FROM admin_audit_events").first()
    ).resolves.toEqual({ count: 0 });
  });

  it("keeps approval decisions and audits inside identity scope without subject leakage", async () => {
    const store = createD1ControlPlaneStore(testEnv.DB);
    await store.createApp({ id: "app_1", name: "App 1" });
    await store.createApp({ id: "app_2", name: "App 2" });
    await store.createTenant({ id: "tenant_1", appId: "app_1", name: "Tenant 1" });
    await store.createTenant({ id: "tenant_2", appId: "app_2", name: "Tenant 2" });
    await store.createPlugin({ id: "plugin_1", appId: "app_1", key: "plugin-1" });
    await store.createPlugin({ id: "plugin_2", appId: "app_2", key: "plugin-2" });
    await store.createApproval({
      id: "approval_other",
      tenantId: "tenant_2",
      pluginId: "plugin_2",
      role: "manager",
      subject: { customerSecret: "must-not-enter-audit" },
      resumeHook: "approval.decided",
      state: "pending",
      expiresAt: new Date("2026-07-21T00:00:00.000Z"),
      createdAt: new Date("2026-07-19T00:00:00.000Z")
    });
    const decisions = createD1AdminApprovalDecisionStore(testEnv.DB, {
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    await expect(
      decisions.decide({
        appId: "app_1",
        tenantId: "tenant_1",
        actor: "manager",
        actorRole: "manager",
        approvalId: "approval_other",
        decision: "approved"
      })
    ).rejects.toMatchObject({ code: "approval_not_found" });
    const audits = await testEnv.DB.prepare("SELECT * FROM approval_audit_events").all();
    expect(audits.results).toEqual([]);
    expect(JSON.stringify(audits)).not.toContain("must-not-enter-audit");
  });

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
