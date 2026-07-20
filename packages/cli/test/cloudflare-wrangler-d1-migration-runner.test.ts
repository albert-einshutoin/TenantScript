import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_MIGRATION_MANIFEST,
  D1MigrationRunnerError,
  createCloudflareD1MigrationSetupAdapter,
  createCloudflareWranglerD1MigrationRunner,
  createNodeWranglerD1MigrationProcess,
  createProductionSetupPlan,
  deriveSetupOperationIdempotencyKey,
  loadControlPlaneMigrationCatalog,
  type CloudflareApiTransport,
  type SetupOperation,
  type WranglerD1MigrationProcess
} from "../src/index.js";

const databaseId = "123e4567-e89b-12d3-a456-426614174000";
const databaseName = "tenantscript-control-plane";
const configPath = "wrangler.jsonc";
const tableQuery = "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'd1_migrations'";
const historyQuery = "SELECT name FROM d1_migrations ORDER BY id ASC";
const expectedNames = CONTROL_PLANE_MIGRATION_MANIFEST.map((migration) => migration.name);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("Cloudflare Wrangler D1 migration runner", () => {
  it("returns an empty history when the migration table does not exist", async () => {
    const requests: RecordedRequest[] = [];
    const runner = createRunner({
      transport: recordingTransport(requests, () => queryResult([]))
    });

    await expect(runner.listApplied(databaseId)).resolves.toEqual([]);
    expect(requests).toEqual([
      {
        method: "POST",
        pathSegments: ["d1", "database", databaseId, "query"],
        body: { sql: tableQuery }
      }
    ]);
  });

  it("reads applied names in provider order through two constant queries", async () => {
    const requests: RecordedRequest[] = [];
    let call = 0;
    const applied = expectedNames.slice(0, 4);
    const runner = createRunner({
      transport: recordingTransport(requests, () => {
        call += 1;
        return call === 1
          ? queryResult([{ name: "d1_migrations" }])
          : queryResult(applied.map((name) => ({ name })));
      })
    });

    await expect(runner.listApplied(databaseId)).resolves.toEqual(applied);
    expect(requests.map((request) => request.body)).toEqual([
      { sql: tableQuery },
      { sql: historyQuery }
    ]);
  });

  it.each([
    ["multiple results", [queryItem([]), queryItem([])]],
    ["query failure", [{ success: false, results: [] }]],
    ["missing results", [{ success: true }]],
    ["unknown result field", [{ success: true, results: [], secret: "secret-sentinel" }]],
    ["unknown row field", [queryItem([{ name: expectedNames[0], secret: "secret-sentinel" }])]],
    ["invalid row name", [queryItem([{ name: "../../secret-sentinel" }])]],
    [
      "oversized history",
      [queryItem(new Array(expectedNames.length + 1).fill({ name: expectedNames[0] }))]
    ]
  ])("fails closed for %s without reflecting provider data", async (_scenario, response) => {
    const runner = createRunner({ transport: recordingTransport([], () => response) });

    const error = await captureRunnerError(runner.listApplied(databaseId));
    expect(error.toJSON()).toEqual({ code: "d1_migration_runner_failed" });
    expect(JSON.stringify(error)).not.toContain("secret-sentinel");
  });

  it("rechecks the exact pending suffix before invoking Wrangler once", async () => {
    const applied = expectedNames.slice(0, 9);
    const requests: RecordedRequest[] = [];
    const processCalls: unknown[] = [];
    const runner = createRunner({
      transport: historyTransport(requests, applied),
      process: recordingProcess(processCalls)
    });

    await expect(runner.applyPending(databaseId, expectedNames.slice(9))).resolves.toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(processCalls).toEqual([{ databaseName, configPath }]);
  });

  it.each([
    ["wrong database", "223e4567-e89b-12d3-a456-426614174000", expectedNames.slice(9)],
    ["empty pending", databaseId, []],
    ["prefix instead of suffix", databaseId, expectedNames.slice(0, 2)],
    ["unknown migration", databaseId, ["9999_secret.sql"]]
  ])("rejects %s before provider or process access", async (_scenario, id, pending) => {
    const requests: RecordedRequest[] = [];
    const processCalls: unknown[] = [];
    const runner = createRunner({
      transport: historyTransport(requests, expectedNames.slice(0, 9)),
      process: recordingProcess(processCalls)
    });

    await expect(runner.applyPending(id, pending)).rejects.toBeInstanceOf(D1MigrationRunnerError);
    expect(requests).toEqual([]);
    expect(processCalls).toEqual([]);
  });

  it("fails before process execution when remote history drifts after adapter observation", async () => {
    const requests: RecordedRequest[] = [];
    const processCalls: unknown[] = [];
    const runner = createRunner({
      transport: historyTransport(requests, expectedNames.slice(0, 10)),
      process: recordingProcess(processCalls)
    });

    await expect(runner.applyPending(databaseId, expectedNames.slice(9))).rejects.toBeInstanceOf(
      D1MigrationRunnerError
    );
    expect(requests).toHaveLength(2);
    expect(processCalls).toEqual([]);
  });

  it("sanitizes process failures and never retries the mutation", async () => {
    const processCalls: unknown[] = [];
    const runner = createRunner({
      transport: historyTransport([], expectedNames.slice(0, 12)),
      process: {
        applyRemote: (request) => {
          processCalls.push(request);
          throw new Error("process-secret-sentinel");
        }
      }
    });

    const error = await captureRunnerError(
      runner.applyPending(databaseId, expectedNames.slice(12))
    );
    expect(processCalls).toHaveLength(1);
    expect(JSON.stringify(error)).not.toContain("process-secret-sentinel");
  });

  it.each([
    { databaseName: "tenant db; rm -rf" },
    { configPath: "../operator-secret.jsonc" },
    { configPath: "/tmp/operator-secret.jsonc" },
    { extra: "secret-sentinel" }
  ])("rejects invalid or widened runner configuration", (override) => {
    expect(() =>
      createCloudflareWranglerD1MigrationRunner({
        transport: historyTransport([], []),
        databaseId,
        databaseName,
        configPath,
        process: recordingProcess([]),
        ...override
      })
    ).toThrow("wrangler D1 migration runner configuration is invalid");
  });

  it("composes partial history through the existing migration adapter", async () => {
    const migrationDirectory = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../control-plane/migrations"
    );
    const catalog = await loadControlPlaneMigrationCatalog({ directory: migrationDirectory });
    const applied = expectedNames.slice(0, 11);
    const requests: RecordedRequest[] = [];
    const processCalls: unknown[] = [];
    const migrationProcess: WranglerD1MigrationProcess = {
      applyRemote: (request) => {
        processCalls.push(request);
        applied.push(...expectedNames.slice(11));
      }
    };
    const runner = createRunner({
      transport: historyTransport(requests, applied),
      process: migrationProcess
    });
    const adapter = createCloudflareD1MigrationSetupAdapter({ databaseId, catalog, runner });
    const operation = migrationOperation();

    await expect(
      adapter.reconcile({
        attempt: "initial",
        runId: "setup-run-199",
        idempotencyKey: deriveSetupOperationIdempotencyKey(
          "setup-run-199",
          operation.id,
          "reconcile"
        ),
        operation
      })
    ).resolves.toEqual({ disposition: "applied" });
    expect(processCalls).toEqual([{ databaseName, configPath }]);
    expect(requests).toHaveLength(6);
  });
});

describe("Node Wrangler D1 migration process", () => {
  it("executes the pinned script with exact remote arguments and closed stdio", async () => {
    const fixture = await processFixture(`
      import { writeFile } from "node:fs/promises";
      await writeFile(${JSON.stringify("ARGS_RECEIPT")}, JSON.stringify(process.argv.slice(2)));
    `);
    const receiptPath = join(fixture.directory, "args.json");
    await replaceFixtureMarker(fixture.scriptPath, receiptPath);
    const migrationProcess = createNodeWranglerD1MigrationProcess({
      repositoryRoot: fixture.directory,
      wranglerBinPath: "fake-wrangler.mjs",
      timeoutMs: 2_000
    });

    await migrationProcess.applyRemote({ databaseName, configPath });

    await expect(
      readFile(receiptPath, "utf8").then((contents) => JSON.parse(contents) as unknown)
    ).resolves.toEqual([
      "d1",
      "migrations",
      "apply",
      databaseName,
      "--remote",
      "--config",
      configPath,
      "--install-skills=false"
    ]);
  });

  it("returns a stable error without process output when Wrangler exits non-zero", async () => {
    const fixture = await processFixture(`
      console.log("stdout-secret-sentinel");
      console.error("stderr-secret-sentinel");
      process.exit(2);
    `);
    const migrationProcess = createNodeWranglerD1MigrationProcess({
      repositoryRoot: fixture.directory,
      wranglerBinPath: "fake-wrangler.mjs",
      timeoutMs: 2_000
    });

    const error = await captureRunnerError(
      migrationProcess.applyRemote({ databaseName, configPath })
    );
    expect(JSON.stringify(error)).not.toContain("secret-sentinel");
  });

  it("kills a hung non-interactive process at the configured timeout", async () => {
    const fixture = await processFixture("setInterval(() => undefined, 1_000);");
    const migrationProcess = createNodeWranglerD1MigrationProcess({
      repositoryRoot: fixture.directory,
      wranglerBinPath: "fake-wrangler.mjs",
      timeoutMs: 20
    });

    const startedAt = Date.now();
    await expect(migrationProcess.applyRemote({ databaseName, configPath })).rejects.toBeInstanceOf(
      D1MigrationRunnerError
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("rejects a Wrangler binary that escapes through a symlinked parent directory", async () => {
    const fixture = await processFixture("");
    const externalDirectory = join(
      process.cwd(),
      ".tmp",
      `wrangler-external-${crypto.randomUUID()}`
    );
    temporaryDirectories.push(externalDirectory);
    await mkdir(externalDirectory, { recursive: true });
    await writeFile(join(externalDirectory, "fake-wrangler.mjs"), "");
    await symlink(externalDirectory, join(fixture.directory, "linked-bin"), "dir");
    const migrationProcess = createNodeWranglerD1MigrationProcess({
      repositoryRoot: fixture.directory,
      wranglerBinPath: "linked-bin/fake-wrangler.mjs",
      timeoutMs: 2_000
    });

    await expect(migrationProcess.applyRemote({ databaseName, configPath })).rejects.toBeInstanceOf(
      D1MigrationRunnerError
    );
  });

  it.each([
    { repositoryRoot: "relative/root" },
    { wranglerBinPath: "../outside.mjs" },
    { timeoutMs: 0 },
    { unexpected: "secret-sentinel" }
  ])("rejects unsafe process configuration before spawn", (override) => {
    expect(() =>
      createNodeWranglerD1MigrationProcess({
        repositoryRoot: process.cwd(),
        wranglerBinPath: "node_modules/wrangler/bin/wrangler.js",
        timeoutMs: 2_000,
        ...override
      })
    ).toThrow("Wrangler process configuration is invalid");
  });
});

interface RecordedRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathSegments: readonly string[];
  query?: Readonly<Record<string, string>>;
  body?: unknown;
}

function createRunner(overrides: {
  transport: CloudflareApiTransport;
  process?: WranglerD1MigrationProcess;
}) {
  return createCloudflareWranglerD1MigrationRunner({
    transport: overrides.transport,
    databaseId,
    databaseName,
    configPath,
    process: overrides.process ?? recordingProcess([])
  });
}

function recordingTransport(
  requests: RecordedRequest[],
  respond: (request: RecordedRequest) => unknown
): CloudflareApiTransport {
  return {
    request: (request) => {
      requests.push(structuredClone(request));
      return Promise.resolve().then(() => respond(request));
    }
  };
}

function historyTransport(requests: RecordedRequest[], applied: readonly string[]) {
  return recordingTransport(requests, (request) => {
    const sql = requireRecord(request.body).sql;
    if (sql === tableQuery) return queryResult([{ name: "d1_migrations" }]);
    if (sql === historyQuery) return queryResult(applied.map((name) => ({ name })));
    throw new Error("unexpected query");
  });
}

function recordingProcess(calls: unknown[]): WranglerD1MigrationProcess {
  return {
    applyRemote: (request) => {
      calls.push(structuredClone(request));
    }
  };
}

function queryResult(rows: unknown[]): unknown[] {
  return [queryItem(rows)];
}

function queryItem(rows: unknown[]) {
  return { success: true, results: rows, meta: { duration: 0 } };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected record");
  }
  return value as Record<string, unknown>;
}

async function captureRunnerError(value: unknown): Promise<D1MigrationRunnerError> {
  try {
    await value;
  } catch (error) {
    if (error instanceof D1MigrationRunnerError) return error;
    throw error;
  }
  throw new Error("expected migration runner failure");
}

function migrationOperation(): SetupOperation {
  const operation = createProductionSetupPlan("cloudflare-workers").operations.find(
    (candidate) => candidate.id === "apply:control-plane-migrations"
  );
  if (operation === undefined) throw new Error("missing migration operation");
  return operation;
}

async function processFixture(source: string): Promise<{
  directory: string;
  scriptPath: string;
}> {
  const directory = join(process.cwd(), ".tmp", `wrangler-runner-${crypto.randomUUID()}`);
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  const scriptPath = join(directory, "fake-wrangler.mjs");
  await writeFile(scriptPath, source);
  await writeFile(join(directory, configPath), "{}\n");
  return { directory, scriptPath };
}

async function replaceFixtureMarker(scriptPath: string, receiptPath: string): Promise<void> {
  const source = await readFile(scriptPath, "utf8");
  await writeFile(scriptPath, source.replace('"ARGS_RECEIPT"', JSON.stringify(receiptPath)));
}
