import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createD1AdminApprovalDecisionStore,
  createD1AdminInstallRequestStore,
  createD1ControlPlaneStore
} from "../src/index.js";

const testEnv = env as unknown as {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  const store = createD1ControlPlaneStore(testEnv.DB);
  await store.createApp({ id: "app_1", name: "App 1" });
  await store.createTenant({ id: "tenant_1", appId: "app_1", name: "Tenant 1" });
  await store.createPlugin({ id: "plugin_1", appId: "app_1", key: "invoice-notify" });
  await store.createPluginVersion({
    id: "version_1",
    pluginId: "plugin_1",
    version: "1.0.0",
    artifactHash: "hash_1",
    manifest: {
      name: "invoice-notify",
      version: "1.0.0",
      hooks: [
        { name: "invoice.created", type: "event", timeoutMs: 250, schemaVersionRange: "^1.0.0" }
      ],
      capabilities: { "slack.send": { channel: "$config.notifyChannel" } },
      configSchema: {
        properties: { notifyChannel: { type: "string" } },
        required: ["notifyChannel"]
      },
      egress: { mode: "deny" },
      limits: { cpuMs: 50, timeoutMs: 500 }
    }
  });
});

describe("D1 installation grant requests", () => {
  it("keeps operator proposals pending until an admin atomically installs approved grants", async () => {
    const requests = createD1AdminInstallRequestStore(testEnv.DB, {
      approvalId: () => "approval_install_1",
      installationId: () => "installation_approved_1",
      auditId: () => "request_audit_1",
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    await expect(requests.requestInstallation(validRequest())).resolves.toEqual({
      approvalId: "approval_install_1",
      state: "pending",
      pluginKey: "invoice-notify",
      version: "1.0.0",
      capabilities: ["slack.send"],
      expiresAt: "2026-07-21T00:00:00.000Z"
    });
    await expect(
      testEnv.DB.prepare("SELECT role, resume_hook, state FROM approvals WHERE id = ?")
        .bind("approval_install_1")
        .first()
    ).resolves.toEqual({ role: "admin", resume_hook: "installation.request", state: "pending" });
    await expect(
      testEnv.DB.prepare("SELECT COUNT(*) AS count FROM installations").first()
    ).resolves.toEqual({ count: 0 });

    const decisions = createD1AdminApprovalDecisionStore(testEnv.DB, {
      auditId: () => "approval_audit_1",
      installationAuditId: () => "installation_audit_1",
      now: () => new Date("2026-07-20T01:00:00.000Z")
    });
    await expect(
      decisions.decide({
        appId: "app_1",
        tenantId: "tenant_1",
        actor: "admin-subject",
        actorRole: "admin",
        approvalId: "approval_install_1",
        decision: "approved"
      })
    ).resolves.toMatchObject({
      state: "approved",
      installation: {
        id: "installation_approved_1",
        versionId: "version_1",
        enabled: false,
        priority: 20
      }
    });
    await expect(
      testEnv.DB.prepare(
        "SELECT tenant_id, plugin_version_id, enabled, priority, config_json, grants_json FROM installations WHERE id = ?"
      )
        .bind("installation_approved_1")
        .first()
    ).resolves.toEqual({
      tenant_id: "tenant_1",
      plugin_version_id: "version_1",
      enabled: 0,
      priority: 20,
      config_json: JSON.stringify({ notifyChannel: "C123" }),
      grants_json: JSON.stringify({ "slack.send": { channel: "C123" } })
    });
    await expect(
      testEnv.DB.prepare("SELECT COUNT(*) AS count FROM admin_audit_events").first()
    ).resolves.toEqual({ count: 1 });
  });

  it("rejection finalizes the approval without creating an installation", async () => {
    const requests = createD1AdminInstallRequestStore(testEnv.DB, {
      approvalId: () => "approval_rejected",
      installationId: () => "installation_must_not_exist",
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });
    await requests.requestInstallation(validRequest());
    const decisions = createD1AdminApprovalDecisionStore(testEnv.DB, {
      now: () => new Date("2026-07-20T01:00:00.000Z")
    });

    await expect(
      decisions.decide({
        appId: "app_1",
        tenantId: "tenant_1",
        actor: "admin-subject",
        actorRole: "admin",
        approvalId: "approval_rejected",
        decision: "rejected"
      })
    ).resolves.toMatchObject({ state: "rejected" });
    await expect(
      testEnv.DB.prepare("SELECT COUNT(*) AS count FROM installations").first()
    ).resolves.toEqual({ count: 0 });
  });

  it("replays the same tenant request once and rejects an idempotency key with changed grants", async () => {
    const requests = createD1AdminInstallRequestStore(testEnv.DB, {
      approvalId: () => "approval_idempotent",
      installationId: () => "installation_idempotent",
      auditId: () => "request_audit_idempotent",
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });
    const request = validRequest();

    const first = await requests.requestInstallation(request);
    await expect(requests.requestInstallation(request)).resolves.toEqual(first);
    await expect(
      requests.requestInstallation({ ...request, priority: request.priority + 1 })
    ).rejects.toMatchObject({ code: "idempotency_key_reused" });
    await expect(
      testEnv.DB.prepare("SELECT COUNT(*) AS count FROM approvals").first()
    ).resolves.toEqual({ count: 1 });
    await expect(
      testEnv.DB.prepare("SELECT COUNT(*) AS count FROM installation_request_audit_events").first()
    ).resolves.toEqual({ count: 1 });
  });
});

function validRequest() {
  return {
    appId: "app_1",
    tenantId: "tenant_1",
    actor: "operator-subject",
    idempotencyKey: "install-request-worker-key-0001",
    versionId: "version_1",
    config: { notifyChannel: "C123" },
    confirmedCapabilities: ["slack.send"],
    enabled: false,
    priority: 20
  };
}
