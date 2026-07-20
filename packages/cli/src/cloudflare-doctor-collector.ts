import { CONTROL_PLANE_MIGRATION_MANIFEST } from "./cloudflare-d1-migration-setup-adapter.js";
import { parseDoctorReportV2, type DoctorReportV2, type DoctorRuntimePrimitive } from "./doctor.js";

export interface CloudflareDoctorMigrationReader {
  listApplied: (databaseId: string) => Promise<readonly string[]> | readonly string[];
}

export interface CloudflareDoctorBindingPresence {
  read: (databaseId: string) => Promise<DoctorReportV2["bindings"]> | DoctorReportV2["bindings"];
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
  databaseId: string;
  bindingPresence: CloudflareDoctorBindingPresence;
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
        const [bindingPresence, appliedNames, adminCursorSecret] = await Promise.all([
          params.bindingPresence.read(params.databaseId),
          params.migrationReader.listApplied(params.databaseId),
          params.secretPresence.has("ADMIN_CURSOR_SECRET")
        ]);
        const bindings = parseBindingPresence(bindingPresence);
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

function parseBindingPresence(value: unknown): DoctorReportV2["bindings"] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["DB", "ADMIN_MUTATION_RATE_LIMITER_DO"]) ||
    typeof value.DB !== "boolean" ||
    typeof value.ADMIN_MUTATION_RATE_LIMITER_DO !== "boolean"
  ) {
    throw invalidResponse();
  }
  return { DB: value.DB, ADMIN_MUTATION_RATE_LIMITER_DO: value.ADMIN_MUTATION_RATE_LIMITER_DO };
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
    !hasOnlyKeys(value, [
      "databaseId",
      "bindingPresence",
      "migrationReader",
      "secretPresence",
      "runtime"
    ]) ||
    !["databaseId", "bindingPresence", "migrationReader", "secretPresence", "runtime"].every(
      (key) => key in value
    ) ||
    !isDatabaseId(value.databaseId) ||
    !isRecord(value.bindingPresence) ||
    typeof value.bindingPresence.read !== "function" ||
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

function isDatabaseId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  );
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
