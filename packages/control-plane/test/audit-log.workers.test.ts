import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1AuditLogStore } from "../src/index.js";

interface TestWorkersEnv {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestWorkersEnv;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await seedAuditScope();
});

describe("D1 immutable audit log", () => {
  it("appends a tenant/app hash chain and verifies its contents", async () => {
    const store = createD1AuditLogStore(testEnv.DB);

    await store.append({
      id: "audit_chain_1",
      tenantId: "tenant_audit",
      appId: "app_audit",
      category: "installation",
      action: "installation.created",
      actor: "operator-1",
      resourceType: "installation",
      resourceId: "installation_audit",
      payload: { enabled: true, version: "1.0.0" },
      createdAt: new Date("2026-07-20T00:00:00.000Z")
    });
    await store.append({
      id: "audit_chain_2",
      tenantId: "tenant_audit",
      appId: "app_audit",
      category: "grant",
      action: "grant.approved",
      actor: "admin-1",
      resourceType: "approval",
      resourceId: "approval_audit",
      payload: { capabilities: ["email.send"] },
      createdAt: new Date("2026-07-20T00:01:00.000Z")
    });

    const events = await store.list({ tenantId: "tenant_audit", appId: "app_audit" });
    expect(events.map(({ sequence, previousHash }) => ({ sequence, previousHash }))).toEqual([
      { sequence: 1, previousHash: "0".repeat(64) },
      { sequence: 2, previousHash: events[0]?.eventHash }
    ]);
    await expect(store.verify({ tenantId: "tenant_audit", appId: "app_audit" })).resolves.toEqual({
      valid: true,
      eventCount: 2,
      lastEventHash: events[1]?.eventHash
    });
  });

  it("detects a forged insert, a missing entry, and reordered evidence", async () => {
    const store = createD1AuditLogStore(testEnv.DB);
    await appendTestEvent(store, "audit_chain_1", "2026-07-20T00:00:00.000Z");
    await appendTestEvent(store, "audit_chain_2", "2026-07-20T00:01:00.000Z");
    const events = await store.list({ tenantId: "tenant_audit", appId: "app_audit" });
    const first = events[0];
    const second = events[1];
    if (first === undefined || second === undefined) throw new Error("expected two audit events");

    await expect(
      store.verifyEvents([{ ...first, action: "forged.action" }, second])
    ).resolves.toMatchObject({ valid: false, failure: "event_hash_mismatch", sequence: 1 });
    await expect(store.verifyEvents([second])).resolves.toMatchObject({
      valid: false,
      failure: "sequence_mismatch",
      sequence: 2
    });
    await expect(store.verifyEvents([second, first])).resolves.toMatchObject({
      valid: false,
      failure: "sequence_mismatch",
      sequence: 2
    });
  });

  it("rejects update and delete against every audit table at the D1 boundary", async () => {
    const store = createD1AuditLogStore(testEnv.DB);
    await appendTestEvent(store, "audit_chain_1", "2026-07-20T00:00:00.000Z");
    await seedLegacyAuditRows();

    for (const [table, id] of [
      ["audit_events", "audit_chain_1"],
      ["admin_audit_events", "admin_audit_1"],
      ["approval_audit_events", "approval_audit_1"],
      ["installation_request_audit_events", "request_audit_1"]
    ] as const) {
      await expect(
        testEnv.DB.prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`)
          .bind("2099-01-01T00:00:00.000Z", id)
          .run()
      ).rejects.toThrow(/immutable audit event/);
      await expect(
        testEnv.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run()
      ).rejects.toThrow(/immutable audit event/);
    }
  });
});

async function appendTestEvent(
  store: ReturnType<typeof createD1AuditLogStore>,
  id: string,
  createdAt: string
) {
  return store.append({
    id,
    tenantId: "tenant_audit",
    appId: "app_audit",
    category: "test",
    action: "test.appended",
    actor: "test-actor",
    resourceType: "test",
    resourceId: id,
    payload: { id },
    createdAt: new Date(createdAt)
  });
}

async function seedAuditScope() {
  await testEnv.DB.prepare("INSERT INTO apps (id, name) VALUES (?, ?)")
    .bind("app_audit", "Audit App")
    .run();
  await testEnv.DB.prepare("INSERT INTO tenants (id, app_id, name) VALUES (?, ?, ?)")
    .bind("tenant_audit", "app_audit", "Audit Tenant")
    .run();
  await testEnv.DB.prepare("INSERT INTO plugins (id, app_id, key) VALUES (?, ?, ?)")
    .bind("plugin_audit", "app_audit", "audit-plugin")
    .run();
  await testEnv.DB.prepare(
    "INSERT INTO plugin_versions (id, plugin_id, version, artifact_hash, manifest_json) VALUES (?, ?, ?, ?, ?)"
  )
    .bind("version_audit", "plugin_audit", "1.0.0", "hash", "{}")
    .run();
  await testEnv.DB.prepare(
    "INSERT INTO installations (id, tenant_id, plugin_version_id, config_json, grants_json) VALUES (?, ?, ?, ?, ?)"
  )
    .bind("installation_audit", "tenant_audit", "version_audit", "{}", "{}")
    .run();
}

async function seedLegacyAuditRows() {
  const createdAt = "2026-07-20T00:00:00.000Z";
  await testEnv.DB.prepare(
    `INSERT INTO admin_audit_events
      (id, installation_id, tenant_id, app_id, plugin_id, revision, actor, action,
       before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      "admin_audit_1",
      "installation_audit",
      "tenant_audit",
      "app_audit",
      "plugin_audit",
      0,
      "operator-1",
      "audit.test",
      "{}",
      "{}",
      createdAt
    )
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO approvals
      (id, tenant_id, plugin_id, role, subject_json, resume_hook, state, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      "approval_audit",
      "tenant_audit",
      "plugin_audit",
      "admin",
      "{}",
      "approval.resume",
      "pending",
      "2026-07-21T00:00:00.000Z",
      createdAt
    )
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO installation_grant_requests
      (approval_id, app_id, tenant_id, plugin_id, version_id, installation_id, requested_by,
       config_json, grants_json, capabilities_json, enabled, priority, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      "approval_audit",
      "app_audit",
      "tenant_audit",
      "plugin_audit",
      "version_audit",
      "requested_installation_audit",
      "operator-1",
      "{}",
      "{}",
      "[]",
      1,
      100,
      createdAt
    )
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO installation_request_audit_events
      (id, approval_id, app_id, tenant_id, plugin_id, version_id, actor, capabilities_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      "request_audit_1",
      "approval_audit",
      "app_audit",
      "tenant_audit",
      "plugin_audit",
      "version_audit",
      "operator-1",
      "[]",
      createdAt
    )
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO approval_audit_events
      (id, approval_id, tenant_id, app_id, plugin_id, actor, actor_role, decision, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      "approval_audit_1",
      "approval_audit",
      "tenant_audit",
      "app_audit",
      "plugin_audit",
      "admin-1",
      "admin",
      "approved",
      "approved for test",
      createdAt
    )
    .run();
}
