import { createHash } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { deriveSetupOperationIdempotencyKey } from "./setup-executor.js";

const CONTROL_PLANE_WORKER_OPERATION_ID = "create:control-plane-worker";

export interface ProductionWranglerInputV1 {
  version: 1;
  baseWorkerName: string;
  setupRunId: string;
  compatibilityDate: string;
  database: {
    name: string;
    id: string;
  };
}

export function parseProductionWranglerInput(value: unknown): ProductionWranglerInputV1 {
  if (
    !isExactRecord(value, [
      "version",
      "baseWorkerName",
      "setupRunId",
      "compatibilityDate",
      "database"
    ])
  ) {
    throw invalidInput();
  }
  if (
    value.version !== 1 ||
    !isWorkerBaseName(value.baseWorkerName) ||
    !isSetupRunId(value.setupRunId) ||
    !isUtcDate(value.compatibilityDate) ||
    !isExactRecord(value.database, ["name", "id"]) ||
    !isDatabaseName(value.database.name) ||
    !isDatabaseId(value.database.id)
  ) {
    throw invalidInput();
  }
  return {
    version: 1,
    baseWorkerName: value.baseWorkerName,
    setupRunId: value.setupRunId,
    compatibilityDate: value.compatibilityDate,
    database: { name: value.database.name, id: value.database.id }
  };
}

export function deriveControlPlaneWorkerName(baseName: string, setupRunId: string): string {
  if (!isWorkerBaseName(baseName) || !isSetupRunId(setupRunId)) {
    throw new Error("Control Plane Worker target is invalid");
  }
  const reconcileIdempotencyKey = deriveSetupOperationIdempotencyKey(
    setupRunId,
    CONTROL_PLANE_WORKER_OPERATION_ID,
    "reconcile"
  );
  // Cloudflare does not expose a mutation idempotency key for Wrangler deploy. A 96-bit digest
  // creates one stable crash-resume target without publishing the persisted setup key as a name.
  const suffix = createHash("sha256").update(reconcileIdempotencyKey).digest("hex").slice(0, 24);
  return `${baseName}-${suffix}`;
}

export function renderProductionWranglerConfig(input: ProductionWranglerInputV1): string {
  const parsed = parseProductionWranglerInput(input);
  // Build an exact deployment DTO instead of merging operator input. This keeps credentials and
  // future, not-yet-wired bindings from accidentally crossing into the generated config.
  const config = {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: deriveControlPlaneWorkerName(parsed.baseWorkerName, parsed.setupRunId),
    main: "packages/control-plane/src/worker-entry.ts",
    compatibility_date: parsed.compatibilityDate,
    d1_databases: [
      {
        binding: "DB",
        database_name: parsed.database.name,
        database_id: parsed.database.id,
        migrations_dir: "packages/control-plane/migrations"
      }
    ],
    durable_objects: {
      bindings: [
        {
          name: "ADMIN_MUTATION_RATE_LIMITER_DO",
          class_name: "AdminMutationRateLimitDurableObject"
        }
      ]
    },
    exports: {
      AdminMutationRateLimitDurableObject: {
        type: "durable-object",
        storage: "sqlite"
      }
    }
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function writeProductionWranglerConfig(
  outputPath: string,
  content: string
): Promise<void> {
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${crypto.randomUUID()}.tmp`
  );
  let temporaryCreated = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // A hard link atomically publishes the complete temporary file and fails when outputPath
    // already exists, so setup never truncates an operator-owned Wrangler configuration.
    await link(temporaryPath, outputPath);
  } finally {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
  }
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isWorkerBaseName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,36}[a-z0-9])?$/u.test(value);
}

function isSetupRunId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(value) &&
    !/(?:secret-sentinel|bearer|eyJ[A-Za-z0-9_-]*\.|(?:^|:)sk[-_])/iu.test(value)
  );
}

function isDatabaseName(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/u.test(value)
  );
}

function isDatabaseId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/u.test(value);
}

function isUtcDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function invalidInput(): Error {
  return new Error("wrangler input is invalid");
}
