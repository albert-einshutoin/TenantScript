import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createD1AdminDashboardStore,
  createD1AdminInstallationCommandStore,
  createD1AdminInstallationDetailStore,
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
      ...(first.nextPosition === undefined ? {} : { position: first.nextPosition })
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

  it("reads installation permission metadata through the real tenant/app D1 boundary", async () => {
    await seedDashboard();
    const reviews = createD1AdminInstallationDetailStore(testEnv.DB);

    const own = await reviews.readInstallation({
      appId: "app_1",
      tenantId: "tenant_1",
      id: "tenant_1_installation_a"
    });
    const otherTenant = await reviews.readInstallation({
      appId: "app_1",
      tenantId: "tenant_1",
      id: "tenant_2_installation_a"
    });
    const wrongApp = await reviews.readInstallation({
      appId: "app_other",
      tenantId: "tenant_1",
      id: "tenant_1_installation_a"
    });

    expect(own).toMatchObject({
      id: "tenant_1_installation_a",
      pluginKey: "tenant_1-plugin",
      egress: { mode: "deny", allowlistedHostCount: 0 }
    });
    expect(JSON.stringify(own)).not.toContain("secret-config");
    expect(JSON.stringify(own)).not.toContain("secret-grant");
    expect(JSON.stringify(own)).not.toContain("manifest-secret");
    expect(otherTenant).toBeNull();
    expect(wrongApp).toBeNull();
  });

  it("writes a manager command and its fixed-shape audit atomically at the D1 boundary", async () => {
    await seedDashboard();
    const commands = createD1AdminInstallationCommandStore(testEnv.DB, {
      auditId: () => "installation_command_audit"
    });

    await expect(
      commands.updateInstallation({
        appId: "app_1",
        tenantId: "tenant_1",
        actor: "manager-subject",
        id: "tenant_1_installation_a",
        enabled: false,
        priority: 4
      })
    ).resolves.toEqual({
      id: "tenant_1_installation_a",
      enabled: false,
      priority: 4,
      changed: true
    });

    const installation = await testEnv.DB.prepare(
      "SELECT enabled, priority FROM installations WHERE id = ?"
    )
      .bind("tenant_1_installation_a")
      .first<{ enabled: number; priority: number }>();
    const audit = await testEnv.DB.prepare(
      "SELECT hook_name, error, capability_calls_json FROM executions WHERE id = ?"
    )
      .bind("installation_command_audit")
      .first<{ hook_name: string; error: string; capability_calls_json: string }>();
    expect(installation).toEqual({ enabled: 0, priority: 4 });
    expect(audit?.hook_name).toBe("installation.command");
    expect(audit?.error).toBe(
      "actor=manager-subject old_enabled=true old_priority=10 new_enabled=false new_priority=4"
    );
    expect(audit?.capability_calls_json).toBe(
      '[{"name":"installations.command","status":"success"}]'
    );
    expect(JSON.stringify(audit)).not.toContain("secret-config");
    expect(JSON.stringify(audit)).not.toContain("secret-grant");
    expect(JSON.stringify(audit)).not.toContain("manifest-secret");
  });

  it("does not update an installation when the paired audit insert fails, and makes no-op commands audit-free", async () => {
    await seedDashboard();
    await testEnv.DB.prepare(
      "INSERT INTO executions (id, tenant_id, plugin_id, hook_name, version, status, duration_ms, capability_calls_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        "conflicting_audit",
        "tenant_1",
        "tenant_1_plugin",
        "existing",
        "1",
        "success",
        0,
        "[]",
        "2026-07-19T00:00:00.000Z"
      )
      .run();
    const commands = createD1AdminInstallationCommandStore(testEnv.DB, {
      auditId: () => "conflicting_audit"
    });
    await expect(
      commands.updateInstallation({
        appId: "app_1",
        tenantId: "tenant_1",
        actor: "manager-subject",
        id: "tenant_1_installation_a",
        enabled: false
      })
    ).rejects.toThrow();
    await expect(
      testEnv.DB.prepare("SELECT enabled, priority FROM installations WHERE id = ?")
        .bind("tenant_1_installation_a")
        .first<{ enabled: number; priority: number }>()
    ).resolves.toEqual({ enabled: 1, priority: 10 });

    const noOp = await commands.updateInstallation({
      appId: "app_1",
      tenantId: "tenant_1",
      actor: "manager-subject",
      id: "tenant_1_installation_a",
      enabled: true,
      priority: 10
    });
    expect(noOp).toEqual({
      id: "tenant_1_installation_a",
      enabled: true,
      priority: 10,
      changed: false
    });
    await expect(
      testEnv.DB.prepare("SELECT COUNT(*) AS count FROM executions WHERE hook_name = ?")
        .bind("installation.command")
        .first<{ count: number }>()
    ).resolves.toEqual({ count: 0 });
  });

  it("rejects cross-tenant, cross-app, and corrupt installation relations with the same null result", async () => {
    await seedDashboard();
    const commands = createD1AdminInstallationCommandStore(testEnv.DB);
    for (const id of ["tenant_2_installation_a", "cross_app_installation", "does_not_exist"]) {
      await expect(
        commands.updateInstallation({
          appId: "app_1",
          tenantId: "tenant_1",
          actor: "manager-subject",
          id,
          enabled: false
        })
      ).resolves.toBeNull();
    }
  });

  it("uses a revision CAS, appends a structured audit event, and leaves stale writes unaudited", async () => {
    await seedDashboard();
    const commands = createD1AdminInstallationCommandStore(testEnv.DB, {
      auditId: () => "admin_audit_command_1"
    });
    const updated = await commands.updateInstallation({
      appId: "app_1",
      tenantId: "tenant_1",
      actor: "manager\"subject",
      id: "tenant_1_installation_a",
      expectedRevision: 0,
      enabled: false
    });
    expect(updated).toMatchObject({ outcome: "updated", enabled: false, priority: 10, revision: 1 });
    await expect(
      testEnv.DB
        .prepare(
          "SELECT actor, action, before_json, after_json FROM admin_audit_events WHERE id = ?"
        )
        .bind("admin_audit_command_1")
        .first<{ actor: string; action: string; before_json: string; after_json: string }>()
    ).resolves.toEqual({
      actor: 'manager"subject',
      action: "installation.command",
      before_json: '{"enabled":true,"priority":10,"revision":0}',
      after_json: '{"enabled":false,"priority":10,"revision":1}'
    });
    await expect(
      commands.updateInstallation({
        appId: "app_1",
        tenantId: "tenant_1",
        actor: "manager-subject",
        id: "tenant_1_installation_a",
        expectedRevision: 0,
        priority: 4
      })
    ).resolves.toEqual({ outcome: "conflict", id: "tenant_1_installation_a", revision: 1 });
    await expect(
      testEnv.DB
        .prepare("SELECT COUNT(*) AS count FROM admin_audit_events")
        .first<{ count: number }>()
    ).resolves.toEqual({ count: 1 });
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
  // D1 cannot encode the cross-table same-app invariant, so seed an intentionally corrupt
  // relation to prove every Admin read keeps the other app's manifest behind the SQL boundary.
  await store.createInstallation({
    id: "cross_app_installation",
    tenantId: "tenant_1",
    pluginVersionId: "tenant_other_app_version_a",
    enabled: true,
    priority: 99,
    config: { value: "cross-app-secret" },
    grants: { permission: "cross-app-grant" }
  });
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
    configSchema: {
      properties: { hidden: { type: "string", default: "manifest-secret" } },
      required: []
    },
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
