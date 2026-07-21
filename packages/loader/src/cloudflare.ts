import type {
  CapabilityCallRecord,
  ControlPlaneExecutionRecord,
  ExecutionUsageRecorder,
  UsageHookType
} from "@tenantscript/control-plane";

const MAX_DYNAMIC_WORKER_RESPONSE_BYTES = 1_048_576;
const MAX_DYNAMIC_WORKER_REQUEST_BYTES = 1_048_576;
const MAX_DYNAMIC_WORKER_ARTIFACT_BYTES = 4_194_304;
const MAX_DYNAMIC_WORKER_TIMEOUT_MS = 2_147_483_647;
// Invocation must fail before tenant code runs when the authoritative recorder cannot persist it.
const MAX_RECORDED_HOOK_NAME_LENGTH = 256;
const MAX_RECORDED_PLUGIN_VERSION_LENGTH = 128;
const DYNAMIC_WORKER_RUNTIME_VERSION = "v1";
const DYNAMIC_WORKER_MAIN_MODULE = "tenantscript-runtime.js";
const DYNAMIC_WORKER_PLUGIN_MODULE = "tenant-plugin.cjs";

export type DynamicWorkerModule = string | { cjs: string };

export interface DynamicWorkerCode {
  compatibilityDate: string;
  mainModule: string;
  modules: Record<string, DynamicWorkerModule>;
  env: Record<string, unknown>;
  globalOutbound: null;
}

export interface DynamicWorkerEntrypoint {
  fetch: (request: Request) => Promise<Response>;
}

export interface DynamicWorkerStub {
  getEntrypoint: (
    name?: string | null,
    options?: { limits?: { cpuMs: number; subRequests: number } }
  ) => DynamicWorkerEntrypoint;
}

export interface DynamicWorkerLoaderBinding {
  get: (
    id: string,
    getCode: () => DynamicWorkerCode | Promise<DynamicWorkerCode>
  ) => DynamicWorkerStub;
}

export interface DynamicWorkerInvocationEvidence {
  capabilityCalls: readonly CapabilityCallRecord[];
  subrequests: number;
  workflowRuns: number;
}

export interface DynamicWorkerCapabilityBinding {
  call: (executionId: string, name: string, input: unknown) => Promise<unknown>;
}

export interface CloudflareDynamicWorkerCallerFailure {
  code: "runtime_evidence_unavailable";
  executionId: string;
  tenantId: string;
  pluginId: string;
}

export interface CloudflareDynamicWorkerRunRequest {
  executionId: string;
  tenantId: string;
  installationId: string;
  pluginId: string;
  hookName: string;
  hookType: UsageHookType;
  version: string;
  artifactSha256: string;
  grantRevision: string;
  payload: unknown;
  limits: {
    cpuMs: number;
    timeoutMs: number;
    subrequests: number;
  };
}

export interface CloudflareDynamicWorkerRunResult {
  value: unknown;
  execution: ControlPlaneExecutionRecord;
}

export interface CloudflareDynamicWorkerCaller {
  run: (request: CloudflareDynamicWorkerRunRequest) => Promise<CloudflareDynamicWorkerRunResult>;
}

export type CloudflareDynamicWorkerCallerErrorCode =
  | "artifact_integrity_failed"
  | "artifact_unavailable"
  | "execution_recording_failed"
  | "invalid_configuration"
  | "invalid_request"
  | "runtime_invocation_budget_exceeded"
  | "runtime_invocation_failed"
  | "runtime_invocation_timed_out";

export class CloudflareDynamicWorkerCallerError extends Error {
  override readonly name = "CloudflareDynamicWorkerCallerError";

  constructor(readonly code: CloudflareDynamicWorkerCallerErrorCode) {
    super(code);
  }

  toJSON(): { code: CloudflareDynamicWorkerCallerErrorCode } {
    return { code: this.code };
  }
}

export interface CloudflareDynamicWorkerCallerConfiguration {
  loader: DynamicWorkerLoaderBinding;
  compatibilityDate: string;
  loadArtifact: (request: {
    tenantId: string;
    pluginId: string;
    version: string;
    sha256: string;
  }) => Promise<string>;
  createScopeBindings: (request: {
    tenantId: string;
    installationId: string;
    pluginId: string;
    grantRevision: string;
  }) => Record<string, unknown>;
  classifyInvocationError?: (error: unknown) => "budget_exceeded" | "error";
  readInvocationEvidence: (request: {
    executionId: string;
    tenantId: string;
    pluginId: string;
  }) => Promise<DynamicWorkerInvocationEvidence>;
  recorder: ExecutionUsageRecorder;
  reportFailure?: (failure: CloudflareDynamicWorkerCallerFailure) => Promise<void> | void;
  now?: () => Date;
  monotonicNow?: () => number;
}

export function createCloudflareDynamicWorkerCaller(
  configuration: CloudflareDynamicWorkerCallerConfiguration
): CloudflareDynamicWorkerCaller {
  validateConfiguration(configuration);
  const now = configuration.now ?? (() => new Date());
  const monotonicNow = configuration.monotonicNow ?? (() => performance.now());

  return {
    run: async (request) => {
      const requestBody = validateRunRequest(request);
      const workerId = await deriveWorkerId(request, configuration.compatibilityDate);
      const worker = configuration.loader.get(workerId, async () => {
        let artifact: string;
        try {
          artifact = await configuration.loadArtifact({
            tenantId: request.tenantId,
            pluginId: request.pluginId,
            version: request.version,
            sha256: request.artifactSha256
          });
        } catch {
          throw new CloudflareDynamicWorkerCallerError("artifact_unavailable");
        }
        if (
          typeof artifact !== "string" ||
          new TextEncoder().encode(artifact).byteLength > MAX_DYNAMIC_WORKER_ARTIFACT_BYTES
        ) {
          throw new CloudflareDynamicWorkerCallerError("artifact_unavailable");
        }
        if ((await sha256(artifact)) !== request.artifactSha256) {
          throw new CloudflareDynamicWorkerCallerError("artifact_integrity_failed");
        }
        let bindings: Record<string, unknown>;
        try {
          bindings = validateScopeBindings(
            configuration.createScopeBindings({
              tenantId: request.tenantId,
              installationId: request.installationId,
              pluginId: request.pluginId,
              grantRevision: request.grantRevision
            })
          );
        } catch (error) {
          if (error instanceof CloudflareDynamicWorkerCallerError) throw error;
          throw new CloudflareDynamicWorkerCallerError("invalid_configuration");
        }
        return {
          compatibilityDate: configuration.compatibilityDate,
          mainModule: DYNAMIC_WORKER_MAIN_MODULE,
          modules: {
            [DYNAMIC_WORKER_MAIN_MODULE]: DYNAMIC_WORKER_RUNTIME_SOURCE,
            [DYNAMIC_WORKER_PLUGIN_MODULE]: { cjs: artifact }
          },
          env: bindings,
          globalOutbound: null
        };
      });
      const startedAt = now();
      const started = monotonicNow();
      let value: unknown;
      let invocationBudgetExceeded = false;
      let invocationFailed = false;
      let invocationTimedOut = false;
      try {
        const abortController = new AbortController();
        const invocation = worker
          .getEntrypoint(null, {
            limits: {
              cpuMs: request.limits.cpuMs,
              subRequests: request.limits.subrequests
            }
          })
          .fetch(
            new Request(
              `https://runtime.tenantscript.internal/v1/executions/${request.executionId}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: requestBody,
                signal: abortController.signal
              }
            )
          )
          .then(readResponseValue);
        value = await withWallClockTimeout(invocation, request.limits.timeoutMs, abortController);
      } catch (error) {
        if (
          error instanceof CloudflareDynamicWorkerCallerError &&
          (error.code === "artifact_integrity_failed" ||
            error.code === "artifact_unavailable" ||
            error.code === "invalid_configuration")
        ) {
          throw error;
        }
        if (error instanceof DynamicWorkerInvocationTimeoutError) {
          invocationTimedOut = true;
        } else {
          let classification: "budget_exceeded" | "error" = "error";
          try {
            const classified = configuration.classifyInvocationError?.(error);
            if (classified === "budget_exceeded") classification = classified;
          } catch {
            // A classifier is an adapter hint, never a new failure or persistence authority.
          }
          if (classification === "budget_exceeded") invocationBudgetExceeded = true;
          else invocationFailed = true;
        }
      }
      const durationMs = Math.max(0, monotonicNow() - started);
      let evidence: DynamicWorkerInvocationEvidence = {
        capabilityCalls: [],
        subrequests: 0,
        workflowRuns: 0
      };
      try {
        evidence = validateInvocationEvidence(
          await withTrustedEvidenceTimeout(
            configuration.readInvocationEvidence({
              executionId: request.executionId,
              tenantId: request.tenantId,
              pluginId: request.pluginId
            }),
            request.limits.timeoutMs
          )
        );
      } catch {
        if (configuration.reportFailure !== undefined) {
          try {
            // Diagnostics are best-effort. The sink owns any platform waitUntil scheduling; this
            // caller must continue to authoritative recording even if the sink never settles.
            void Promise.resolve(
              configuration.reportFailure({
                code: "runtime_evidence_unavailable",
                executionId: request.executionId,
                tenantId: request.tenantId,
                pluginId: request.pluginId
              })
            ).catch(() => undefined);
          } catch {
            // Diagnostics cannot become a second runtime or execution-recording authority.
          }
        }
      }
      let execution: ControlPlaneExecutionRecord;
      try {
        execution = await configuration.recorder.record({
          execution: {
            id: request.executionId,
            tenantId: request.tenantId,
            pluginId: request.pluginId,
            hookName: request.hookName,
            version: request.version,
            status: invocationTimedOut
              ? "timeout"
              : invocationBudgetExceeded
                ? "budget_exceeded"
                : invocationFailed
                  ? "error"
                  : "success",
            durationMs,
            ...(invocationTimedOut
              ? { error: "dynamic_worker_timeout" }
              : invocationBudgetExceeded
                ? { error: "dynamic_worker_budget_exceeded" }
                : invocationFailed
                  ? { error: "dynamic_worker_invocation_failed" }
                  : {}),
            capabilityCalls: evidence.capabilityCalls,
            createdAt: startedAt
          },
          metrics: {
            hookType: request.hookType,
            // Cloudflare exposes exact CPUTimeMs asynchronously through Workers Trace Events
            // Logpush, not to the synchronous Dynamic Worker caller. Wall time is not CPU time.
            cpuMs: 0,
            subrequests: evidence.subrequests,
            workflowRuns: evidence.workflowRuns
          }
        });
      } catch {
        // Persistence is the execution authority, so it is never retried here. The stable error
        // prevents a D1/provider message from crossing the host integration boundary.
        throw new CloudflareDynamicWorkerCallerError("execution_recording_failed");
      }
      if (invocationTimedOut) {
        throw new CloudflareDynamicWorkerCallerError("runtime_invocation_timed_out");
      }
      if (invocationBudgetExceeded) {
        throw new CloudflareDynamicWorkerCallerError("runtime_invocation_budget_exceeded");
      }
      if (invocationFailed) {
        throw new CloudflareDynamicWorkerCallerError("runtime_invocation_failed");
      }
      return { value, execution };
    }
  };
}

function validateConfiguration(
  value: unknown
): asserts value is CloudflareDynamicWorkerCallerConfiguration {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "loader",
      "compatibilityDate",
      "loadArtifact",
      "createScopeBindings",
      "classifyInvocationError",
      "readInvocationEvidence",
      "recorder",
      "reportFailure",
      "now",
      "monotonicNow"
    ]) ||
    !isRecord(value.loader) ||
    typeof value.loader.get !== "function" ||
    !isCompatibilityDate(value.compatibilityDate) ||
    typeof value.loadArtifact !== "function" ||
    typeof value.createScopeBindings !== "function" ||
    (value.classifyInvocationError !== undefined &&
      typeof value.classifyInvocationError !== "function") ||
    typeof value.readInvocationEvidence !== "function" ||
    !isRecord(value.recorder) ||
    typeof value.recorder.record !== "function" ||
    (value.reportFailure !== undefined && typeof value.reportFailure !== "function") ||
    (value.now !== undefined && typeof value.now !== "function") ||
    (value.monotonicNow !== undefined && typeof value.monotonicNow !== "function")
  ) {
    throw new CloudflareDynamicWorkerCallerError("invalid_configuration");
  }
}

function validateScopeBindings(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length > 64) {
    throw new CloudflareDynamicWorkerCallerError("invalid_configuration");
  }
  for (const [name, binding] of Object.entries(value)) {
    if (
      !/^[A-Z][A-Z0-9_]{0,63}$/u.test(name) ||
      name === "LOADER" ||
      /(?:SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY)/u.test(name) ||
      ((typeof binding !== "object" || binding === null || Array.isArray(binding)) &&
        typeof binding !== "function")
    ) {
      throw new CloudflareDynamicWorkerCallerError("invalid_configuration");
    }
    if (name === "CAPABILITIES" && (!isRecord(binding) || typeof binding.call !== "function")) {
      throw new CloudflareDynamicWorkerCallerError("invalid_configuration");
    }
  }
  return value;
}

function validateInvocationEvidence(value: unknown): DynamicWorkerInvocationEvidence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["capabilityCalls", "subrequests", "workflowRuns"]) ||
    !Array.isArray(value.capabilityCalls) ||
    value.capabilityCalls.length > 256 ||
    !value.capabilityCalls.every(
      (call) =>
        isRecord(call) &&
        hasExactKeys(call, ["name", "status"]) &&
        isIdentifier(call.name) &&
        (call.status === "success" || call.status === "denied" || call.status === "error")
    ) ||
    !Number.isSafeInteger(value.subrequests) ||
    (value.subrequests as number) < 0 ||
    !Number.isSafeInteger(value.workflowRuns) ||
    (value.workflowRuns as number) < 0
  ) {
    throw new Error("invalid invocation evidence");
  }
  return value as unknown as DynamicWorkerInvocationEvidence;
}

function isCompatibilityDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isRecordedHookName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= MAX_RECORDED_HOOK_NAME_LENGTH
  );
}

function validateRunRequest(value: unknown): string {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "executionId",
      "tenantId",
      "installationId",
      "pluginId",
      "hookName",
      "hookType",
      "version",
      "artifactSha256",
      "grantRevision",
      "payload",
      "limits"
    ]) ||
    !isIdentifier(value.executionId) ||
    !isIdentifier(value.tenantId) ||
    !isIdentifier(value.installationId) ||
    !isIdentifier(value.pluginId) ||
    !isRecordedHookName(value.hookName) ||
    !isIdentifier(value.version) ||
    value.version.length > MAX_RECORDED_PLUGIN_VERSION_LENGTH ||
    !isIdentifier(value.grantRevision) ||
    !(
      value.hookType === "event" ||
      value.hookType === "transform" ||
      value.hookType === "policy"
    ) ||
    typeof value.artifactSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.artifactSha256) ||
    !isRecord(value.limits) ||
    !hasExactKeys(value.limits, ["cpuMs", "timeoutMs", "subrequests"]) ||
    !Number.isSafeInteger(value.limits.cpuMs) ||
    (value.limits.cpuMs as number) < 1 ||
    !Number.isSafeInteger(value.limits.timeoutMs) ||
    (value.limits.timeoutMs as number) < 1 ||
    (value.limits.timeoutMs as number) > MAX_DYNAMIC_WORKER_TIMEOUT_MS ||
    !Number.isSafeInteger(value.limits.subrequests) ||
    (value.limits.subrequests as number) < 0 ||
    value.payload === undefined
  ) {
    throw new CloudflareDynamicWorkerCallerError("invalid_request");
  }
  try {
    assertLosslessJsonValue(value.payload);
    const body = JSON.stringify({
      executionId: value.executionId,
      hookName: value.hookName,
      hookType: value.hookType,
      payload: value.payload
    });
    if (new TextEncoder().encode(body).byteLength > MAX_DYNAMIC_WORKER_REQUEST_BYTES) {
      throw new CloudflareDynamicWorkerCallerError("invalid_request");
    }
    return body;
  } catch (error) {
    if (error instanceof CloudflareDynamicWorkerCallerError) throw error;
    throw new CloudflareDynamicWorkerCallerError("invalid_request");
  }
}

async function deriveWorkerId(
  request: CloudflareDynamicWorkerRunRequest,
  compatibilityDate: string
): Promise<string> {
  // Loader.get() caches both code and env. Every value that can change WorkerCode or scoped RPC
  // authority therefore belongs in the opaque ID; otherwise warm isolates can retain stale code,
  // compatibility behavior, or another tenant's binding.
  const scope = [
    DYNAMIC_WORKER_RUNTIME_VERSION,
    compatibilityDate,
    request.tenantId,
    request.installationId,
    request.pluginId,
    request.artifactSha256,
    request.grantRevision
  ].join("\u0000");
  return `tsdw_${(await sha256(scope)).slice(0, 32)}`;
}

class DynamicWorkerInvocationTimeoutError extends Error {
  override readonly name = "DynamicWorkerInvocationTimeoutError";
}

async function withWallClockTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  abortController: AbortController
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      // CPU budgets do not stop an isolate awaiting a never-settling promise. Abort the request and
      // settle the trusted host independently so a timeout execution is always persisted. Reject
      // first because an abort-aware provider may synchronously reject with a generic AbortError.
      reject(new DynamicWorkerInvocationTimeoutError());
      abortController.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function withTrustedEvidenceTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("trusted evidence read timed out"));
    }, timeoutMs);
  });
  try {
    // Evidence enriches the execution record but cannot be allowed to prevent that record itself.
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readResponseValue(response: Response): Promise<unknown> {
  if (!response.ok || response.body === null) throw new Error("invalid dynamic worker response");
  const declaredLength = response.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_DYNAMIC_WORKER_RESPONSE_BYTES)
  ) {
    throw new Error("invalid dynamic worker response");
  }

  // Node and Workers expose compatible streams through different ambient declarations. Keep the
  // boundary explicit so the published caller remains type-safe without importing a Node runtime.
  const body = (response as unknown as { body: ReadableStream<Uint8Array> | null }).body;
  if (body === null) throw new Error("invalid dynamic worker response");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_DYNAMIC_WORKER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("invalid dynamic worker response");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, "value")) {
    throw new Error("invalid dynamic worker response");
  }
  return parsed.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

// JSON.stringify silently rewrites several JavaScript values. Validate the exact JSON data model
// first so the tenant receives the same payload that the trusted host authorized.
function assertLosslessJsonValue(value: unknown, ancestors = new Set<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0))
  ) {
    return;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new Error("value is not lossless JSON");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.keys(value).length !== value.length ||
        Object.getOwnPropertySymbols(value).length !== 0
      ) {
        throw new Error("value is not lossless JSON");
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error("value is not lossless JSON");
        assertLosslessJsonValue(value[index], ancestors);
      }
      return;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    const keys = Object.keys(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertyNames(value).length !== keys.length ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      throw new Error("value is not lossless JSON");
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error("value is not lossless JSON");
      }
      assertLosslessJsonValue(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

// ext deploy emits a CommonJS bundle whose scaffold exports `plugin.dispatch` (older entries may
// export `handlers`). A fixed trusted wrapper adapts either verified CJS shape to Worker fetch.
const DYNAMIC_WORKER_RUNTIME_SOURCE = String.raw`
import pluginModule from "./tenant-plugin.cjs";

const plugin = pluginModule.plugin ?? pluginModule.default;
const handlers = pluginModule.handlers;

// Response.json is a serializer, not a lossless validator. Reject unsupported plugin values before
// a successful execution can be recorded with output that differs from the plugin result.
function assertJsonValue(value, ancestors = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0))
  ) {
    return;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new Error("invalid TenantScript plugin return value");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.keys(value).length !== value.length ||
        Object.getOwnPropertySymbols(value).length !== 0
      ) {
        throw new Error("invalid TenantScript plugin return value");
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new Error("invalid TenantScript plugin return value");
        }
        assertJsonValue(value[index], ancestors);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    const keys = Object.keys(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertyNames(value).length !== keys.length ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      throw new Error("invalid TenantScript plugin return value");
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error("invalid TenantScript plugin return value");
      }
      assertJsonValue(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function validateLegacyHookReturn(hookType, value) {
  if (hookType === "event") return undefined;
  if (hookType === "transform") {
    if (value === undefined) throw new Error("TenantScript legacy hook return contract failed");
    return value;
  }
  if (value === null || typeof value !== "object") {
    throw new Error("TenantScript legacy hook return contract failed");
  }
  if (value.decision === "allow" || value.decision === "deny") return value;
  if (value.decision === "modify" && "payload" in value) return value;
  throw new Error("TenantScript legacy hook return contract failed");
}

export default {
  async fetch(request, env) {
    if (
      request.method !== "POST" ||
      ((plugin === null || typeof plugin !== "object" || typeof plugin.dispatch !== "function") &&
        (handlers === null || typeof handlers !== "object"))
    ) {
      throw new Error("invalid TenantScript runtime request");
    }
    const input = await request.json();
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length !== 4 ||
      typeof input.executionId !== "string" ||
      typeof input.hookName !== "string" ||
      (input.hookType !== "event" && input.hookType !== "transform" && input.hookType !== "policy") ||
      !("payload" in input)
    ) {
      throw new Error("invalid TenantScript runtime request");
    }
    const context = {
      capability(name, capabilityInput) {
        if (
          env.CAPABILITIES === null ||
          typeof env.CAPABILITIES !== "object" ||
          typeof env.CAPABILITIES.call !== "function"
        ) {
          throw new Error("TenantScript capability binding is unavailable");
        }
        return env.CAPABILITIES.call(input.executionId, name, capabilityInput);
      }
    };
    let value;
    if (plugin !== null && typeof plugin === "object" && typeof plugin.dispatch === "function") {
      const result = await plugin.dispatch({
        hookName: input.hookName,
        payload: input.payload,
        context
      });
      if (
        result === null ||
        typeof result !== "object" ||
        result.ok !== true ||
        !("value" in result)
      ) {
        throw new Error("TenantScript plugin dispatch failed");
      }
      value = result.value;
    } else {
      const handler = handlers[input.hookName];
      if (typeof handler !== "function") {
        throw new Error("TenantScript handler is unavailable");
      }
      value = validateLegacyHookReturn(input.hookType, await handler(input.payload, context));
    }
    if (value !== undefined) assertJsonValue(value);
    return Response.json({ value: value === undefined ? null : value });
  }
};
`;
