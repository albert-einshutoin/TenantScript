import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

type D1Migrations = Parameters<typeof applyD1Migrations>[1];

interface UpgradeTestEnv {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  PROBE_DO: DurableObjectNamespace;
  BASELINE_MIGRATIONS: D1Migrations;
  TEST_MIGRATIONS: D1Migrations;
}

const testEnv = env as unknown as UpgradeTestEnv;
const baselineName = "0001_pre_v1_0010.sql";
const latestSuffixNames = [
  "0011_immutable_audit_log.sql",
  "0012_execution_archives.sql",
  "0013_runaway_quarantine.sql",
  "0014_usage_daily_summaries.sql"
];

beforeEach(async () => {
  await reset();
});

describe("pre-v1 control-plane upgrade", () => {
  it("preserves D1, R2, and Durable Object data while enabling the latest schema", async () => {
    await applyBaseline();
    await seedBaselineData();
    await testEnv.ARTIFACTS.put("artifacts/hash_pre_v1", "synthetic-plugin-bundle");
    const durableObject = testEnv.PROBE_DO.get(testEnv.PROBE_DO.idFromName("upgrade-probe"));
    await expect((await durableObject.fetch("https://example.com")).text()).resolves.toBe("1");
    const before = await readBaselineSnapshot();

    const latestSuffix = currentMigrationSuffix();
    await applyD1Migrations(testEnv.DB, latestSuffix);
    // Wrangler-style migration history makes retry after a lost response safe. Replaying the same
    // suffix must skip applied names rather than rerun ALTER/CREATE statements against user data.
    await applyD1Migrations(testEnv.DB, latestSuffix);

    await expect(readBaselineSnapshot()).resolves.toEqual(before);
    await expect(readMigrationNames()).resolves.toEqual([baselineName, ...latestSuffixNames]);
    await expect(testEnv.ARTIFACTS.get("artifacts/hash_pre_v1").then(readObjectText)).resolves.toBe(
      "synthetic-plugin-bundle"
    );
    await expect((await durableObject.fetch("https://example.com")).text()).resolves.toBe("2");

    await exerciseLatestSchema();
  });

  it("rolls back a failing migration transaction without changing existing rows", async () => {
    await applyBaseline();
    await seedBaselineData();

    await expect(
      applyD1Migrations(testEnv.DB, [
        {
          name: "9999_synthetic_failure.sql",
          queries: [
            "UPDATE apps SET name = 'must-roll-back' WHERE id = 'app_pre_v1'",
            "INSERT INTO table_that_does_not_exist (id) VALUES ('failure')"
          ]
        }
      ])
    ).rejects.toThrow();

    await expect(
      testEnv.DB.prepare("SELECT name FROM apps WHERE id = ?1").bind("app_pre_v1").first("name")
    ).resolves.toBe("Synthetic SaaS");
    await expect(readMigrationNames()).resolves.toEqual([baselineName]);
  });
});

async function applyBaseline(): Promise<void> {
  expect(testEnv.BASELINE_MIGRATIONS.map(({ name }) => name)).toEqual([baselineName]);
  await applyD1Migrations(testEnv.DB, testEnv.BASELINE_MIGRATIONS);
}

function currentMigrationSuffix(): D1Migrations {
  const suffix = testEnv.TEST_MIGRATIONS.filter(({ name }) => Number(name.slice(0, 4)) > 10);
  expect(suffix.map(({ name }) => name)).toEqual(latestSuffixNames);
  return suffix;
}

async function seedBaselineData(): Promise<void> {
  const manifest = JSON.stringify({
    name: "synthetic-plugin",
    version: "0.0.0",
    hooks: [
      {
        name: "invoice.created",
        type: "event",
        timeoutMs: 250,
        schemaVersionRange: "^1.0.0"
      }
    ],
    capabilities: {},
    configSchema: { properties: {}, required: [] },
    egress: { mode: "deny" },
    limits: { cpuMs: 50, timeoutMs: 500 }
  });
  const createdAt = "2026-07-01T00:00:00.000Z";
  await testEnv.DB.batch([
    testEnv.DB.prepare("INSERT INTO apps (id, name, created_at) VALUES (?1, ?2, ?3)").bind(
      "app_pre_v1",
      "Synthetic SaaS",
      createdAt
    ),
    testEnv.DB.prepare(
      "INSERT INTO tenants (id, app_id, name, created_at) VALUES (?1, ?2, ?3, ?4)"
    ).bind("tenant_pre_v1", "app_pre_v1", "Synthetic Tenant", createdAt),
    testEnv.DB.prepare(
      "INSERT INTO plugins (id, app_id, key, created_at) VALUES (?1, ?2, ?3, ?4)"
    ).bind("plugin_pre_v1", "app_pre_v1", "synthetic-plugin", createdAt),
    testEnv.DB.prepare(
      [
        "INSERT INTO plugin_versions",
        "(id, plugin_id, version, artifact_hash, manifest_json, created_at)",
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
      ].join(" ")
    ).bind("version_pre_v1", "plugin_pre_v1", "0.0.0", "hash_pre_v1", manifest, createdAt),
    testEnv.DB.prepare(
      [
        "INSERT INTO installations",
        "(id, tenant_id, plugin_version_id, enabled, priority, config_json, grants_json, created_at, revision)",
        "VALUES (?1, ?2, ?3, 1, 42, ?4, ?5, ?6, 7)"
      ].join(" ")
    ).bind(
      "installation_pre_v1",
      "tenant_pre_v1",
      "version_pre_v1",
      '{"mode":"synthetic"}',
      '{"slack.send":{"channel":"C_SYNTHETIC"}}',
      createdAt
    ),
    testEnv.DB.prepare(
      [
        "INSERT INTO approvals",
        "(id, tenant_id, plugin_id, role, subject_json, resume_hook, state, expires_at, created_at)",
        "VALUES (?1, ?2, ?3, 'admin', ?4, 'invoice.created', 'pending', ?5, ?6)"
      ].join(" ")
    ).bind(
      "approval_pre_v1",
      "tenant_pre_v1",
      "plugin_pre_v1",
      '{"kind":"synthetic"}',
      "2027-07-01T00:00:00.000Z",
      createdAt
    ),
    testEnv.DB.prepare(
      [
        "INSERT INTO executions",
        "(id, tenant_id, plugin_id, hook_name, version, status, duration_ms, error, capability_calls_json, created_at)",
        "VALUES (?1, ?2, ?3, 'invoice.created', '0.0.0', 'success', 12, NULL, '[]', ?4)"
      ].join(" ")
    ).bind("execution_pre_v1", "tenant_pre_v1", "plugin_pre_v1", createdAt),
    testEnv.DB.prepare(
      [
        "INSERT INTO admin_audit_events",
        "(id, installation_id, tenant_id, app_id, plugin_id, revision, actor, action, before_json, after_json, created_at)",
        "VALUES (?1, ?2, ?3, ?4, ?5, 7, 'synthetic-operator', 'baseline.snapshot', '{}', '{}', ?6)"
      ].join(" ")
    ).bind(
      "admin_audit_pre_v1",
      "installation_pre_v1",
      "tenant_pre_v1",
      "app_pre_v1",
      "plugin_pre_v1",
      createdAt
    )
  ]);
}

async function readBaselineSnapshot(): Promise<Record<string, unknown>> {
  const row = await testEnv.DB.prepare(
    [
      "SELECT a.name AS app_name, t.name AS tenant_name, p.key AS plugin_key,",
      "pv.version, pv.artifact_hash, pv.manifest_json, i.enabled, i.priority,",
      "i.config_json, i.grants_json, i.revision, ap.state AS approval_state,",
      "e.status AS execution_status, aa.actor AS audit_actor",
      "FROM apps a",
      "JOIN tenants t ON t.app_id = a.id",
      "JOIN plugins p ON p.app_id = a.id",
      "JOIN plugin_versions pv ON pv.plugin_id = p.id",
      "JOIN installations i ON i.tenant_id = t.id AND i.plugin_version_id = pv.id",
      "JOIN approvals ap ON ap.tenant_id = t.id AND ap.plugin_id = p.id",
      "JOIN executions e ON e.tenant_id = t.id AND e.plugin_id = p.id",
      "JOIN admin_audit_events aa ON aa.installation_id = i.id",
      "WHERE a.id = ?1"
    ].join(" ")
  )
    .bind("app_pre_v1")
    .first();
  if (row === null) {
    throw new Error("synthetic baseline data is unavailable");
  }
  return row;
}

async function readMigrationNames(): Promise<string[]> {
  const result = await testEnv.DB.prepare("SELECT name FROM d1_migrations ORDER BY id ASC").all<{
    name: string;
  }>();
  return result.results.map(({ name }) => name);
}

async function readObjectText(object: R2ObjectBody | null): Promise<string | null> {
  return object === null ? null : object.text();
}

async function exerciseLatestSchema(): Promise<void> {
  const zeroHash = "0".repeat(64);
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      "INSERT INTO audit_chain_heads (tenant_id, app_id, next_sequence, last_event_hash) VALUES (?1, ?2, 1, ?3)"
    ).bind("tenant_pre_v1", "app_pre_v1", zeroHash),
    testEnv.DB.prepare(
      [
        "INSERT INTO audit_events",
        "(id, tenant_id, app_id, sequence, category, action, actor, resource_type, resource_id, payload_json, previous_hash, event_hash, created_at)",
        "VALUES (?1, ?2, ?3, 1, 'upgrade', 'verified', 'synthetic-operator', 'app', ?3, '{}', ?4, ?5, ?6)"
      ].join(" ")
    ).bind(
      "audit_latest",
      "tenant_pre_v1",
      "app_pre_v1",
      zeroHash,
      "1".repeat(64),
      "2026-07-20T00:00:00.000Z"
    ),
    testEnv.DB.prepare(
      [
        "INSERT INTO execution_archives",
        "(id, tenant_id, app_id, object_key, from_at, to_at, event_count, content_hash, created_at)",
        "VALUES (?1, ?2, ?3, ?4, ?5, ?5, 1, ?6, ?5)"
      ].join(" ")
    ).bind(
      "archive_latest",
      "tenant_pre_v1",
      "app_pre_v1",
      "execution-archives/tenant_pre_v1/synthetic.ndjson",
      "2026-07-20T00:00:00.000Z",
      "2".repeat(64)
    ),
    testEnv.DB.prepare(
      [
        "INSERT INTO installation_runaway_states",
        "(installation_id, consecutive_failures, consecutive_timeouts, quarantined, quarantine_reason, updated_at)",
        "VALUES (?1, 2, 0, 0, NULL, ?2)"
      ].join(" ")
    ).bind("installation_pre_v1", "2026-07-20T00:00:00.000Z")
  ]);
  await testEnv.DB.prepare(
    [
      "UPDATE installation_runaway_states",
      "SET consecutive_failures = 3, quarantined = 1, quarantine_reason = 'consecutive_failures'",
      "WHERE installation_id = ?1"
    ].join(" ")
  )
    .bind("installation_pre_v1")
    .run();

  await expect(
    testEnv.DB.prepare("SELECT enabled, revision FROM installations WHERE id = ?1")
      .bind("installation_pre_v1")
      .first()
  ).resolves.toEqual({ enabled: 0, revision: 8 });
}
