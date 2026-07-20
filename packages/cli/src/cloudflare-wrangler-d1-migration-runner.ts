import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { CloudflareApiTransport } from "./cloudflare-api-transport.js";
import {
  CONTROL_PLANE_MIGRATION_MANIFEST,
  D1MigrationRunnerError,
  type D1MigrationRunner
} from "./cloudflare-d1-migration-setup-adapter.js";

const MIGRATION_TABLE_QUERY =
  "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'd1_migrations'";
const MIGRATION_HISTORY_QUERY = "SELECT name FROM d1_migrations ORDER BY id ASC";
const DEFAULT_WRANGLER_BIN_PATH = "node_modules/wrangler/bin/wrangler.js";
const DEFAULT_TIMEOUT_MS = 120_000;

export interface WranglerD1MigrationProcess {
  applyRemote: (request: { databaseName: string; configPath: string }) => Promise<void> | void;
}

export function createCloudflareWranglerD1MigrationRunner(params: {
  transport: CloudflareApiTransport;
  databaseId: string;
  databaseName: string;
  configPath: string;
  process: WranglerD1MigrationProcess;
}): D1MigrationRunner {
  validateRunnerConfiguration(params);
  const expectedNames = CONTROL_PLANE_MIGRATION_MANIFEST.map((migration) => migration.name);

  const listApplied = async (databaseId: string): Promise<readonly string[]> => {
    if (databaseId !== params.databaseId) throw runnerFailure();

    try {
      const tableResult = parseQueryResult(
        await params.transport.request({
          method: "POST",
          pathSegments: ["d1", "database", databaseId, "query"],
          body: { sql: MIGRATION_TABLE_QUERY }
        })
      );
      if (tableResult.length === 0) return [];
      if (tableResult.length !== 1 || !isExactNameRow(tableResult[0], "d1_migrations")) {
        throw runnerFailure();
      }

      const historyResult = parseQueryResult(
        await params.transport.request({
          method: "POST",
          pathSegments: ["d1", "database", databaseId, "query"],
          body: { sql: MIGRATION_HISTORY_QUERY }
        })
      );
      const names = historyResult.map(readMigrationName);
      validateHistory(names, expectedNames);
      return names;
    } catch (error) {
      if (error instanceof D1MigrationRunnerError) throw error;
      throw runnerFailure();
    }
  };

  return {
    listApplied,
    applyPending: async (databaseId, migrationNames): Promise<void> => {
      if (
        databaseId !== params.databaseId ||
        !Array.isArray(migrationNames) ||
        migrationNames.length === 0 ||
        !migrationNames.every((name) => typeof name === "string")
      ) {
        throw runnerFailure();
      }

      const suffixStart = expectedNames.length - migrationNames.length;
      if (suffixStart < 0 || !equalStrings(migrationNames, expectedNames.slice(suffixStart))) {
        throw runnerFailure();
      }

      // The adapter's first read can become stale while setup is running. Re-reading immediately
      // before the mutation makes history drift a fail-closed outcome instead of applying an
      // unexpected suffix to a changed database.
      const applied = await listApplied(databaseId);
      if (!equalStrings(applied, expectedNames.slice(0, suffixStart))) throw runnerFailure();

      try {
        // Mutation retries are intentionally absent: an interrupted Wrangler invocation has an
        // ambiguous remote outcome and must be reconciled by a later history read.
        await params.process.applyRemote({
          databaseName: params.databaseName,
          configPath: params.configPath
        });
      } catch {
        throw runnerFailure();
      }
    }
  };
}

export function createNodeWranglerD1MigrationProcess(params: {
  repositoryRoot: string;
  wranglerBinPath?: string;
  timeoutMs?: number;
}): WranglerD1MigrationProcess {
  validateProcessConfiguration(params);
  const wranglerBinPath = params.wranglerBinPath ?? DEFAULT_WRANGLER_BIN_PATH;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    applyRemote: async (request): Promise<void> => {
      if (
        !isRecord(request) ||
        !hasExactKeys(request, ["databaseName", "configPath"]) ||
        !isDatabaseName(request.databaseName) ||
        !isSafeRelativePath(request.configPath)
      ) {
        throw runnerFailure();
      }

      const executablePath = resolveInside(params.repositoryRoot, wranglerBinPath);
      const configFilePath = resolveInside(params.repositoryRoot, request.configPath);
      try {
        const repositoryRoot = await assertRepositoryRoot(params.repositoryRoot);
        await Promise.all([
          assertContainedRegularFile(repositoryRoot, executablePath),
          assertContainedRegularFile(repositoryRoot, configFilePath)
        ]);
        await runWrangler({
          repositoryRoot: params.repositoryRoot,
          executablePath,
          timeoutMs,
          databaseName: request.databaseName,
          configPath: request.configPath
        });
      } catch (error) {
        if (error instanceof D1MigrationRunnerError) throw error;
        throw runnerFailure();
      }
    }
  };
}

function parseQueryResult(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length !== 1) throw runnerFailure();
  const item: unknown = value[0];
  if (
    !isRecord(item) ||
    !hasOnlyKeys(item, ["success", "results", "meta"]) ||
    item.success !== true ||
    !Array.isArray(item.results)
  ) {
    throw runnerFailure();
  }
  return item.results;
}

function readMigrationName(value: unknown): string {
  if (!isRecord(value) || !hasExactKeys(value, ["name"]) || typeof value.name !== "string") {
    throw runnerFailure();
  }
  return value.name;
}

function isExactNameRow(value: unknown, expected: string): boolean {
  return isRecord(value) && hasExactKeys(value, ["name"]) && value.name === expected;
}

function validateHistory(names: readonly string[], expected: readonly string[]): void {
  if (names.length > expected.length || !equalStrings(names, expected.slice(0, names.length))) {
    throw runnerFailure();
  }
}

function validateRunnerConfiguration(value: unknown): asserts value is {
  transport: CloudflareApiTransport;
  databaseId: string;
  databaseName: string;
  configPath: string;
  process: WranglerD1MigrationProcess;
} {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["transport", "databaseId", "databaseName", "configPath", "process"]) ||
    !isRecord(value.transport) ||
    typeof value.transport.request !== "function" ||
    !isDatabaseId(value.databaseId) ||
    !isDatabaseName(value.databaseName) ||
    !isSafeRelativePath(value.configPath) ||
    !isRecord(value.process) ||
    typeof value.process.applyRemote !== "function"
  ) {
    throw new TypeError("wrangler D1 migration runner configuration is invalid");
  }
}

function validateProcessConfiguration(value: unknown): asserts value is {
  repositoryRoot: string;
  wranglerBinPath?: string;
  timeoutMs?: number;
} {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["repositoryRoot", "wranglerBinPath", "timeoutMs"]) ||
    !hasRequiredKeys(value, ["repositoryRoot"]) ||
    typeof value.repositoryRoot !== "string" ||
    !isAbsolute(value.repositoryRoot) ||
    (value.wranglerBinPath !== undefined && !isSafeRelativePath(value.wranglerBinPath)) ||
    (value.timeoutMs !== undefined && !isBoundedInteger(value.timeoutMs, 1, 600_000))
  ) {
    throw new TypeError("Wrangler process configuration is invalid");
  }
}

async function assertRepositoryRoot(path: string): Promise<string> {
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) throw runnerFailure();
  return realpath(path);
}

async function assertContainedRegularFile(root: string, path: string): Promise<void> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) throw runnerFailure();
  const resolved = await realpath(path);
  const relation = relative(root, resolved);
  // Checking the canonical path closes parent-directory symlink escapes that lexical resolution
  // cannot see. The final lstat still rejects a direct file symlink as a separate invariant.
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
    throw runnerFailure();
  }
}

function runWrangler(params: {
  repositoryRoot: string;
  executablePath: string;
  timeoutMs: number;
  databaseName: string;
  configPath: string;
}): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const child = spawn(
      process.execPath,
      [
        params.executablePath,
        "d1",
        "migrations",
        "apply",
        params.databaseName,
        "--remote",
        "--config",
        params.configPath,
        "--install-skills=false"
      ],
      {
        cwd: params.repositoryRoot,
        shell: false,
        stdio: "ignore",
        env: {
          ...process.env,
          CI: "true",
          WRANGLER_SEND_METRICS: "false"
        }
      }
    );

    const settle = (error?: D1MigrationRunnerError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) resolvePromise();
      else rejectPromise(error);
    };
    const timeout = setTimeout(() => {
      // SIGKILL bounds a hung non-interactive child even when it ignores graceful termination.
      child.kill("SIGKILL");
      settle(runnerFailure());
    }, params.timeoutMs);
    child.once("error", () => {
      settle(runnerFailure());
    });
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) settle();
      else settle(runnerFailure());
    });
  });
}

function resolveInside(root: string, path: string): string {
  const resolved = resolve(root, path);
  const relation = relative(root, resolved);
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) throw runnerFailure();
  return resolved;
}

function isSafeRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !isAbsolute(value) &&
    !value.includes("\0") &&
    !value.split(/[\\/]+/u).includes("..")
  );
}

function isDatabaseId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  );
}

function isDatabaseName(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)
  );
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasRequiredKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && hasRequiredKeys(value, expected);
}

function runnerFailure(): D1MigrationRunnerError {
  return new D1MigrationRunnerError();
}
