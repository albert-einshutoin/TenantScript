import { lstat, open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { createCloudflareApiTransport, type CloudflareFetch } from "./cloudflare-api-transport.js";
import { createCloudflareDoctorCollector } from "./cloudflare-doctor-collector.js";
import { createCloudflareD1MigrationReader } from "./cloudflare-wrangler-d1-migration-runner.js";
import type { CliRuntime } from "./cli-runtime.js";

export function createBinaryDoctorRuntime(
  environment: Record<string, string | undefined>,
  fetchImpl: CloudflareFetch,
  readConfig: (path: string) => Promise<string> = readBoundedWranglerConfig
): CliRuntime {
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = environment.CLOUDFLARE_API_TOKEN;
  if (accountId === undefined || apiToken === undefined) return {};

  try {
    const transport = createCloudflareApiTransport({ accountId, apiToken, fetch: fetchImpl });
    return {
      collectCloudflareDoctor: ({ databaseId, configPath, adminCursorSecretPresent, runtime }) =>
        createCloudflareDoctorCollector({
          databaseId,
          bindingPresence: {
            read: async (expectedDatabaseId) =>
              parseWranglerBindingPresence(await readConfig(configPath), expectedDatabaseId)
          },
          migrationReader: createCloudflareD1MigrationReader({ transport, databaseId }),
          // Cloudflare secret response schemas may include secret text. The binary therefore
          // accepts only an operator-provided boolean and never probes any Worker secret endpoint.
          secretPresence: { has: () => adminCursorSecretPresent },
          // This composition inspects one ordinary Worker deployment. Other runtime primitives
          // remain visible as unsupported until their own authoritative collectors exist.
          runtime: { configured: runtime, supported: ["cloudflare-workers"] }
        }).collect()
    };
  } catch {
    // Environment values are private deployment inputs. Invalid credentials/configuration are
    // represented only by the absence of the live dependency and never reflected by the CLI.
    return {};
  }
}

const MAX_WRANGLER_CONFIG_BYTES = 65_536;

async function readBoundedWranglerConfig(configPath: string): Promise<string> {
  const sourceStat = await lstat(configPath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("invalid Wrangler config");
  }
  const repositoryRoot = await realpath(process.cwd());
  const resolvedPath = await realpath(resolve(repositoryRoot, configPath));
  if (!resolvedPath.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error("invalid Wrangler config");
  }
  const handle = await open(resolvedPath, "r");
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new Error("invalid Wrangler config");
    // Read one byte beyond the public limit so oversized files are rejected without ever being
    // fully materialized. This also keeps FIFOs and device files outside the read boundary.
    const buffer = Buffer.alloc(MAX_WRANGLER_CONFIG_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_WRANGLER_CONFIG_BYTES) throw new Error("invalid Wrangler config");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function parseWranglerBindingPresence(
  source: string,
  databaseId: string
): { DB: boolean; ADMIN_MUTATION_RATE_LIMITER_DO: boolean } {
  if (Buffer.byteLength(source, "utf8") > MAX_WRANGLER_CONFIG_BYTES) {
    throw new Error("invalid Wrangler config");
  }
  const parseErrors: ParseError[] = [];
  const value: unknown = parse(source, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false
  });
  if (parseErrors.length > 0) throw new Error("invalid Wrangler config");
  if (!isRecord(value)) throw new Error("invalid Wrangler config");
  const databases = value.d1_databases ?? [];
  const durableObjects = isRecord(value.durable_objects)
    ? (value.durable_objects.bindings ?? [])
    : [];
  if (!Array.isArray(databases) || !Array.isArray(durableObjects)) {
    throw new Error("invalid Wrangler config");
  }
  const matchingDatabases = databases.filter(
    (entry) =>
      isRecord(entry) &&
      entry.binding === "DB" &&
      typeof entry.database_id === "string" &&
      normalizeDatabaseId(entry.database_id) === normalizeDatabaseId(databaseId)
  );
  const targetDatabaseBindings = databases.filter(
    (entry) => isRecord(entry) && entry.binding === "DB"
  );
  const matchingDurableObjects = durableObjects.filter(
    (entry) =>
      isRecord(entry) &&
      entry.name === "ADMIN_MUTATION_RATE_LIMITER_DO" &&
      entry.class_name === "AdminMutationRateLimitDurableObject"
  );
  const targetDurableObjectBindings = durableObjects.filter(
    (entry) => isRecord(entry) && entry.name === "ADMIN_MUTATION_RATE_LIMITER_DO"
  );
  if (targetDatabaseBindings.length > 1 || targetDurableObjectBindings.length > 1) {
    throw new Error("invalid Wrangler config");
  }
  return {
    DB: matchingDatabases.length === 1,
    ADMIN_MUTATION_RATE_LIMITER_DO: matchingDurableObjects.length === 1
  };
}

function normalizeDatabaseId(value: string): string {
  return value.replaceAll("-", "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
