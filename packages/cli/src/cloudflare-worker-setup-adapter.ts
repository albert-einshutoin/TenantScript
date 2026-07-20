import { createHash } from "node:crypto";
import { CloudflareApiError, type CloudflareApiTransport } from "./cloudflare-api-transport.js";
import {
  deriveSetupOperationIdempotencyKey,
  type SetupProviderAdapter,
  type SetupReconcileResult
} from "./setup-executor.js";
import type { SetupOperation } from "./setup-plan.js";
import { deriveControlPlaneWorkerName } from "./wrangler-template.js";
import {
  WranglerWorkerDeployProcessError,
  type WranglerWorkerDeployProcess
} from "./wrangler-worker-deploy-process.js";

const OPERATION_ID = "create:control-plane-worker";
const RESOURCE_PREFIX = "worker:";
const OPERATION_DEPENDENCIES = [
  "create:control-plane-d1",
  "create:artifact-r2",
  "create:execution-archive-r2",
  "create:secret-store-do",
  "create:approval-workflow",
  "create:usage-analytics-engine",
  "create:runtime-worker",
  "apply:control-plane-migrations"
] as const;

export type CloudflareWorkerConfiguration =
  | { mode: "create"; baseName: string; configPath: string }
  | { mode: "adopt"; workerName: string };

export type CloudflareWorkerSetupAdapterErrorCode =
  | "cloudflare_worker_invalid_configuration"
  | "cloudflare_worker_invalid_request"
  | "cloudflare_worker_invalid_response"
  | "cloudflare_worker_target_exists"
  | "cloudflare_worker_ownership_mismatch"
  | "cloudflare_worker_unsupported_operation";

export class CloudflareWorkerSetupAdapterError extends Error {
  override readonly name = "CloudflareWorkerSetupAdapterError";
  constructor(readonly code: CloudflareWorkerSetupAdapterErrorCode) {
    super(code);
  }
  toJSON(): { code: CloudflareWorkerSetupAdapterErrorCode } {
    return { code: this.code };
  }
}

export function createCloudflareWorkerSetupAdapter(params: {
  transport: CloudflareApiTransport;
  deployProcess: WranglerWorkerDeployProcess;
  worker: CloudflareWorkerConfiguration;
}): SetupProviderAdapter {
  validateConfiguration(params);
  return {
    reconcile: async (request): Promise<SetupReconcileResult> => {
      validateRequest(request, "reconcile");
      if (!isWorkerOperation(request.operation)) throw unsupportedOperation();

      if (params.worker.mode === "adopt") {
        const observed = await searchExact(params.transport, params.worker.workerName);
        if (observed === null) throw invalidResponse();
        return { disposition: "adopted", resourceRef: resourceRef(observed) };
      }

      const target = deriveControlPlaneWorkerName(params.worker.baseName, request.runId);
      const marker = ownershipTag(request.idempotencyKey);
      const existing = await searchExact(params.transport, target);
      if (existing !== null) {
        if (request.attempt === "initial") throw targetExists();
        await requireOwnershipMarker(params.transport, target, marker);
        return { disposition: "created", resourceRef: resourceRef(existing) };
      }

      let deployError: WranglerWorkerDeployProcessError | undefined;
      try {
        await params.deployProcess.deploy({
          configPath: params.worker.configPath,
          workerName: target,
          ownershipTag: marker
        });
      } catch (error) {
        if (!(error instanceof WranglerWorkerDeployProcessError)) throw error;
        deployError = error;
      }

      const observed = await searchExact(params.transport, target);
      if (observed === null) {
        if (deployError !== undefined) throw deployError;
        throw invalidResponse();
      }
      await requireOwnershipMarker(params.transport, target, marker);
      return { disposition: "created", resourceRef: resourceRef(observed) };
    },

    cleanupCreated: async (request): Promise<void> => {
      validateRequest(request, "cleanup");
      if (!isWorkerOperation(request.operation) || params.worker.mode !== "create") {
        throw invalidRequest();
      }
      const reference = parseResourceRef(request.resourceRef);
      const target = deriveControlPlaneWorkerName(params.worker.baseName, request.runId);
      if (reference.name !== target) throw invalidRequest();

      const observed = await searchExact(params.transport, target);
      if (observed === null) return;
      if (digest(observed.id) !== reference.idDigest) throw ownershipMismatch();
      const reconcileKey = deriveSetupOperationIdempotencyKey(
        request.runId,
        OPERATION_ID,
        "reconcile"
      );
      await requireOwnershipMarker(params.transport, target, ownershipTag(reconcileKey));

      try {
        const result = await params.transport.request({
          method: "DELETE",
          pathSegments: ["workers", "scripts", target]
        });
        if (result !== null) throw invalidResponse();
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
    }
  };
}

interface WorkerSearchItem {
  id: string;
  name: string;
}

async function searchExact(
  transport: CloudflareApiTransport,
  name: string
): Promise<WorkerSearchItem | null> {
  const value = await transport.request({
    method: "GET",
    pathSegments: ["workers", "scripts-search"],
    query: { name, page: "1", per_page: "10" }
  });
  if (!Array.isArray(value) || value.length > 10) throw invalidResponse();
  if (value.length === 0) return null;
  const items = value.map(parseSearchItem);
  if (items.length !== 1 || items[0]?.name !== name) throw invalidResponse();
  return items[0];
}

function parseSearchItem(value: unknown): WorkerSearchItem {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "script_name",
      "created_on",
      "modified_on",
      "environment_is_default",
      "environment_name",
      "service_name"
    ]) ||
    !isProviderId(value.id) ||
    !isWorkerName(value.script_name) ||
    !isDateTime(value.created_on) ||
    !isDateTime(value.modified_on) ||
    (value.environment_is_default !== undefined &&
      typeof value.environment_is_default !== "boolean") ||
    (value.environment_name !== undefined && !isSafeText(value.environment_name, 128)) ||
    (value.service_name !== undefined && !isSafeText(value.service_name, 128))
  ) {
    throw invalidResponse();
  }
  return { id: value.id, name: value.script_name };
}

async function requireOwnershipMarker(
  transport: CloudflareApiTransport,
  name: string,
  expected: string
): Promise<void> {
  const value = await transport.request({
    method: "GET",
    pathSegments: ["workers", "scripts", name, "settings"]
  });
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "annotations",
      "bindings",
      "cache_options",
      "compatibility_date",
      "compatibility_flags",
      "limits",
      "logpush",
      "migration_tag",
      "observability",
      "placement",
      "tail_consumers",
      "tags",
      "usage_model"
    ]) ||
    !isRecord(value.annotations) ||
    !hasOnlyKeys(value.annotations, ["workers/message", "workers/tag", "workers/triggered_by"]) ||
    value.annotations["workers/tag"] !== expected
  ) {
    throw ownershipMismatch();
  }
}

function validateConfiguration(value: unknown): asserts value is {
  transport: CloudflareApiTransport;
  deployProcess: WranglerWorkerDeployProcess;
  worker: CloudflareWorkerConfiguration;
} {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["transport", "deployProcess", "worker"]) ||
    !isRecord(value.transport) ||
    typeof value.transport.request !== "function" ||
    !isRecord(value.deployProcess) ||
    typeof value.deployProcess.deploy !== "function" ||
    !isRecord(value.worker) ||
    (value.worker.mode !== "create" && value.worker.mode !== "adopt")
  )
    throw invalidConfiguration();
  if (value.worker.mode === "create") {
    if (
      !hasExactKeys(value.worker, ["mode", "baseName", "configPath"]) ||
      !isBaseName(value.worker.baseName) ||
      !isConfigPath(value.worker.configPath)
    )
      throw invalidConfiguration();
  } else if (
    !hasExactKeys(value.worker, ["mode", "workerName"]) ||
    !isWorkerName(value.worker.workerName)
  ) {
    throw invalidConfiguration();
  }
}

function validateRequest(
  request: unknown,
  action: "reconcile" | "cleanup"
): asserts request is {
  runId: string;
  idempotencyKey: string;
  attempt?: "initial" | "resume";
  operation: SetupOperation;
  resourceRef: string;
} {
  if (
    !isRecord(request) ||
    !hasExactKeys(
      request,
      action === "reconcile"
        ? ["runId", "idempotencyKey", "attempt", "operation"]
        : ["runId", "idempotencyKey", "operation", "resourceRef"]
    ) ||
    !isSafeIdentifier(request.runId, 128) ||
    !isOperation(request.operation) ||
    (request.operation.id === OPERATION_ID && !isWorkerOperation(request.operation)) ||
    request.idempotencyKey !==
      deriveSetupOperationIdempotencyKey(request.runId, request.operation.id, action) ||
    (action === "reconcile"
      ? request.attempt !== "initial" && request.attempt !== "resume"
      : typeof request.resourceRef !== "string")
  )
    throw invalidRequest();
}

function isOperation(value: unknown): value is SetupOperation {
  return (
    isRecord(value) &&
    isSafeIdentifier(value.id, 256) &&
    typeof value.kind === "string" &&
    typeof value.action === "string" &&
    isSafeText(value.logicalName, 256) &&
    (value.implementationStatus === "implemented" ||
      value.implementationStatus === "integration-required") &&
    Array.isArray(value.dependsOn) &&
    value.dependsOn.every((item) => isSafeIdentifier(item, 256))
  );
}

function isWorkerOperation(value: SetupOperation): boolean {
  return (
    value.id === OPERATION_ID &&
    value.kind === "worker" &&
    value.action === "create" &&
    value.logicalName === "TENANTSCRIPT_CONTROL_PLANE" &&
    value.implementationStatus === "implemented" &&
    value.dependsOn.length === OPERATION_DEPENDENCIES.length &&
    value.dependsOn.every((dependency, index) => dependency === OPERATION_DEPENDENCIES[index])
  );
}

function ownershipTag(reconcileKey: string): string {
  return `tenantscript-setup-${digest(reconcileKey).slice(0, 32)}`;
}

function resourceRef(worker: WorkerSearchItem): string {
  return `${RESOURCE_PREFIX}${worker.name}:${digest(worker.id)}`;
}

function parseResourceRef(value: string): { name: string; idDigest: string } {
  if (!value.startsWith(RESOURCE_PREFIX)) throw invalidRequest();
  const separator = value.lastIndexOf(":");
  const name = value.slice(RESOURCE_PREFIX.length, separator);
  const idDigest = value.slice(separator + 1);
  if (!isWorkerName(name) || !/^[0-9a-f]{64}$/u.test(idDigest)) throw invalidRequest();
  return { name, idDigest };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof CloudflareApiError &&
    error.code === "cloudflare_api_request_failed" &&
    error.status === 404
  );
}

function isBaseName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,36}[a-z0-9])?$/u.test(value);
}
function isWorkerName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);
}
function isConfigPath(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonc?$/u.test(value);
}
function isProviderId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 32 &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}
function isDateTime(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}
function isSafeIdentifier(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(value) &&
    !/(?:secret-sentinel|bearer|(?:^|:)sk[-_])/iu.test(value)
  );
}
function isSafeText(value: unknown, max: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return false;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 32 || code === 127)) return false;
  }
  return true;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
function invalidConfiguration() {
  return new CloudflareWorkerSetupAdapterError("cloudflare_worker_invalid_configuration");
}
function invalidRequest() {
  return new CloudflareWorkerSetupAdapterError("cloudflare_worker_invalid_request");
}
function invalidResponse() {
  return new CloudflareWorkerSetupAdapterError("cloudflare_worker_invalid_response");
}
function targetExists() {
  return new CloudflareWorkerSetupAdapterError("cloudflare_worker_target_exists");
}
function ownershipMismatch() {
  return new CloudflareWorkerSetupAdapterError("cloudflare_worker_ownership_mismatch");
}
function unsupportedOperation() {
  return new CloudflareWorkerSetupAdapterError("cloudflare_worker_unsupported_operation");
}
