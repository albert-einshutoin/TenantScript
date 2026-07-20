import { link, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface ProductionWranglerInputV1 {
  version: 1;
  workerName: string;
  compatibilityDate: string;
  database: {
    name: string;
    id: string;
  };
}

export function parseProductionWranglerInput(value: unknown): ProductionWranglerInputV1 {
  if (!isExactRecord(value, ["version", "workerName", "compatibilityDate", "database"])) {
    throw invalidInput();
  }
  if (
    value.version !== 1 ||
    !isWorkerName(value.workerName) ||
    !isUtcDate(value.compatibilityDate) ||
    !isExactRecord(value.database, ["name", "id"]) ||
    !isDatabaseName(value.database.name) ||
    !isDatabaseId(value.database.id)
  ) {
    throw invalidInput();
  }
  return {
    version: 1,
    workerName: value.workerName,
    compatibilityDate: value.compatibilityDate,
    database: { name: value.database.name, id: value.database.id }
  };
}

export function renderProductionWranglerConfig(input: ProductionWranglerInputV1): string {
  const parsed = parseProductionWranglerInput(input);
  // Build an exact deployment DTO instead of merging operator input. This keeps credentials and
  // future, not-yet-wired bindings from accidentally crossing into the generated config.
  const config = {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: parsed.workerName,
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
    migrations: [
      {
        tag: "v1",
        new_sqlite_classes: ["AdminMutationRateLimitDurableObject"]
      }
    ]
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

function isWorkerName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);
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
