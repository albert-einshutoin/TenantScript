import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createD1ControlPlaneStore,
  createD1R2ExecutionArchiveStore,
  type ExecutionRecord
} from "../src/index.js";

interface TestWorkersEnv {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestWorkersEnv;
const scope = { appId: "app_archive", tenantId: "tenant_archive" };

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  const store = createD1ControlPlaneStore(testEnv.DB);
  await store.createApp({ id: scope.appId, name: "Archive App" });
  await store.createTenant({ id: scope.tenantId, appId: scope.appId, name: "Archive Tenant" });
  await store.createPlugin({ id: "plugin_archive", appId: scope.appId, key: "archive-plugin" });
});

describe("D1 and R2 execution archive", () => {
  it("moves expired rows to R2 and transparently searches hot and archived evidence", async () => {
    const controlPlane = createD1ControlPlaneStore(testEnv.DB);
    await controlPlane.writeExecution(execution("exec_old_1", "2026-05-01T00:00:00.000Z"));
    await controlPlane.writeExecution(execution("exec_old_2", "2026-06-01T00:00:00.000Z"));
    await controlPlane.writeExecution(execution("exec_hot", "2026-07-10T00:00:00.000Z"));
    const archive = createD1R2ExecutionArchiveStore(testEnv.DB, testEnv.ARTIFACTS, {
      hotRetentionDays: 30,
      archiveId: () => "archive_1"
    });

    await expect(
      archive.archiveExpired({ ...scope, now: new Date("2026-07-20T00:00:00.000Z") })
    ).resolves.toMatchObject({
      id: "archive_1",
      eventCount: 2,
      from: new Date("2026-05-01T00:00:00.000Z"),
      to: new Date("2026-06-01T00:00:00.000Z")
    });

    const hotCount = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM executions").first<{
      count: number;
    }>();
    expect(hotCount?.count).toBe(1);
    const manifest = await testEnv.DB.prepare(
      "SELECT object_key, event_count, content_hash FROM execution_archives WHERE id = ?"
    )
      .bind("archive_1")
      .first<{ object_key: string; event_count: number; content_hash: string }>();
    expect(manifest).toMatchObject({ event_count: 2 });
    expect(manifest?.content_hash).toMatch(/^[a-f0-9]{64}$/);
    await expect(testEnv.ARTIFACTS.head(manifest?.object_key ?? "missing")).resolves.not.toBeNull();
    await expect(
      testEnv.DB.prepare("UPDATE execution_archives SET event_count = 1 WHERE id = ?")
        .bind("archive_1")
        .run()
    ).rejects.toThrow(/immutable execution archive/);
    await expect(
      testEnv.DB.prepare("DELETE FROM execution_archives WHERE id = ?").bind("archive_1").run()
    ).rejects.toThrow(/immutable execution archive/);

    await expect(archive.search(scope)).resolves.toEqual([
      execution("exec_old_1", "2026-05-01T00:00:00.000Z"),
      execution("exec_old_2", "2026-06-01T00:00:00.000Z"),
      execution("exec_hot", "2026-07-10T00:00:00.000Z")
    ]);
    await expect(
      archive.search({
        ...scope,
        from: new Date("2026-05-15T00:00:00.000Z"),
        to: new Date("2026-06-15T00:00:00.000Z")
      })
    ).resolves.toEqual([execution("exec_old_2", "2026-06-01T00:00:00.000Z")]);
  });

  it("keeps other tenants and non-expired rows in D1 and returns null for an empty batch", async () => {
    const controlPlane = createD1ControlPlaneStore(testEnv.DB);
    await controlPlane.createTenant({ id: "tenant_other", appId: scope.appId, name: "Other" });
    await controlPlane.writeExecution(execution("exec_hot", "2026-07-19T00:00:00.000Z"));
    await controlPlane.writeExecution({
      ...execution("exec_other", "2026-05-01T00:00:00.000Z"),
      tenantId: "tenant_other"
    });
    const archive = createD1R2ExecutionArchiveStore(testEnv.DB, testEnv.ARTIFACTS, {
      hotRetentionDays: 30,
      archiveId: () => "archive_empty"
    });

    await expect(
      archive.archiveExpired({ ...scope, now: new Date("2026-07-20T00:00:00.000Z") })
    ).resolves.toBeNull();
    const ids = await testEnv.DB.prepare("SELECT id FROM executions ORDER BY id").all();
    expect(ids.results).toEqual([{ id: "exec_hot" }, { id: "exec_other" }]);
  });

  it("keeps every hot row when the manifest and delete batch cannot commit", async () => {
    const controlPlane = createD1ControlPlaneStore(testEnv.DB);
    await controlPlane.writeExecution(execution("exec_old", "2026-05-01T00:00:00.000Z"));
    await testEnv.DB.prepare(
      "CREATE TRIGGER fail_execution_archive BEFORE INSERT ON execution_archives BEGIN SELECT RAISE(ABORT, 'manifest unavailable'); END"
    ).run();
    const archive = createD1R2ExecutionArchiveStore(testEnv.DB, testEnv.ARTIFACTS, {
      hotRetentionDays: 30,
      archiveId: () => "archive_failed"
    });

    await expect(
      archive.archiveExpired({ ...scope, now: new Date("2026-07-20T00:00:00.000Z") })
    ).rejects.toThrow(/manifest unavailable/);
    await expect(
      testEnv.DB.prepare("SELECT COUNT(*) AS count FROM executions WHERE id = ?")
        .bind("exec_old")
        .first<{ count: number }>()
    ).resolves.toEqual({ count: 1 });
    await expect(
      testEnv.DB.prepare("SELECT COUNT(*) AS count FROM execution_archives").first<{
        count: number;
      }>()
    ).resolves.toEqual({ count: 0 });
  });
});

function execution(id: string, createdAt: string): ExecutionRecord {
  return {
    id,
    tenantId: scope.tenantId,
    pluginId: "plugin_archive",
    hookName: "invoice.created",
    version: "1.0.0",
    status: "success",
    durationMs: 12,
    capabilityCalls: [{ name: "invoice.read", status: "success" }],
    createdAt: new Date(createdAt)
  };
}
