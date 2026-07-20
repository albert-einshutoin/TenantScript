import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CloudflareD1MigrationSetupAdapterError,
  D1MigrationRunnerError,
  createCloudflareD1MigrationSetupAdapter,
  createProductionSetupPlan,
  createSetupProviderRouter,
  deriveSetupOperationIdempotencyKey,
  loadControlPlaneMigrationCatalog,
  type ControlPlaneMigrationCatalog,
  type D1MigrationRunner,
  type SetupOperation
} from "../src/index.js";

const databaseId = "123e4567-e89b-12d3-a456-426614174000";
const runId = "setup-run-195";
const migrationOperation = operation("apply:control-plane-migrations");
const unsupportedOperation = operation("create:artifact-r2");
const migrationDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../control-plane/migrations"
);
const expectedNames = [
  "0001_initial.sql",
  "0002_installation_command_audit.sql",
  "0003_installation_rollback_audit.sql",
  "0004_approval_decision_audit.sql",
  "0005_install_idempotency.sql",
  "0006_rollback_idempotency.sql",
  "0007_service_tokens.sql",
  "0008_rbac_approval_trigger.sql",
  "0009_installation_grant_requests.sql",
  "0010_admin_approval_threshold.sql",
  "0011_immutable_audit_log.sql",
  "0012_execution_archives.sql",
  "0013_runaway_quarantine.sql"
] as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("control plane migration catalog", () => {
  it("loads the canonical sequential migration catalog with pinned integrity", async () => {
    const catalog = await loadControlPlaneMigrationCatalog({ directory: migrationDirectory });

    expect(catalog.migrations.map((migration) => migration.name)).toEqual(expectedNames);
    expect(catalog.migrations).toHaveLength(13);
    for (const migration of catalog.migrations) {
      expect(migration.byteLength).toBeGreaterThan(0);
      expect(migration.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(JSON.stringify(migration)).not.toContain(migrationDirectory);
    }
  });

  it.each(["missing", "extra", "renamed", "digest", "empty", "oversized", "symlink"])(
    "rejects %s catalog drift without reflecting SQL or machine paths",
    async (scenario) => {
      const directory = await copyMigrationDirectory();
      const secret = "migration-secret-sentinel";
      if (scenario === "missing") await rm(join(directory, expectedNames[0]));
      if (scenario === "extra") await writeFile(join(directory, "0014_extra.sql"), "SELECT 1;");
      if (scenario === "renamed") {
        await cp(join(directory, expectedNames[0]), join(directory, "0001_renamed.sql"));
        await rm(join(directory, expectedNames[0]));
      }
      if (scenario === "digest") {
        await writeFile(join(directory, expectedNames[0]), `SELECT '${secret}';`);
      }
      if (scenario === "empty") await writeFile(join(directory, expectedNames[0]), "");
      if (scenario === "oversized") {
        await writeFile(join(directory, expectedNames[0]), Buffer.alloc(65_537, 65));
      }
      if (scenario === "symlink") {
        const target = join(directory, expectedNames[0]);
        const contents = await readFile(target);
        await rm(target);
        const outsideDirectory = await mkdtemp(join(tmpdir(), "tenantscript-migration-target-"));
        temporaryDirectories.push(outsideDirectory);
        const outside = join(outsideDirectory, "outside.sql");
        await writeFile(outside, contents);
        await symlink(outside, target);
      }

      const error = await captureAdapterError(loadControlPlaneMigrationCatalog({ directory }));
      expect(error.code).toBe("cloudflare_d1_migration_invalid_catalog");
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(directory);
    }
  );

  it("rejects a symlinked migration directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenantscript-migration-link-"));
    temporaryDirectories.push(directory);
    const linkedDirectory = join(directory, "migrations");
    await symlink(migrationDirectory, linkedDirectory, "dir");

    const error = await captureAdapterError(
      loadControlPlaneMigrationCatalog({ directory: linkedDirectory })
    );
    expect(error.code).toBe("cloudflare_d1_migration_invalid_catalog");
  });

  it("rejects traversal segments even when they resolve to the canonical directory", async () => {
    const traversingPath = `${migrationDirectory}/../migrations`;

    const error = await captureAdapterError(
      loadControlPlaneMigrationCatalog({ directory: traversingPath })
    );
    expect(error.code).toBe("cloudflare_d1_migration_invalid_catalog");
    expect(JSON.stringify(error)).not.toContain(traversingPath);
  });
});

describe("Cloudflare D1 migration setup adapter", () => {
  it("applies the full canonical catalog in order and verifies the final history", async () => {
    const catalog = await canonicalCatalog();
    const harness = migrationRunner([]);
    const adapter = createCloudflareD1MigrationSetupAdapter({
      databaseId,
      catalog,
      runner: harness.runner
    });

    await expect(adapter.reconcile(reconcileRequest(migrationOperation))).resolves.toEqual({
      disposition: "applied"
    });
    expect(harness.appliedBatches).toEqual([expectedNames]);
    expect(harness.listCalls).toBe(2);
  });

  it("applies only the remaining suffix after a persisted prefix", async () => {
    const catalog = await canonicalCatalog();
    const harness = migrationRunner(expectedNames.slice(0, 8));
    const adapter = createCloudflareD1MigrationSetupAdapter({
      databaseId,
      catalog,
      runner: harness.runner
    });

    await adapter.reconcile(reconcileRequest(migrationOperation));

    expect(harness.appliedBatches).toEqual([expectedNames.slice(8)]);
  });

  it("does not mutate when the full catalog is already applied", async () => {
    const catalog = await canonicalCatalog();
    const harness = migrationRunner(expectedNames);
    const adapter = createCloudflareD1MigrationSetupAdapter({
      databaseId,
      catalog,
      runner: harness.runner
    });

    await expect(adapter.reconcile(reconcileRequest(migrationOperation))).resolves.toEqual({
      disposition: "applied"
    });
    expect(harness.appliedBatches).toEqual([]);
    expect(harness.listCalls).toBe(1);
  });

  it("resumes after a lost apply response without replaying applied migrations", async () => {
    const catalog = await canonicalCatalog();
    const runnerError = new D1MigrationRunnerError();
    const first = migrationRunner(expectedNames.slice(0, 10), { failAfterApply: runnerError });
    const adapter = createCloudflareD1MigrationSetupAdapter({
      databaseId,
      catalog,
      runner: first.runner
    });

    await expect(adapter.reconcile(reconcileRequest(migrationOperation))).rejects.toBe(runnerError);
    expect(runnerError.toJSON()).toEqual({ code: "d1_migration_runner_failed" });
    expect(first.appliedBatches).toEqual([expectedNames.slice(10)]);

    const resumed = migrationRunner(first.appliedNames);
    const resumedAdapter = createCloudflareD1MigrationSetupAdapter({
      databaseId,
      catalog,
      runner: resumed.runner
    });
    await resumedAdapter.reconcile(reconcileRequest(migrationOperation));
    expect(resumed.appliedBatches).toEqual([]);
  });

  it.each([
    ["unknown", ["0000_unknown.sql"]],
    ["duplicate", [expectedNames[0], expectedNames[0]]],
    ["reverse", [expectedNames[1], expectedNames[0]]],
    ["gap", [expectedNames[0], expectedNames[2]]]
  ])("fails closed for %s remote migration history", async (_scenario, applied) => {
    const catalog = await canonicalCatalog();
    const harness = migrationRunner(applied);
    const adapter = createCloudflareD1MigrationSetupAdapter({
      databaseId,
      catalog,
      runner: harness.runner
    });

    const error = await captureAdapterError(
      adapter.reconcile(reconcileRequest(migrationOperation))
    );
    expect(error.code).toBe("cloudflare_d1_migration_invalid_remote_state");
    expect(harness.appliedBatches).toEqual([]);
  });

  it("fails when the post-apply history is not the complete catalog", async () => {
    const catalog = await canonicalCatalog();
    const harness = migrationRunner([], { keepHistoryIncomplete: true });
    const adapter = createCloudflareD1MigrationSetupAdapter({
      databaseId,
      catalog,
      runner: harness.runner
    });

    const error = await captureAdapterError(
      adapter.reconcile(reconcileRequest(migrationOperation))
    );
    expect(error.code).toBe("cloudflare_d1_migration_invalid_response");
    expect(harness.appliedBatches).toEqual([expectedNames]);
  });

  it("sanitizes unknown runner failures but preserves stable runner errors", async () => {
    const catalog = await canonicalCatalog();
    const secret = "runner-secret-sentinel";
    const unknown = migrationRunner([], { listError: new Error(secret) });
    const adapter = createCloudflareD1MigrationSetupAdapter({
      databaseId,
      catalog,
      runner: unknown.runner
    });

    const error = await captureAdapterError(
      adapter.reconcile(reconcileRequest(migrationOperation))
    );
    expect(error.code).toBe("cloudflare_d1_migration_runner_failed");
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("rejects request drift and cleanup before runner mutation", async () => {
    const catalog = await canonicalCatalog();
    const harness = migrationRunner([]);
    const adapter = createCloudflareD1MigrationSetupAdapter({
      databaseId,
      catalog,
      runner: harness.runner
    });

    await expect(
      adapter.reconcile({
        ...reconcileRequest(unsupportedOperation),
        idempotencyKey: key(unsupportedOperation, "reconcile")
      })
    ).rejects.toMatchObject({ code: "cloudflare_d1_migration_unsupported_operation" });
    await expect(
      adapter.reconcile({
        ...reconcileRequest(migrationOperation),
        idempotencyKey: `tssetup-${"0".repeat(64)}`
      })
    ).rejects.toMatchObject({ code: "cloudflare_d1_migration_invalid_request" });
    await expect(
      adapter.cleanupCreated({
        runId,
        idempotencyKey: key(migrationOperation, "cleanup"),
        operation: migrationOperation,
        resourceRef: `d1:${databaseId}`
      })
    ).rejects.toMatchObject({ code: "cloudflare_d1_migration_invalid_request" });
    expect(harness.listCalls).toBe(0);
    expect(harness.appliedBatches).toEqual([]);
  });

  it("rejects invalid database, catalog, or runner configuration", async () => {
    const catalog = await canonicalCatalog();
    const runner = migrationRunner([]).runner;

    expect(() =>
      createCloudflareD1MigrationSetupAdapter({ databaseId: "../../unsafe", catalog, runner })
    ).toThrow(expect.objectContaining({ code: "cloudflare_d1_migration_invalid_configuration" }));
    expect(() =>
      createCloudflareD1MigrationSetupAdapter({
        databaseId,
        catalog: { migrations: catalog.migrations.slice(1) },
        runner
      })
    ).toThrow(expect.objectContaining({ code: "cloudflare_d1_migration_invalid_configuration" }));
    expect(() =>
      createCloudflareD1MigrationSetupAdapter({
        databaseId,
        catalog: { migrations: new Array(13) as ControlPlaneMigrationCatalog["migrations"] },
        runner
      })
    ).toThrow(expect.objectContaining({ code: "cloudflare_d1_migration_invalid_configuration" }));
    expect(() =>
      createCloudflareD1MigrationSetupAdapter({ databaseId, catalog, runner: {} as never })
    ).toThrow(expect.objectContaining({ code: "cloudflare_d1_migration_invalid_configuration" }));
  });

  it("composes through the exact-ID provider router", async () => {
    const catalog = await canonicalCatalog();
    const harness = migrationRunner(expectedNames);
    const migrationAdapter = createCloudflareD1MigrationSetupAdapter({
      databaseId,
      catalog,
      runner: harness.runner
    });
    const router = createSetupProviderRouter({
      routes: [{ operationIds: [migrationOperation.id], adapter: migrationAdapter }]
    });

    await expect(router.reconcile(reconcileRequest(migrationOperation))).resolves.toEqual({
      disposition: "applied"
    });
    await expect(router.reconcile(reconcileRequest(unsupportedOperation))).rejects.toMatchObject({
      code: "setup_provider_route_not_found"
    });
  });
});

function migrationRunner(
  initiallyApplied: readonly string[],
  options: {
    failAfterApply?: Error;
    keepHistoryIncomplete?: boolean;
    listError?: Error;
  } = {}
): {
  runner: D1MigrationRunner;
  appliedBatches: string[][];
  readonly appliedNames: string[];
  readonly listCalls: number;
} {
  const appliedNames = [...initiallyApplied];
  const appliedBatches: string[][] = [];
  let listCalls = 0;
  return {
    runner: {
      listApplied: () => {
        listCalls += 1;
        if (options.listError !== undefined) throw options.listError;
        return Promise.resolve([...appliedNames]);
      },
      applyPending: (_databaseId, migrationNames) => {
        appliedBatches.push([...migrationNames]);
        if (!options.keepHistoryIncomplete) appliedNames.push(...migrationNames);
        if (options.failAfterApply !== undefined) throw options.failAfterApply;
        return Promise.resolve();
      }
    },
    appliedBatches,
    appliedNames,
    get listCalls() {
      return listCalls;
    }
  };
}

async function canonicalCatalog(): Promise<ControlPlaneMigrationCatalog> {
  return loadControlPlaneMigrationCatalog({ directory: migrationDirectory });
}

async function copyMigrationDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tenantscript-migrations-"));
  temporaryDirectories.push(directory);
  await cp(migrationDirectory, directory, { recursive: true });
  return directory;
}

function reconcileRequest(operationValue: SetupOperation) {
  return { runId, idempotencyKey: key(operationValue, "reconcile"), operation: operationValue };
}

function key(operationValue: SetupOperation, action: "reconcile" | "cleanup"): string {
  return deriveSetupOperationIdempotencyKey(runId, operationValue.id, action);
}

function operation(id: string): SetupOperation {
  const found = createProductionSetupPlan("cloudflare-workers").operations.find(
    (candidate) => candidate.id === id
  );
  if (found === undefined) throw new Error(`missing setup operation ${id}`);
  return found;
}

async function captureAdapterError(
  value: unknown
): Promise<CloudflareD1MigrationSetupAdapterError> {
  try {
    await value;
  } catch (error) {
    if (error instanceof CloudflareD1MigrationSetupAdapterError) return error;
    throw error;
  }
  throw new Error("expected D1 migration setup adapter failure");
}
