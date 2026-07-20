import { createHash } from "node:crypto";
import { CloudflareApiError, type CloudflareApiTransport } from "./cloudflare-api-transport.js";
import {
  deriveSetupOperationIdempotencyKey,
  type SetupProviderAdapter,
  type SetupReconcileResult
} from "./setup-executor.js";
import type { SetupOperation } from "./setup-plan.js";

const D1_CREATE_OPERATION_ID = "create:control-plane-d1";
const D1_DECLARE_OPERATION_ID = "declare:app-database-boundary";
const D1_RESOURCE_PREFIX = "d1:";

export type CloudflareD1DatabaseConfiguration =
  | {
      mode: "create";
      baseName: string;
      jurisdiction?: "eu" | "fedramp";
    }
  | {
      mode: "adopt";
      databaseId: string;
    };

export type CloudflareD1SetupAdapterErrorCode =
  | "cloudflare_d1_invalid_configuration"
  | "cloudflare_d1_invalid_request"
  | "cloudflare_d1_invalid_response"
  | "cloudflare_d1_ownership_mismatch"
  | "cloudflare_d1_unsupported_operation";

export class CloudflareD1SetupAdapterError extends Error {
  override readonly name = "CloudflareD1SetupAdapterError";

  constructor(readonly code: CloudflareD1SetupAdapterErrorCode) {
    super(code);
  }

  toJSON(): { code: CloudflareD1SetupAdapterErrorCode } {
    return { code: this.code };
  }
}

export function createCloudflareD1SetupAdapter(params: {
  transport: CloudflareApiTransport;
  database: CloudflareD1DatabaseConfiguration;
}): SetupProviderAdapter {
  validateConfiguration(params);

  return {
    reconcile: async (request): Promise<SetupReconcileResult> => {
      validateOperationRequest(request, "reconcile");
      if (isAppDatabaseDeclaration(request.operation)) return { disposition: "applied" };
      if (!isControlPlaneD1Create(request.operation)) throw unsupportedOperation();

      if (params.database.mode === "adopt") {
        const database = parseD1Database(
          await params.transport.request({
            method: "GET",
            pathSegments: ["d1", "database", params.database.databaseId],
            query: { fields: "uuid,name" }
          })
        );
        if (database.uuid !== params.database.databaseId) throw invalidResponse();
        return { disposition: "adopted", resourceRef: resourceRef(database.uuid) };
      }

      const name = deriveDatabaseName(params.database.baseName, request.idempotencyKey);
      const existing = parseD1DatabaseList(
        await params.transport.request({
          method: "GET",
          pathSegments: ["d1", "database"],
          query: { name, page: "1", per_page: "10" }
        })
      ).filter((database) => database.name === name);
      if (existing.length > 1) throw invalidResponse();
      if (existing.length === 1) {
        const database = existing[0];
        if (database === undefined) throw invalidResponse();
        return { disposition: "created", resourceRef: resourceRef(database.uuid) };
      }

      const created = parseD1Database(
        await params.transport.request({
          method: "POST",
          pathSegments: ["d1", "database"],
          body: {
            name,
            ...(params.database.jurisdiction === undefined
              ? {}
              : { jurisdiction: params.database.jurisdiction })
          }
        })
      );
      if (created.name !== name) throw invalidResponse();
      return { disposition: "created", resourceRef: resourceRef(created.uuid) };
    },

    cleanupCreated: async (request): Promise<void> => {
      validateOperationRequest(request, "cleanup");
      if (!isControlPlaneD1Create(request.operation) || params.database.mode !== "create") {
        throw invalidRequest();
      }
      const databaseId = parseResourceRef(request.resourceRef);
      const reconcileKey = deriveSetupOperationIdempotencyKey(
        request.runId,
        request.operation.id,
        "reconcile"
      );
      const expectedName = deriveDatabaseName(params.database.baseName, reconcileKey);

      let database: D1Database;
      try {
        database = parseD1Database(
          await params.transport.request({
            method: "GET",
            pathSegments: ["d1", "database", databaseId],
            query: { fields: "uuid,name" }
          })
        );
      } catch (error) {
        // A lost DELETE response resumes by observing 404. Treat only that exact stable transport
        // outcome as success; every other lookup failure remains fail-closed for operator review.
        if (isNotFound(error)) return;
        throw error;
      }
      if (database.uuid !== databaseId || database.name !== expectedName) {
        throw new CloudflareD1SetupAdapterError("cloudflare_d1_ownership_mismatch");
      }

      try {
        const result = await params.transport.request({
          method: "DELETE",
          pathSegments: ["d1", "database", databaseId]
        });
        if (result !== null && (!isRecord(result) || Object.keys(result).length !== 0)) {
          throw invalidResponse();
        }
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
    }
  };
}

interface D1Database {
  uuid: string;
  name: string;
}

function validateConfiguration(params: { transport: unknown; database: unknown }): void {
  if (!isRecord(params.transport) || typeof params.transport.request !== "function") {
    throw invalidConfiguration();
  }
  if (
    !isRecord(params.database) ||
    (params.database.mode !== "create" && params.database.mode !== "adopt")
  ) {
    throw invalidConfiguration();
  }
  if (params.database.mode === "create") {
    if (
      !hasOnlyKeys(params.database, ["mode", "baseName", "jurisdiction"]) ||
      !isBaseName(params.database.baseName) ||
      (params.database.jurisdiction !== undefined &&
        params.database.jurisdiction !== "eu" &&
        params.database.jurisdiction !== "fedramp")
    ) {
      throw invalidConfiguration();
    }
    return;
  }
  if (
    !hasOnlyKeys(params.database, ["mode", "databaseId"]) ||
    !isD1DatabaseId(params.database.databaseId)
  ) {
    throw invalidConfiguration();
  }
}

function validateOperationRequest(
  request: unknown,
  action: "reconcile" | "cleanup"
): asserts request is {
  runId: string;
  idempotencyKey: string;
  attempt?: "initial" | "resume";
  operation: SetupOperation;
} {
  if (
    !isRecord(request) ||
    !hasOnlyKeys(
      request,
      action === "reconcile"
        ? ["runId", "idempotencyKey", "attempt", "operation"]
        : ["runId", "idempotencyKey", "operation", "resourceRef"]
    ) ||
    (action === "reconcile"
      ? request.attempt !== "initial" && request.attempt !== "resume"
      : request.attempt !== undefined) ||
    !isSafeIdentifier(request.runId, 128) ||
    !isRuntimeSetupOperation(request.operation) ||
    request.idempotencyKey !==
      deriveSetupOperationIdempotencyKey(request.runId, request.operation.id, action)
  ) {
    throw invalidRequest();
  }
}

function isRuntimeSetupOperation(value: unknown): value is SetupOperation {
  return (
    isRecord(value) &&
    isSafeIdentifier(value.id, 256) &&
    typeof value.kind === "string" &&
    typeof value.action === "string" &&
    isSafeText(value.logicalName, 256) &&
    (value.implementationStatus === "implemented" ||
      value.implementationStatus === "integration-required") &&
    Array.isArray(value.dependsOn) &&
    value.dependsOn.every((dependency) => isSafeIdentifier(dependency, 256))
  );
}

function deriveDatabaseName(baseName: string, reconcileKey: string): string {
  // The provider has no documented mutation idempotency key. A 96-bit digest of the persisted
  // operation key makes the create target stable across crashes while avoiding disclosure of the
  // full setup key in Cloudflare resource names.
  const suffix = createHash("sha256").update(reconcileKey).digest("hex").slice(0, 24);
  return `${baseName}-${suffix}`;
}

function parseD1DatabaseList(value: unknown): D1Database[] {
  if (!Array.isArray(value) || value.length > 10) throw invalidResponse();
  return value.map(parseD1Database);
}

function parseD1Database(value: unknown): D1Database {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "uuid",
      "name",
      "created_at",
      "file_size",
      "jurisdiction",
      "num_tables",
      "read_replication",
      "running_in_region",
      "version"
    ]) ||
    !isD1DatabaseId(value.uuid) ||
    !isD1Name(value.name) ||
    (value.created_at !== undefined && !isSafeText(value.created_at, 64)) ||
    (value.file_size !== undefined && !isNonNegativeInteger(value.file_size)) ||
    (value.jurisdiction !== undefined &&
      value.jurisdiction !== "eu" &&
      value.jurisdiction !== "fedramp") ||
    (value.num_tables !== undefined && !isNonNegativeInteger(value.num_tables)) ||
    (value.read_replication !== undefined && !isReadReplication(value.read_replication)) ||
    (value.running_in_region !== undefined && !isSafeText(value.running_in_region, 64)) ||
    (value.version !== undefined && !isSafeText(value.version, 64))
  ) {
    throw invalidResponse();
  }
  return { uuid: value.uuid, name: value.name };
}

function isReadReplication(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["mode"]) &&
    (value.mode === "auto" || value.mode === "disabled")
  );
}

function isControlPlaneD1Create(operation: SetupOperation): boolean {
  return (
    operation.id === D1_CREATE_OPERATION_ID &&
    operation.kind === "d1" &&
    operation.action === "create" &&
    operation.logicalName === "DB" &&
    operation.implementationStatus === "implemented"
  );
}

function isAppDatabaseDeclaration(operation: SetupOperation): boolean {
  return (
    operation.id === D1_DECLARE_OPERATION_ID &&
    operation.kind === "d1" &&
    operation.action === "declare" &&
    operation.logicalName === "APP_<APP_ID>_DB" &&
    operation.implementationStatus === "implemented"
  );
}

function parseResourceRef(value: string): string {
  if (!value.startsWith(D1_RESOURCE_PREFIX)) throw invalidRequest();
  const databaseId = value.slice(D1_RESOURCE_PREFIX.length);
  if (!isD1DatabaseId(databaseId)) throw invalidRequest();
  return databaseId;
}

function resourceRef(databaseId: string): string {
  return `${D1_RESOURCE_PREFIX}${databaseId}`;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof CloudflareApiError &&
    error.code === "cloudflare_api_request_failed" &&
    error.status === 404
  );
}

function isBaseName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{1,46}[a-z0-9]$/u.test(value);
}

function isD1DatabaseId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  );
}

function isD1Name(value: unknown): value is string {
  return isSafeText(value, 256);
}

function isSafeIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(value)
  );
}

function isSafeText(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return false;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 32 || code === 127)) return false;
  }
  return true;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function invalidConfiguration(): CloudflareD1SetupAdapterError {
  return new CloudflareD1SetupAdapterError("cloudflare_d1_invalid_configuration");
}

function invalidRequest(): CloudflareD1SetupAdapterError {
  return new CloudflareD1SetupAdapterError("cloudflare_d1_invalid_request");
}

function invalidResponse(): CloudflareD1SetupAdapterError {
  return new CloudflareD1SetupAdapterError("cloudflare_d1_invalid_response");
}

function unsupportedOperation(): CloudflareD1SetupAdapterError {
  return new CloudflareD1SetupAdapterError("cloudflare_d1_unsupported_operation");
}
