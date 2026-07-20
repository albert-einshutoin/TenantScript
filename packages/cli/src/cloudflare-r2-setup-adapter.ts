import { createHash } from "node:crypto";
import { CloudflareApiError, type CloudflareApiTransport } from "./cloudflare-api-transport.js";
import {
  deriveSetupOperationIdempotencyKey,
  type SetupProviderAdapter,
  type SetupReconcileResult
} from "./setup-executor.js";
import type { SetupOperation } from "./setup-plan.js";

const ARTIFACT_OPERATION_ID = "create:artifact-r2";
const ARCHIVE_OPERATION_ID = "create:execution-archive-r2";
const R2_RESOURCE_PREFIX = "r2:";

type R2LocationHint = "apac" | "eeur" | "enam" | "weur" | "wnam" | "oc";
type R2Jurisdiction = "default" | "eu" | "fedramp";
type R2StorageClass = "Standard" | "InfrequentAccess";

export type CloudflareR2BucketConfiguration =
  | {
      mode: "create";
      baseName: string;
      locationHint?: R2LocationHint;
      jurisdiction?: R2Jurisdiction;
      storageClass?: R2StorageClass;
    }
  | {
      mode: "adopt";
      bucketName: string;
      jurisdiction?: R2Jurisdiction;
    };

export interface CloudflareR2SetupBucketsConfiguration {
  artifacts: CloudflareR2BucketConfiguration;
  executionArchive: CloudflareR2BucketConfiguration;
}

export type CloudflareR2SetupAdapterErrorCode =
  | "cloudflare_r2_invalid_configuration"
  | "cloudflare_r2_invalid_request"
  | "cloudflare_r2_invalid_response"
  | "cloudflare_r2_ownership_mismatch"
  | "cloudflare_r2_unsupported_operation";

export class CloudflareR2SetupAdapterError extends Error {
  override readonly name = "CloudflareR2SetupAdapterError";

  constructor(readonly code: CloudflareR2SetupAdapterErrorCode) {
    super(code);
  }

  toJSON(): { code: CloudflareR2SetupAdapterErrorCode } {
    return { code: this.code };
  }
}

export function createCloudflareR2SetupAdapter(params: {
  transport: CloudflareApiTransport;
  buckets: CloudflareR2SetupBucketsConfiguration;
}): SetupProviderAdapter {
  validateConfiguration(params);

  return {
    reconcile: async (request): Promise<SetupReconcileResult> => {
      validateOperationRequest(request, "reconcile");
      const configuration = configurationFor(params.buckets, request.operation);

      if (configuration.mode === "adopt") {
        const bucket = parseR2Bucket(
          await getBucket(params.transport, configuration.bucketName, configuration.jurisdiction)
        );
        validateObservedBucket(bucket, configuration.bucketName, configuration);
        return { disposition: "adopted", resourceRef: resourceRef(bucket.name) };
      }

      const name = deriveBucketName(configuration.baseName, request.idempotencyKey);
      try {
        const existing = parseR2Bucket(
          await getBucket(params.transport, name, configuration.jurisdiction)
        );
        validateObservedBucket(existing, name, configuration);
        return { disposition: "created", resourceRef: resourceRef(existing.name) };
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }

      try {
        const created = parseR2Bucket(
          await params.transport.request({
            method: "POST",
            pathSegments: ["r2", "buckets"],
            ...(configuration.jurisdiction === undefined
              ? {}
              : { r2Jurisdiction: configuration.jurisdiction }),
            body: {
              name,
              ...(configuration.locationHint === undefined
                ? {}
                : { locationHint: configuration.locationHint }),
              ...(configuration.storageClass === undefined
                ? {}
                : { storageClass: configuration.storageClass })
            }
          })
        );
        validateObservedBucket(created, name, configuration);
        return { disposition: "created", resourceRef: resourceRef(created.name) };
      } catch (mutationError) {
        if (!isAmbiguousMutationFailure(mutationError)) throw mutationError;
        try {
          // A network/5xx or malformed success response can arrive after Cloudflare committed the
          // create. Reconcile once by read; never replay the mutation or invent another name.
          const observed = parseR2Bucket(
            await getBucket(params.transport, name, configuration.jurisdiction)
          );
          validateObservedBucket(observed, name, configuration);
          return { disposition: "created", resourceRef: resourceRef(observed.name) };
        } catch (reconcileError) {
          if (isNotFound(reconcileError)) throw mutationError;
          throw reconcileError;
        }
      }
    },

    cleanupCreated: async (request): Promise<void> => {
      validateOperationRequest(request, "cleanup");
      const configuration = configurationFor(params.buckets, request.operation);
      if (configuration.mode !== "create") throw invalidRequest();

      const bucketName = parseResourceRef(request.resourceRef);
      const reconcileKey = deriveSetupOperationIdempotencyKey(
        request.runId,
        request.operation.id,
        "reconcile"
      );
      const expectedName = deriveBucketName(configuration.baseName, reconcileKey);
      if (bucketName !== expectedName) throw invalidRequest();

      let bucket: R2Bucket;
      try {
        bucket = parseR2Bucket(
          await getBucket(params.transport, bucketName, configuration.jurisdiction)
        );
      } catch (error) {
        // A missing bucket is success only for the stable 404 outcome. This makes a lost DELETE
        // response resumable without hiding authorization, transport, or provider failures.
        if (isNotFound(error)) return;
        throw error;
      }
      try {
        validateObservedBucket(bucket, expectedName, configuration);
      } catch (error) {
        if (error instanceof CloudflareR2SetupAdapterError) {
          throw new CloudflareR2SetupAdapterError("cloudflare_r2_ownership_mismatch");
        }
        throw error;
      }

      try {
        const result = await params.transport.request({
          method: "DELETE",
          pathSegments: ["r2", "buckets", bucketName],
          ...(configuration.jurisdiction === undefined
            ? {}
            : { r2Jurisdiction: configuration.jurisdiction })
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

interface R2Bucket {
  name: string;
  jurisdiction?: R2Jurisdiction;
  storageClass?: R2StorageClass;
}

function getBucket(
  transport: CloudflareApiTransport,
  bucketName: string,
  jurisdiction: R2Jurisdiction | undefined
): Promise<unknown> {
  return transport.request({
    method: "GET",
    pathSegments: ["r2", "buckets", bucketName],
    ...(jurisdiction === undefined ? {} : { r2Jurisdiction: jurisdiction })
  });
}

function validateConfiguration(params: unknown): asserts params is {
  transport: CloudflareApiTransport;
  buckets: CloudflareR2SetupBucketsConfiguration;
} {
  if (
    !isRecord(params) ||
    !hasOnlyKeys(params, ["transport", "buckets"]) ||
    !isRecord(params.transport) ||
    typeof params.transport.request !== "function" ||
    !isRecord(params.buckets) ||
    !hasOnlyKeys(params.buckets, ["artifacts", "executionArchive"]) ||
    !isBucketConfiguration(params.buckets.artifacts) ||
    !isBucketConfiguration(params.buckets.executionArchive)
  ) {
    throw invalidConfiguration();
  }
  const artifacts = params.buckets.artifacts;
  const archive = params.buckets.executionArchive;
  if (
    artifacts.mode === "adopt" &&
    archive.mode === "adopt" &&
    artifacts.bucketName === archive.bucketName
  ) {
    throw invalidConfiguration();
  }
}

function isBucketConfiguration(value: unknown): value is CloudflareR2BucketConfiguration {
  if (!isRecord(value) || (value.mode !== "create" && value.mode !== "adopt")) return false;
  if (value.mode === "create") {
    return (
      hasOnlyKeys(value, ["mode", "baseName", "locationHint", "jurisdiction", "storageClass"]) &&
      isBaseName(value.baseName) &&
      (value.locationHint === undefined || isLocationHint(value.locationHint)) &&
      (value.jurisdiction === undefined || isJurisdiction(value.jurisdiction)) &&
      (value.storageClass === undefined || isStorageClass(value.storageClass))
    );
  }
  return (
    hasOnlyKeys(value, ["mode", "bucketName", "jurisdiction"]) &&
    isBucketName(value.bucketName) &&
    (value.jurisdiction === undefined || isJurisdiction(value.jurisdiction))
  );
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

function configurationFor(
  buckets: CloudflareR2SetupBucketsConfiguration,
  operation: SetupOperation
): CloudflareR2BucketConfiguration {
  if (isArtifactOperation(operation)) return buckets.artifacts;
  if (isArchiveOperation(operation)) return buckets.executionArchive;
  throw unsupportedOperation();
}

function isArtifactOperation(operation: SetupOperation): boolean {
  return (
    operation.id === ARTIFACT_OPERATION_ID &&
    operation.kind === "r2" &&
    operation.action === "create" &&
    operation.logicalName === "ARTIFACTS" &&
    operation.implementationStatus === "implemented"
  );
}

function isArchiveOperation(operation: SetupOperation): boolean {
  return (
    operation.id === ARCHIVE_OPERATION_ID &&
    operation.kind === "r2" &&
    operation.action === "create" &&
    operation.logicalName === "EXECUTION_ARCHIVE" &&
    operation.implementationStatus === "implemented"
  );
}

function deriveBucketName(baseName: string, reconcileKey: string): string {
  // R2 create has no documented idempotency key. The persisted operation key provides a stable
  // crash-resume target, while the 96-bit digest avoids exposing the full key in a provider name.
  const suffix = createHash("sha256").update(reconcileKey).digest("hex").slice(0, 24);
  return `${baseName}-${suffix}`;
}

function parseR2Bucket(value: unknown): R2Bucket {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["creation_date", "jurisdiction", "location", "name", "storage_class"]) ||
    !isBucketName(value.name) ||
    (value.creation_date !== undefined && !isSafeText(value.creation_date, 64)) ||
    (value.jurisdiction !== undefined && !isJurisdiction(value.jurisdiction)) ||
    (value.location !== undefined && !isLocationHint(value.location)) ||
    (value.storage_class !== undefined && !isStorageClass(value.storage_class))
  ) {
    throw invalidResponse();
  }
  return {
    name: value.name,
    ...(value.jurisdiction === undefined ? {} : { jurisdiction: value.jurisdiction }),
    ...(value.storage_class === undefined ? {} : { storageClass: value.storage_class })
  };
}

function validateObservedBucket(
  bucket: R2Bucket,
  expectedName: string,
  configuration: CloudflareR2BucketConfiguration
): void {
  if (bucket.name !== expectedName) throw invalidResponse();
  const expectedJurisdiction = configuration.jurisdiction ?? "default";
  if (
    (configuration.jurisdiction !== undefined && bucket.jurisdiction !== expectedJurisdiction) ||
    (configuration.jurisdiction === undefined &&
      bucket.jurisdiction !== undefined &&
      bucket.jurisdiction !== expectedJurisdiction)
  ) {
    throw invalidResponse();
  }
  if (configuration.mode === "create") {
    const expectedStorageClass = configuration.storageClass ?? "Standard";
    if (
      (configuration.storageClass !== undefined && bucket.storageClass !== expectedStorageClass) ||
      (configuration.storageClass === undefined &&
        bucket.storageClass !== undefined &&
        bucket.storageClass !== expectedStorageClass)
    ) {
      throw invalidResponse();
    }
  }
}

function parseResourceRef(value: string): string {
  if (!value.startsWith(R2_RESOURCE_PREFIX)) throw invalidRequest();
  const bucketName = value.slice(R2_RESOURCE_PREFIX.length);
  if (!isBucketName(bucketName)) throw invalidRequest();
  return bucketName;
}

function resourceRef(bucketName: string): string {
  return `${R2_RESOURCE_PREFIX}${bucketName}`;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof CloudflareApiError &&
    error.code === "cloudflare_api_request_failed" &&
    error.status === 404
  );
}

function isAmbiguousMutationFailure(error: unknown): boolean {
  return (
    (error instanceof CloudflareApiError &&
      (error.code === "cloudflare_api_unavailable" ||
        error.code === "cloudflare_api_invalid_response")) ||
    (error instanceof CloudflareR2SetupAdapterError &&
      error.code === "cloudflare_r2_invalid_response")
  );
}

function isBaseName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,36}[a-z0-9]$/u.test(value);
}

function isBucketName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(value);
}

function isLocationHint(value: unknown): value is R2LocationHint {
  return ["apac", "eeur", "enam", "weur", "wnam", "oc"].includes(value as never);
}

function isJurisdiction(value: unknown): value is R2Jurisdiction {
  return value === "default" || value === "eu" || value === "fedramp";
}

function isStorageClass(value: unknown): value is R2StorageClass {
  return value === "Standard" || value === "InfrequentAccess";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function invalidConfiguration(): CloudflareR2SetupAdapterError {
  return new CloudflareR2SetupAdapterError("cloudflare_r2_invalid_configuration");
}

function invalidRequest(): CloudflareR2SetupAdapterError {
  return new CloudflareR2SetupAdapterError("cloudflare_r2_invalid_request");
}

function invalidResponse(): CloudflareR2SetupAdapterError {
  return new CloudflareR2SetupAdapterError("cloudflare_r2_invalid_response");
}

function unsupportedOperation(): CloudflareR2SetupAdapterError {
  return new CloudflareR2SetupAdapterError("cloudflare_r2_unsupported_operation");
}
