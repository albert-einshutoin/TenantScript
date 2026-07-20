import type { CloudflareApiTransport } from "./cloudflare-api-transport.js";
import { CONTROL_PLANE_MIGRATION_MANIFEST } from "./cloudflare-d1-migration-setup-adapter.js";
import { parseDoctorReportV2, type DoctorReportV2, type DoctorRuntimePrimitive } from "./doctor.js";

const MAX_BINDINGS = 256;
const SETTINGS_KEYS = [
  "annotations",
  "bindings",
  "cache_options",
  "compatibility_date",
  "compatibility_flags",
  "exports",
  "limits",
  "logpush",
  "migrations",
  "observability",
  "placement",
  "tail_consumers",
  "tags",
  "usage_model"
] as const;

export interface CloudflareDoctorMigrationReader {
  listApplied: (databaseId: string) => Promise<readonly string[]> | readonly string[];
}

export interface CloudflareDoctorSecretPresence {
  has: (name: "ADMIN_CURSOR_SECRET") => Promise<boolean> | boolean;
}

export interface CloudflareDoctorCollector {
  collect: () => Promise<DoctorReportV2>;
}

export type CloudflareDoctorCollectorErrorCode =
  | "cloudflare_doctor_invalid_configuration"
  | "cloudflare_doctor_invalid_response"
  | "cloudflare_doctor_collection_failed";

export class CloudflareDoctorCollectorError extends Error {
  override readonly name = "CloudflareDoctorCollectorError";

  constructor(readonly code: CloudflareDoctorCollectorErrorCode) {
    super(code);
  }

  toJSON(): { code: CloudflareDoctorCollectorErrorCode } {
    return { code: this.code };
  }
}

export function createCloudflareDoctorCollector(params: {
  transport: CloudflareApiTransport;
  workerName: string;
  databaseId: string;
  migrationReader: CloudflareDoctorMigrationReader;
  secretPresence: CloudflareDoctorSecretPresence;
  runtime: {
    configured: DoctorRuntimePrimitive;
    supported: readonly DoctorRuntimePrimitive[];
  };
}): CloudflareDoctorCollector {
  validateConfiguration(params);
  const expectedNames = CONTROL_PLANE_MIGRATION_MANIFEST.map(({ name }) => name);
  const expected = expectedNames.map((_, index) => index + 1);

  return {
    collect: async (): Promise<DoctorReportV2> => {
      try {
        // These independent reads are joined before parsing so the report is emitted atomically:
        // callers never receive a partially collected snapshot after one trusted source fails.
        const [settings, appliedNames, adminCursorSecret] = await Promise.all([
          params.transport.request({
            method: "GET",
            pathSegments: ["workers", "scripts", params.workerName, "settings"]
          }),
          params.migrationReader.listApplied(params.databaseId),
          params.secretPresence.has("ADMIN_CURSOR_SECRET")
        ]);
        const bindings = parseBindings(settings, params.databaseId);
        const applied = parseAppliedMigrations(appliedNames, expectedNames);
        if (typeof adminCursorSecret !== "boolean") throw invalidResponse();

        return parseDoctorReportV2({
          version: 2,
          profile: "production",
          bindings,
          migrations: { expected, applied },
          // Cloudflare's read endpoints accept overlapping read/write permission sets. A successful
          // request therefore proves resource visibility, not the exact deployment authority.
          permissions: {
            D1_READ: "unverified",
            D1_WRITE: "unverified",
            WORKERS_SCRIPTS_WRITE: "unverified"
          },
          runtime: {
            configured: params.runtime.configured,
            supported: [...params.runtime.supported]
          },
          secrets: { ADMIN_CURSOR_SECRET: adminCursorSecret }
        });
      } catch (error) {
        if (error instanceof CloudflareDoctorCollectorError) throw error;
        throw collectionFailed();
      }
    }
  };
}

function parseBindings(value: unknown, databaseId: string): DoctorReportV2["bindings"] {
  if (!isRecord(value) || !hasOnlyKeys(value, SETTINGS_KEYS)) {
    throw invalidResponse();
  }
  const bindingValues = value.bindings ?? [];
  if (!Array.isArray(bindingValues) || bindingValues.length > MAX_BINDINGS) {
    throw invalidResponse();
  }

  let database = false;
  let rateLimiter = false;
  for (const binding of bindingValues as unknown[]) {
    if (!isRecord(binding) || !isBindingName(binding.name) || !isBindingType(binding.type)) {
      throw invalidResponse();
    }
    if (binding.name === "DB") {
      if (
        database ||
        binding.type !== "d1" ||
        !hasOnlyKeys(binding, ["name", "type", "database_id", "id"]) ||
        binding.database_id !== databaseId
      ) {
        throw invalidResponse();
      }
      database = true;
    }
    if (binding.name === "ADMIN_MUTATION_RATE_LIMITER_DO") {
      if (
        rateLimiter ||
        binding.type !== "durable_object_namespace" ||
        !hasOnlyKeys(binding, [
          "name",
          "type",
          "class_name",
          "dispatch_namespace",
          "environment",
          "namespace_id",
          "script_name"
        ]) ||
        binding.class_name !== "AdminMutationRateLimitDurableObject"
      ) {
        throw invalidResponse();
      }
      rateLimiter = true;
    }
  }
  return { DB: database, ADMIN_MUTATION_RATE_LIMITER_DO: rateLimiter };
}

function parseAppliedMigrations(value: unknown, expectedNames: readonly string[]): number[] {
  if (!Array.isArray(value) || value.length > expectedNames.length) throw invalidResponse();
  const applied: number[] = [];
  for (const [index, name] of (value as unknown[]).entries()) {
    if (name !== expectedNames[index]) throw invalidResponse();
    applied.push(index + 1);
  }
  return applied;
}

function validateConfiguration(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "transport",
      "workerName",
      "databaseId",
      "migrationReader",
      "secretPresence",
      "runtime"
    ]) ||
    !isRecord(value.transport) ||
    typeof value.transport.request !== "function" ||
    !isWorkerName(value.workerName) ||
    !isDatabaseId(value.databaseId) ||
    !isRecord(value.migrationReader) ||
    typeof value.migrationReader.listApplied !== "function" ||
    !isRecord(value.secretPresence) ||
    typeof value.secretPresence.has !== "function" ||
    !isRecord(value.runtime) ||
    !hasExactKeys(value.runtime, ["configured", "supported"]) ||
    !isRuntimePrimitive(value.runtime.configured) ||
    !Array.isArray(value.runtime.supported) ||
    value.runtime.supported.length === 0 ||
    !value.runtime.supported.every(isRuntimePrimitive) ||
    new Set(value.runtime.supported).size !== value.runtime.supported.length
  ) {
    throw invalidConfiguration();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
}

function isWorkerName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);
}

function isDatabaseId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  );
}

function isBindingName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value);
}

function isBindingType(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value);
}

function isRuntimePrimitive(value: unknown): value is DoctorRuntimePrimitive {
  return (
    value === "cloudflare-workers" ||
    value === "dynamic-workers" ||
    value === "workers-for-platforms"
  );
}

function invalidConfiguration(): CloudflareDoctorCollectorError {
  return new CloudflareDoctorCollectorError("cloudflare_doctor_invalid_configuration");
}

function invalidResponse(): CloudflareDoctorCollectorError {
  return new CloudflareDoctorCollectorError("cloudflare_doctor_invalid_response");
}

function collectionFailed(): CloudflareDoctorCollectorError {
  return new CloudflareDoctorCollectorError("cloudflare_doctor_collection_failed");
}
