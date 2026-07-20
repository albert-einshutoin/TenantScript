import { readFile } from "node:fs/promises";
import {
  CloudflareApiError,
  createCloudflareApiTransport,
  type CloudflareApiTransport,
  type CloudflareFetch
} from "./cloudflare-api-transport.js";
import { createCloudflareDoctorCollector } from "./cloudflare-doctor-collector.js";
import { createCloudflareD1MigrationReader } from "./cloudflare-wrangler-d1-migration-runner.js";
import type { CliRuntime } from "./cli-runtime.js";

export function createBinaryDoctorRuntime(
  environment: Record<string, string | undefined>,
  fetchImpl: CloudflareFetch,
  readConfig: (path: string, encoding: "utf8") => Promise<string> = readFile
): CliRuntime {
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = environment.CLOUDFLARE_API_TOKEN;
  if (accountId === undefined || apiToken === undefined) return {};

  try {
    const transport = createCloudflareApiTransport({ accountId, apiToken, fetch: fetchImpl });
    return {
      collectCloudflareDoctor: ({ workerName, databaseId, configPath, runtime }) =>
        createCloudflareDoctorCollector({
          databaseId,
          bindingPresence: {
            read: async (expectedDatabaseId) =>
              parseWranglerBindingPresence(await readConfig(configPath, "utf8"), expectedDatabaseId)
          },
          migrationReader: createCloudflareD1MigrationReader({ transport, databaseId }),
          secretPresence: createSecretPresence(transport, workerName),
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

function createSecretPresence(
  transport: CloudflareApiTransport,
  workerName: string
): { has: (name: "ADMIN_CURSOR_SECRET") => Promise<boolean> } {
  return {
    has: async (name) => {
      try {
        const result = await transport.request({
          method: "GET",
          pathSegments: ["workers", "scripts", workerName, "secrets", name]
        });
        if (
          !isRecord(result) ||
          !hasExactKeys(result, ["name", "type"]) ||
          result.name !== name ||
          result.type !== "secret_text"
        ) {
          throw new Error("invalid secret metadata");
        }
        return true;
      } catch (error) {
        if (error instanceof CloudflareApiError && error.status === 404) return false;
        throw error;
      }
    }
  };
}

function parseWranglerBindingPresence(
  source: string,
  databaseId: string
): { DB: boolean; ADMIN_MUTATION_RATE_LIMITER_DO: boolean } {
  if (Buffer.byteLength(source, "utf8") > 65_536) throw new Error("invalid Wrangler config");
  const value: unknown = JSON.parse(source);
  if (!isRecord(value)) throw new Error("invalid Wrangler config");
  const databases = value.d1_databases ?? [];
  const durableObjects = isRecord(value.durable_objects)
    ? (value.durable_objects.bindings ?? [])
    : [];
  if (!Array.isArray(databases) || !Array.isArray(durableObjects)) {
    throw new Error("invalid Wrangler config");
  }
  const matchingDatabases = databases.filter(
    (entry) => isRecord(entry) && entry.binding === "DB" && entry.database_id === databaseId
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
