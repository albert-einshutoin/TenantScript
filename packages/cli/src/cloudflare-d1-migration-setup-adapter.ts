import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  deriveSetupOperationIdempotencyKey,
  type SetupProviderAdapter,
  type SetupReconcileResult
} from "./setup-executor.js";
import type { SetupOperation } from "./setup-plan.js";

const MIGRATION_OPERATION_ID = "apply:control-plane-migrations";
const MAX_MIGRATION_BYTES = 65_536;

export interface ControlPlaneMigration {
  name: string;
  byteLength: number;
  sha256: string;
}

export interface ControlPlaneMigrationCatalog {
  migrations: readonly ControlPlaneMigration[];
}

// Wrangler records only migration names remotely. Pinning length and digest here makes edits to an
// already published SQL file visible in Tier 1 instead of silently accepting name-only history.
const manifestEntries = [
  ["0001_initial.sql", 2846, "98056ef6efb946486b6dfb836d05db1d85befb414f8dab7cb93a72c4e55f4aa8"],
  [
    "0002_installation_command_audit.sql",
    2811,
    "16beac3d92442aa8b00c68d505067e5050da97f8002798aeff26ee7674a306e0"
  ],
  [
    "0003_installation_rollback_audit.sql",
    1741,
    "88e5896e78eb624f7ed5ce7b9813603624d462b09869bea8d0e89de5a9ccc6fa"
  ],
  [
    "0004_approval_decision_audit.sql",
    1892,
    "28a806e349907727e151a4d9d972a6c9a3c2957ee174a290615bf7bf5df49bab"
  ],
  [
    "0005_install_idempotency.sql",
    508,
    "50fbd85ee15dec0a8a626591db78598cba7ebd153f0ed202907211f00bebbc93"
  ],
  [
    "0006_rollback_idempotency.sql",
    624,
    "94bd9451989047f012d879e151f937eb11f2e0055db3bb689ab62dcf493e42ef"
  ],
  [
    "0007_service_tokens.sql",
    1003,
    "e270e7b3ca778a16df2f58722152e29aab007c60fc6977f59f49d53c2e73b909"
  ],
  [
    "0008_rbac_approval_trigger.sql",
    2070,
    "2fe0f38072a0ea69c41c49124ad1a80096ecf8dbfa2026d764603568a614eb37"
  ],
  [
    "0009_installation_grant_requests.sql",
    2780,
    "cbba5f36ca17a21b557847b2fcdb7294979e7a4691b70cae17990316cb14d317"
  ],
  [
    "0010_admin_approval_threshold.sql",
    1999,
    "60772424f107e17dfd8a272b6b221cc52b992d6ae27ca6eebb4c637faf5f3216"
  ],
  [
    "0011_immutable_audit_log.sql",
    3470,
    "312fed589ee093d87bf26b1b4d5d88cd0248b84aa62cf5b4a09935f1e29d2102"
  ],
  [
    "0012_execution_archives.sql",
    913,
    "6190cabab35843c87b9f5128072f29c1fc1aa5ffd4b40fc9abbe3fe679776359"
  ],
  [
    "0013_runaway_quarantine.sql",
    1504,
    "feeb87b6280a15780b487beb7812253c32484f2e1d1e20773aac827b346c6a9f"
  ]
] as const;

export const CONTROL_PLANE_MIGRATION_MANIFEST: readonly ControlPlaneMigration[] = Object.freeze(
  manifestEntries.map(([name, byteLength, sha256]) => Object.freeze({ name, byteLength, sha256 }))
);

export interface D1MigrationRunner {
  listApplied: (databaseId: string) => Promise<readonly string[]> | readonly string[];
  applyPending: (databaseId: string, migrationNames: readonly string[]) => Promise<void> | void;
}

export type D1MigrationRunnerErrorCode = "d1_migration_runner_failed";

export class D1MigrationRunnerError extends Error {
  override readonly name = "D1MigrationRunnerError";
  readonly code = "d1_migration_runner_failed";

  constructor() {
    super("d1_migration_runner_failed");
  }

  toJSON(): { code: D1MigrationRunnerErrorCode } {
    return { code: this.code };
  }
}

export type CloudflareD1MigrationSetupAdapterErrorCode =
  | "cloudflare_d1_migration_invalid_catalog"
  | "cloudflare_d1_migration_invalid_configuration"
  | "cloudflare_d1_migration_invalid_remote_state"
  | "cloudflare_d1_migration_invalid_request"
  | "cloudflare_d1_migration_invalid_response"
  | "cloudflare_d1_migration_runner_failed"
  | "cloudflare_d1_migration_unsupported_operation";

export class CloudflareD1MigrationSetupAdapterError extends Error {
  override readonly name = "CloudflareD1MigrationSetupAdapterError";

  constructor(readonly code: CloudflareD1MigrationSetupAdapterErrorCode) {
    super(code);
  }

  toJSON(): { code: CloudflareD1MigrationSetupAdapterErrorCode } {
    return { code: this.code };
  }
}

export async function loadControlPlaneMigrationCatalog(params: {
  directory: string;
}): Promise<ControlPlaneMigrationCatalog> {
  if (
    !isRecord(params) ||
    !hasOnlyKeys(params, ["directory"]) ||
    !isDirectoryPath(params.directory)
  ) {
    throw invalidCatalog();
  }

  try {
    const directoryStatus = await lstat(params.directory);
    if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) throw invalidCatalog();
    const directoryEntries = await readdir(params.directory, { withFileTypes: true });
    const names = directoryEntries.map((entry) => entry.name).sort();
    const expectedNames = CONTROL_PLANE_MIGRATION_MANIFEST.map((entry) => entry.name);
    if (!equalStrings(names, expectedNames)) throw invalidCatalog();

    for (const [index, expected] of CONTROL_PLANE_MIGRATION_MANIFEST.entries()) {
      const entry = directoryEntries.find((candidate) => candidate.name === expected.name);
      if (
        entry === undefined ||
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        migrationSequence(expected.name) !== index + 1
      ) {
        throw invalidCatalog();
      }
      const contents = await readFile(join(params.directory, expected.name));
      if (
        contents.byteLength === 0 ||
        contents.byteLength > MAX_MIGRATION_BYTES ||
        contents.byteLength !== expected.byteLength ||
        hasUnsafeControlByte(contents) ||
        createHash("sha256").update(contents).digest("hex") !== expected.sha256
      ) {
        throw invalidCatalog();
      }
      new TextDecoder("utf-8", { fatal: true }).decode(contents);
    }
  } catch (error) {
    if (error instanceof CloudflareD1MigrationSetupAdapterError) throw error;
    throw invalidCatalog();
  }

  return {
    migrations: CONTROL_PLANE_MIGRATION_MANIFEST.map((entry) => ({ ...entry }))
  };
}

export function createCloudflareD1MigrationSetupAdapter(params: {
  databaseId: string;
  catalog: ControlPlaneMigrationCatalog;
  runner: D1MigrationRunner;
}): SetupProviderAdapter {
  validateConfiguration(params);
  const expectedNames = params.catalog.migrations.map((migration) => migration.name);

  return {
    reconcile: async (request): Promise<SetupReconcileResult> => {
      validateRequest(request, "reconcile");
      if (!isMigrationOperation(request.operation)) throw unsupportedOperation();

      const applied = await callRunner(() => params.runner.listApplied(params.databaseId));
      const prefixLength = validateAppliedHistory(applied, expectedNames, invalidRemoteState);
      if (prefixLength === expectedNames.length) return { disposition: "applied" };

      const pending = expectedNames.slice(prefixLength);
      await callRunner(() => params.runner.applyPending(params.databaseId, pending));
      const verified = await callRunner(() => params.runner.listApplied(params.databaseId));
      if (!isExactHistory(verified, expectedNames)) throw invalidResponse();
      return { disposition: "applied" };
    },
    cleanupCreated: (request): Promise<void> =>
      Promise.resolve().then(() => {
        // Applied migrations are never setup-owned resources. Keeping this as a rejected cleanup
        // operation prevents failure recovery from turning into an implicit destructive down path.
        validateRequest(request, "cleanup");
        throw invalidRequest();
      })
  };
}

function validateConfiguration(params: unknown): asserts params is {
  databaseId: string;
  catalog: ControlPlaneMigrationCatalog;
  runner: D1MigrationRunner;
} {
  if (
    !isRecord(params) ||
    !hasOnlyKeys(params, ["databaseId", "catalog", "runner"]) ||
    !isD1DatabaseId(params.databaseId) ||
    !isRunner(params.runner) ||
    !isCanonicalCatalog(params.catalog)
  ) {
    throw invalidConfiguration();
  }
}

function validateRequest(
  request: { runId: string; idempotencyKey: string; operation: SetupOperation },
  action: "reconcile" | "cleanup"
): void {
  if (
    !isSafeIdentifier(request.runId, 128) ||
    !isRecord(request.operation) ||
    !isSafeIdentifier(request.operation.id, 256) ||
    request.idempotencyKey !==
      deriveSetupOperationIdempotencyKey(request.runId, request.operation.id, action)
  ) {
    throw invalidRequest();
  }
}

function isMigrationOperation(operation: SetupOperation): boolean {
  return (
    operation.id === MIGRATION_OPERATION_ID &&
    operation.kind === "migration" &&
    operation.action === "apply" &&
    operation.logicalName === "packages/control-plane/migrations" &&
    operation.implementationStatus === "implemented" &&
    operation.dependsOn.length === 1 &&
    operation.dependsOn[0] === "create:control-plane-d1"
  );
}

async function callRunner<T>(operation: () => Promise<T> | T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof D1MigrationRunnerError) throw error;
    throw runnerFailed();
  }
}

function validateAppliedHistory(
  value: unknown,
  expected: readonly string[],
  failure: () => CloudflareD1MigrationSetupAdapterError
): number {
  if (!Array.isArray(value) || value.length > expected.length) throw failure();
  for (const [index, name] of value.entries()) {
    if (typeof name !== "string" || name !== expected[index]) throw failure();
  }
  return value.length;
}

function isExactHistory(value: unknown, expected: readonly string[]): boolean {
  try {
    return validateAppliedHistory(value, expected, invalidResponse) === expected.length;
  } catch {
    return false;
  }
}

function isCanonicalCatalog(value: unknown): value is ControlPlaneMigrationCatalog {
  if (!isRecord(value) || !hasOnlyKeys(value, ["migrations"]) || !Array.isArray(value.migrations)) {
    return false;
  }
  if (value.migrations.length !== CONTROL_PLANE_MIGRATION_MANIFEST.length) return false;
  for (const [index, expected] of CONTROL_PLANE_MIGRATION_MANIFEST.entries()) {
    const migration: unknown = value.migrations[index];
    if (
      !(
        isRecord(migration) &&
        hasOnlyKeys(migration, ["name", "byteLength", "sha256"]) &&
        migration.name === expected.name &&
        migration.byteLength === expected.byteLength &&
        migration.sha256 === expected.sha256
      )
    ) {
      return false;
    }
  }
  return true;
}

function isRunner(value: unknown): value is D1MigrationRunner {
  return (
    isRecord(value) &&
    typeof value.listApplied === "function" &&
    typeof value.applyPending === "function"
  );
}

function migrationSequence(name: string): number {
  if (!/^\d{4}_[a-z0-9_]+\.sql$/u.test(name)) return -1;
  return Number.parseInt(name.slice(0, 4), 10);
}

function hasUnsafeControlByte(contents: Uint8Array): boolean {
  return contents.some((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13);
}

function isDirectoryPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes("\0") &&
    !value.split(/[\\/]+/u).includes("..")
  );
}

function isD1DatabaseId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  );
}

function isSafeIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(value)
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

function invalidCatalog(): CloudflareD1MigrationSetupAdapterError {
  return new CloudflareD1MigrationSetupAdapterError("cloudflare_d1_migration_invalid_catalog");
}

function invalidConfiguration(): CloudflareD1MigrationSetupAdapterError {
  return new CloudflareD1MigrationSetupAdapterError(
    "cloudflare_d1_migration_invalid_configuration"
  );
}

function invalidRemoteState(): CloudflareD1MigrationSetupAdapterError {
  return new CloudflareD1MigrationSetupAdapterError("cloudflare_d1_migration_invalid_remote_state");
}

function invalidRequest(): CloudflareD1MigrationSetupAdapterError {
  return new CloudflareD1MigrationSetupAdapterError("cloudflare_d1_migration_invalid_request");
}

function invalidResponse(): CloudflareD1MigrationSetupAdapterError {
  return new CloudflareD1MigrationSetupAdapterError("cloudflare_d1_migration_invalid_response");
}

function runnerFailed(): CloudflareD1MigrationSetupAdapterError {
  return new CloudflareD1MigrationSetupAdapterError("cloudflare_d1_migration_runner_failed");
}

function unsupportedOperation(): CloudflareD1MigrationSetupAdapterError {
  return new CloudflareD1MigrationSetupAdapterError(
    "cloudflare_d1_migration_unsupported_operation"
  );
}
