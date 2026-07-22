import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import type {
  ApprovalContinuationRequest,
  ControlPlaneExecutionRecord,
  ContinuationRunner
} from "@tenantscript/control-plane";

export interface PluginBundle {
  code: string;
  sha256: string;
}

export interface ScopedRuntimeLog {
  reason: "egress_denied" | "subrequest_limit_exceeded";
  target: string;
}

export interface ScopedRuntimeContext {
  capability: (name: string, input: unknown) => Promise<unknown>;
}

export interface ScopedRuntimeLimits {
  timeoutMs?: number;
  maxSubrequests?: number;
  memoryMb?: number;
}

export interface ScopedRuntimeResult {
  value: unknown;
  logs: readonly ScopedRuntimeLog[];
}

export interface ApprovalContinuationRunnerOptions {
  bundleCode: string;
  version: string;
  context: ScopedRuntimeContext;
  generateExecutionId: (request: ApprovalContinuationRequest) => string;
  now?: () => Date;
  limits?: ScopedRuntimeLimits;
}

export class ScopedRuntimeTimeoutError extends Error {
  override readonly name = "ScopedRuntimeTimeoutError";
  readonly executionStatus = "timeout";
}

export class ScopedRuntimeLimitError extends Error {
  override readonly name = "ScopedRuntimeLimitError";
  readonly executionStatus = "budget_exceeded";

  constructor(
    message: string,
    readonly logs: readonly ScopedRuntimeLog[] = []
  ) {
    super(message);
  }
}

interface RuntimeLimitState {
  timeoutMs: number;
  maxSubrequests: number;
  memoryMb: number;
}

type ScopedRuntimeEntrypoint = "handler" | "pluginDispatch";

interface SerializedRuntimeError {
  name: string;
  message: string;
  executionStatus?: string;
  logs?: readonly ScopedRuntimeLog[];
}

type RuntimeWorkerMessage =
  | { type: "started" }
  | { type: "result"; value: unknown; logs: readonly ScopedRuntimeLog[] }
  | { type: "error"; error: SerializedRuntimeError }
  | { type: "capability"; id: number; name: string; input: unknown };

const RUNTIME_STARTUP_TIMEOUT_MS = 5_000;

export async function bundlePlugin(entryPoint: string): Promise<PluginBundle> {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "neutral",
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent"
  });

  const output = result.outputFiles[0]?.text;
  if (output === undefined) {
    throw new Error("esbuild did not produce a plugin bundle");
  }

  return {
    code: output,
    sha256: createHash("sha256").update(output).digest("hex")
  };
}

/**
 * Runs a bundled plugin handler in a hardened `node:vm` context inside a
 * terminable worker thread. This path backs first-party local tooling
 * (`tenantscript plugin dev` / `plugin replay`); untrusted multi-tenant
 * execution runs on the production Cloudflare Dynamic Workers isolate.
 */
export async function runScopedHandler(params: {
  bundleCode: string;
  handlerName: string;
  payload: unknown;
  context: ScopedRuntimeContext;
  limits?: ScopedRuntimeLimits;
}): Promise<ScopedRuntimeResult> {
  const limits = normalizeLimits(params.limits);
  return await runHandlerInWorker({ ...params, entrypoint: "handler", limits });
}

/**
 * Runs the standard scaffold `plugin.dispatch` export inside the same local sandbox used by
 * development and replay. The structured dispatch result is returned as `value` so callers can
 * verify both success and SDK-normalized failure behavior without loading the bundle in Node.
 */
export async function runScopedPluginDispatch(params: {
  bundleCode: string;
  hookName: string;
  payload: unknown;
  context: ScopedRuntimeContext;
  limits?: ScopedRuntimeLimits;
}): Promise<ScopedRuntimeResult> {
  const limits = normalizeLimits(params.limits);
  return await runHandlerInWorker({
    bundleCode: params.bundleCode,
    handlerName: params.hookName,
    payload: params.payload,
    context: params.context,
    entrypoint: "pluginDispatch",
    limits
  });
}

export function createApprovalContinuationRunner(
  options: ApprovalContinuationRunnerOptions
): ContinuationRunner {
  return {
    runApprovalContinuation: async (request) => {
      const now = options.now ?? (() => new Date());
      const startedAt = now();
      await runScopedHandler({
        bundleCode: options.bundleCode,
        handlerName: request.approval.resumeHook,
        payload: request.payload,
        context: options.context,
        ...(options.limits === undefined ? {} : { limits: options.limits })
      });
      const finishedAt = now();

      return {
        id: options.generateExecutionId(request),
        tenantId: request.approval.tenantId,
        pluginId: request.approval.pluginId,
        hookName: request.approval.resumeHook,
        version: options.version,
        status: "success",
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        capabilityCalls: [],
        createdAt: startedAt
      } satisfies ControlPlaneExecutionRecord;
    }
  };
}

function normalizeLimits(limits: ScopedRuntimeLimits | undefined): RuntimeLimitState {
  const normalized = {
    timeoutMs: limits?.timeoutMs ?? 250,
    maxSubrequests: limits?.maxSubrequests ?? Number.POSITIVE_INFINITY,
    memoryMb: limits?.memoryMb ?? 128
  };
  if (!Number.isSafeInteger(normalized.timeoutMs) || normalized.timeoutMs < 1) {
    throw new TypeError("runtime timeoutMs must be a positive safe integer");
  }
  if (
    normalized.maxSubrequests !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(normalized.maxSubrequests) || normalized.maxSubrequests < 0)
  ) {
    throw new TypeError("runtime maxSubrequests must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(normalized.memoryMb) || normalized.memoryMb < 8) {
    throw new TypeError("runtime memoryMb must be a safe integer of at least 8");
  }
  return normalized;
}

function assertLosslessHostJsonValue(
  value: unknown,
  label: string,
  ancestors = new Set<object>()
): void {
  try {
    assertLosslessHostJsonValueStructure(value, ancestors);
  } catch {
    throw new TypeError(`${label} must be lossless JSON`);
  }
}

// Worker structured clone can invoke accessors and flatten custom prototypes before the sandbox
// sees them. Validate on the caller side first so local execution never authorizes a rewritten
// payload or capability result that the production Cloudflare boundary would reject.
function assertLosslessHostJsonValueStructure(value: unknown, ancestors: Set<object>): void {
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
        Object.getOwnPropertyNames(value).length !== value.length + 1 ||
        Object.getOwnPropertySymbols(value).length !== 0
      ) {
        throw new Error("value is not lossless JSON");
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error("value is not lossless JSON");
        assertLosslessHostJsonValueStructure(value[index], ancestors);
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
      assertLosslessHostJsonValueStructure(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function runHandlerInWorker(params: {
  bundleCode: string;
  handlerName: string;
  payload: unknown;
  context: ScopedRuntimeContext;
  entrypoint: ScopedRuntimeEntrypoint;
  limits: RuntimeLimitState;
}): Promise<ScopedRuntimeResult> {
  assertLosslessHostJsonValue(params.payload, "handler payload");
  const worker = new Worker(RUNTIME_WORKER_SOURCE, {
    eval: true,
    // The local sandbox should not inherit credentials even if a future runtime regression exposes
    // part of the worker environment. Production execution remains isolated by Cloudflare.
    env: {},
    // A worker-level V8 heap cap contains allocation storms independently from the wall-clock
    // timeout, protecting local tooling from a plugin that exhausts memory before it yields.
    resourceLimits: { maxOldGenerationSizeMb: params.limits.memoryMb },
    workerData: {
      bundleCode: params.bundleCode,
      entrypoint: params.entrypoint,
      handlerName: params.handlerName,
      payload: params.payload,
      limits: params.limits
    }
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let handlerTimeout: ReturnType<typeof setTimeout> | undefined;
    const startupTimeout = setTimeout(() => {
      finishReject(
        new Error(`runtime worker did not start within ${String(RUNTIME_STARTUP_TIMEOUT_MS)}ms`)
      );
    }, RUNTIME_STARTUP_TIMEOUT_MS);
    const cleanup = () => {
      if (settled) {
        return false;
      }
      settled = true;
      clearTimeout(startupTimeout);
      if (handlerTimeout !== undefined) {
        clearTimeout(handlerTimeout);
      }
      void worker.terminate();
      return true;
    };
    const finishResolve = (value: ScopedRuntimeResult) => {
      if (cleanup()) {
        resolve(value);
      }
    };
    const finishReject = (error: Error) => {
      if (cleanup()) {
        reject(error);
      }
    };

    const handleCapabilityRequest = async (
      message: Extract<RuntimeWorkerMessage, { type: "capability" }>
    ) => {
      try {
        const value = await params.context.capability(message.name, message.input);
        assertLosslessHostJsonValue(value, "capability result");
        if (!settled) {
          worker.postMessage({ type: "capabilityResult", id: message.id, value });
        }
      } catch (error) {
        if (!settled) {
          worker.postMessage({
            type: "capabilityError",
            id: message.id,
            error: serializeUnknownError(error)
          });
        }
      }
    };

    worker.on("message", (rawMessage: unknown) => {
      if (!isRuntimeWorkerMessage(rawMessage)) {
        finishReject(new Error("runtime worker sent an invalid message"));
        return;
      }

      if (rawMessage.type === "started") {
        clearTimeout(startupTimeout);
        handlerTimeout = setTimeout(() => {
          finishReject(
            new ScopedRuntimeTimeoutError(
              `handler ${params.handlerName} exceeded ${String(params.limits.timeoutMs)}ms`
            )
          );
        }, params.limits.timeoutMs);
        return;
      }

      if (rawMessage.type === "capability") {
        void handleCapabilityRequest(rawMessage);
        return;
      }

      if (rawMessage.type === "error") {
        finishReject(deserializeRuntimeError(rawMessage.error));
        return;
      }

      finishResolve({ value: rawMessage.value, logs: rawMessage.logs });
    });

    worker.on("error", (error) => {
      finishReject(
        isWorkerOutOfMemoryError(error)
          ? new ScopedRuntimeLimitError(
              `handler ${params.handlerName} exceeded ${String(params.limits.memoryMb)}MB memory limit`
            )
          : (error as Error)
      );
    });

    worker.on("exit", (code) => {
      if (!settled && code !== 0) {
        finishReject(new Error(`runtime worker exited with code ${String(code)}`));
      }
    });
  });
}

function isWorkerOutOfMemoryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: unknown }).code === "ERR_WORKER_OUT_OF_MEMORY"
  );
}

function serializeUnknownError(error: unknown): SerializedRuntimeError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

function deserializeRuntimeError(error: SerializedRuntimeError): Error {
  if (error.executionStatus === "timeout" || error.name === "ScopedRuntimeTimeoutError") {
    return new ScopedRuntimeTimeoutError(error.message);
  }

  if (error.executionStatus === "budget_exceeded" || error.name === "ScopedRuntimeLimitError") {
    return new ScopedRuntimeLimitError(error.message, error.logs ?? []);
  }

  const deserialized = new Error(error.message);
  deserialized.name = error.name;
  return deserialized;
}

function isRuntimeWorkerMessage(value: unknown): value is RuntimeWorkerMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "capability") {
    return (
      typeof value.id === "number" &&
      typeof value.name === "string" &&
      Object.hasOwn(value, "input")
    );
  }

  if (value.type === "error") {
    return isSerializedRuntimeError(value.error);
  }

  return value.type === "started" || (value.type === "result" && Array.isArray(value.logs));
}

function isSerializedRuntimeError(value: unknown): value is SerializedRuntimeError {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.message === "string" &&
    (value.logs === undefined || Array.isArray(value.logs))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RUNTIME_WORKER_SOURCE = String.raw`
const { randomBytes } = require("node:crypto");
const vm = require("node:vm");
const { parentPort, workerData } = require("node:worker_threads");

class ScopedRuntimeTimeoutError extends Error {
  name = "ScopedRuntimeTimeoutError";
  executionStatus = "timeout";
}

class ScopedRuntimeLimitError extends Error {
  name = "ScopedRuntimeLimitError";
  executionStatus = "budget_exceeded";

  constructor(message, logs = []) {
    super(message);
    this.logs = logs;
  }
}

const logs = [];
let subrequests = 0;
let nextCapabilityId = 1;
const pendingCapabilities = new Map();

parentPort.on("message", (message) => {
  if (message.type === "capabilityResult") {
    const pending = pendingCapabilities.get(message.id);
    if (pending !== undefined) {
      pendingCapabilities.delete(message.id);
      try {
        pending.resolve(serializeSandboxValue(message.value, "capability result"));
      } catch (error) {
        pending.reject(error);
      }
    }
    return;
  }

  if (message.type === "capabilityError") {
    const pending = pendingCapabilities.get(message.id);
    if (pending !== undefined) {
      pendingCapabilities.delete(message.id);
      pending.reject(deserializeError(message.error));
    }
  }
});

run().then(
  (value) => {
    parentPort.postMessage({ type: "result", value, logs });
  },
  (error) => {
    parentPort.postMessage({ type: "error", error: serializeError(error) });
  }
);

async function run() {
  const limits = workerData.limits;
  const sandbox = vm.createContext({}, {
    codeGeneration: {
      strings: false,
      wasm: false
    }
  });

  const runtimeBindings = initializeSandbox(sandbox, limits);

  evaluateBundle(workerData.bundleCode, sandbox, limits);
  assertEntrypointExists(sandbox.module.exports, workerData.handlerName, workerData.entrypoint);
  installInvocationState(sandbox, limits, runtimeBindings.installerName);

  parentPort.postMessage({ type: "started" });
  const result = invokeEntrypointInSandbox(
    sandbox,
    limits,
    workerData.entrypoint,
    runtimeBindings.promiseResolveName
  );
  const value = await withWallClockTimeout(result, limits.timeoutMs, workerData.handlerName);
  // A completed handler must not leave capability effects in flight. Checking at settlement keeps
  // local replay from blessing fire-and-forget behavior whose outcome production cannot record.
  if (pendingCapabilities.size !== 0) {
    throw new Error("handler returned with outstanding capability calls");
  }
  return runtimeBindings.validateResult(value, workerData.entrypoint);
}

function initializeSandbox(sandbox, limits) {
  // Random lexical bindings keep the installer and trusted Promise intrinsic unreachable to
  // evaluated code while retaining them inside the VM realm until invocation.
  const installerName = "__tenant_install_" + randomBytes(16).toString("hex");
  const promiseResolveName = "__tenant_resolve_" + randomBytes(16).toString("hex");
  // Return values must be checked in their native realm before Worker structured clone can flatten
  // prototypes or invoke accessors, using intrinsics captured before submitted code can replace them.
  const resultValidatorName = "__tenant_validate_" + randomBytes(16).toString("hex");
  const HostURL = URL;
  const operateUrl = hardenBridge((requestJson) => {
    try {
      const request = JSON.parse(requestJson);
      const url =
        typeof request.href === "string"
          ? new HostURL(request.href)
          : new HostURL(request.input, request.base);
      if (request.set !== undefined) {
        const settableProperties = new Set([
          "href",
          "protocol",
          "username",
          "password",
          "host",
          "hostname",
          "port",
          "pathname",
          "search",
          "hash"
        ]);
        if (!settableProperties.has(request.set.name)) {
          throw new TypeError("unsupported URL property");
        }
        url[request.set.name] = request.set.value;
      }
      if (request.searchParams !== undefined) {
        const methods = new Set(["append", "delete", "set", "sort"]);
        if (!methods.has(request.searchParams.method)) {
          throw new TypeError("unsupported URLSearchParams operation");
        }
        url.searchParams[request.searchParams.method](...request.searchParams.args);
      }
      return JSON.stringify(snapshotUrl(url));
    } catch (error) {
      throw serializeBridgeError(error);
    }
  });
  const denyFetch = hardenBridge((target) => {
    try {
      countSubrequest(limits, "fetch:" + target);
      logs.push({ reason: "egress_denied", target });
      return Promise.reject(serializeBridgeError(new Error("egress denied: " + target)));
    } catch (error) {
      return Promise.reject(serializeBridgeError(error));
    }
  });
  const callCapability = hardenBridge(async (name, inputJson) => {
    try {
      return await callParentCapability(limits, name, JSON.parse(inputJson));
    } catch (error) {
      throw serializeBridgeError(error);
    }
  });

  // Only primitives and prototype-less bridge callables cross into the context. The initialization
  // script captures those bridges, deletes their globals, and exposes realm-native wrappers so
  // submitted code cannot climb a host constructor chain back to Node's process object.
  sandbox.__tenant_url_bridge = operateUrl;
  sandbox.__tenant_fetch_bridge = denyFetch;
  sandbox.__tenant_capability_bridge = callCapability;
  sandbox.__tenant_payload_json = serializeSandboxValue(workerData.payload, "handler payload");
  sandbox.__tenant_handler_name_value = workerData.handlerName;

  const initialization = new vm.Script(
    [
      "const " + promiseResolveName + " = Promise.resolve.bind(Promise);",
      "const " + resultValidatorName + " = (() => {",
      "  const SafeError = Error;",
      "  const SafeSet = Set;",
      "  const SafeString = String;",
      "  const safeSetAdd = Function.prototype.call.bind(Set.prototype.add);",
      "  const safeSetDelete = Function.prototype.call.bind(Set.prototype.delete);",
      "  const safeSetHas = Function.prototype.call.bind(Set.prototype.has);",
      "  const safeArrayIsArray = Array.isArray;",
      "  const safeNumberIsFinite = Number.isFinite;",
      "  const safeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;",
      "  const safeObjectGetOwnPropertyNames = Object.getOwnPropertyNames;",
      "  const safeObjectGetOwnPropertySymbols = Object.getOwnPropertySymbols;",
      "  const safeObjectGetPrototypeOf = Object.getPrototypeOf;",
      "  const safeObjectHasOwn = Object.hasOwn;",
      "  const safeObjectIs = Object.is;",
      "  const safeObjectKeys = Object.keys;",
      "  const safeObjectPrototype = Object.prototype;",
      "  const safeJsonStringify = JSON.stringify.bind(JSON);",
      "  const invalid = () => new SafeError('invalid TenantScript plugin return value');",
      "  const assertJsonValue = (value, ancestors, allowedUndefinedKey) => {",
      "    if (",
      "      value === null ||",
      "      typeof value === 'string' ||",
      "      typeof value === 'boolean' ||",
      "      (typeof value === 'number' && safeNumberIsFinite(value) && !safeObjectIs(value, -0))",
      "    ) return;",
      "    if (typeof value !== 'object' || safeSetHas(ancestors, value)) throw invalid();",
      "    safeSetAdd(ancestors, value);",
      "    try {",
      "      if (safeArrayIsArray(value)) {",
      "        if (",
      "          safeObjectKeys(value).length !== value.length ||",
      "          safeObjectGetOwnPropertyNames(value).length !== value.length + 1 ||",
      "          safeObjectGetOwnPropertySymbols(value).length !== 0",
      "        ) throw invalid();",
      "        for (let index = 0; index < value.length; index += 1) {",
      "          if (!safeObjectHasOwn(value, index)) throw invalid();",
      "          assertJsonValue(value[index], ancestors);",
      "        }",
      "        return;",
      "      }",
      "      const prototype = safeObjectGetPrototypeOf(value);",
      "      const keys = safeObjectKeys(value);",
      "      if (",
      "        (prototype !== safeObjectPrototype && prototype !== null) ||",
      "        safeObjectGetOwnPropertyNames(value).length !== keys.length ||",
      "        safeObjectGetOwnPropertySymbols(value).length !== 0",
      "      ) throw invalid();",
      "      for (const key of keys) {",
      "        const descriptor = safeObjectGetOwnPropertyDescriptor(value, key);",
      "        if (descriptor === undefined || !('value' in descriptor)) throw invalid();",
      "        if (key === allowedUndefinedKey && descriptor.value === undefined) continue;",
      "        assertJsonValue(descriptor.value, ancestors);",
      "      }",
      "    } finally {",
      "      safeSetDelete(ancestors, value);",
      "    }",
      "  };",
      "  const serializeJsonValue = (value) => {",
      "    if (value === null) return 'null';",
      "    if (typeof value === 'string') return safeJsonStringify(value);",
      "    if (typeof value === 'boolean' || typeof value === 'number') return SafeString(value);",
      "    if (safeArrayIsArray(value)) {",
      "      let serialized = '[';",
      "      for (let index = 0; index < value.length; index += 1) {",
      "        if (index !== 0) serialized += ',';",
      "        serialized += serializeJsonValue(value[index]);",
      "      }",
      "      return serialized + ']';",
      "    }",
      "    const keys = safeObjectKeys(value);",
      "    let serialized = '{';",
      "    for (let index = 0; index < keys.length; index += 1) {",
      "      if (index !== 0) serialized += ',';",
      "      const key = keys[index];",
      "      const descriptor = safeObjectGetOwnPropertyDescriptor(value, key);",
      "      serialized += safeJsonStringify(key) + ':' + serializeJsonValue(descriptor.value);",
      "    }",
      "    return serialized + '}';",
      "  };",
      "  return (value, entrypoint) => {",
      "    if (value === undefined && entrypoint === 'handler') return value;",
      "    let allowedUndefinedKey;",
      "    if (entrypoint === 'pluginDispatch' && value !== null && typeof value === 'object') {",
      "      const ok = safeObjectGetOwnPropertyDescriptor(value, 'ok');",
      "      const result = safeObjectGetOwnPropertyDescriptor(value, 'value');",
      "      if (",
      "        ok !== undefined && 'value' in ok && ok.value === true &&",
      "        result !== undefined && 'value' in result && result.value === undefined",
      "      ) allowedUndefinedKey = 'value';",
      "    }",
      "    assertJsonValue(value, new SafeSet(), allowedUndefinedKey);",
      "    if (entrypoint === 'capabilityInput') return serializeJsonValue(value);",
      "    return value;",
      "  };",
      "})();",
      "const " + installerName + " = (() => {",
      "  const urlBridge = __tenant_url_bridge;",
      "  const fetchBridge = __tenant_fetch_bridge;",
      "  const capabilityBridge = __tenant_capability_bridge;",
      "  const payloadJson = __tenant_payload_json;",
      "  const handlerName = __tenant_handler_name_value;",
      "  const safeString = globalThis.String;",
      "  const safeJsonParse = globalThis.JSON.parse.bind(globalThis.JSON);",
      "  const safeJsonStringify = globalThis.JSON.stringify.bind(globalThis.JSON);",
      "  const safeStringReplace = Function.prototype.call.bind(String.prototype.replace);",
      "  const defineProperties = Object.defineProperties.bind(Object);",
      "  delete globalThis.__tenant_url_bridge;",
      "  delete globalThis.__tenant_fetch_bridge;",
      "  delete globalThis.__tenant_capability_bridge;",
      "  delete globalThis.__tenant_payload_json;",
      "  delete globalThis.__tenant_handler_name_value;",
      "  const bridgeError = (error) => {",
      "    try {",
      "      const packet = safeJsonParse(safeString(error));",
      "      const bridged = new Error(packet.message);",
      "      bridged.name = packet.name;",
      "      if (packet.executionStatus === 'budget_exceeded') {",
      "        bridged.executionStatus = packet.executionStatus;",
      "        bridged.logs = packet.logs;",
      "      }",
      "      return bridged;",
      "    } catch (_ignored) {",
      "      return new Error('sandbox bridge failed');",
      "    }",
      "  };",
      "  const urlSnapshot = Symbol('urlSnapshot');",
      "  const urlParams = Symbol('urlParams');",
      "  const urlOwner = Symbol('urlOwner');",
      "  const applyUrl = Symbol('applyUrl');",
      "  const runUrlOperation = (request) => {",
      "      try {",
      "        return safeJsonParse(urlBridge(safeJsonStringify(request)));",
      "      } catch (error) {",
      "        throw new TypeError(bridgeError(error).message);",
      "      }",
      "  };",
      "  const encodeParam = (value) => encodeURIComponent(safeString(value)).replace(/%20/g, '+');",
      "  const serializeParamsInit = (init) => {",
      "    if (init == null) return '';",
      "    if (typeof init === 'string') return init.startsWith('?') ? init.slice(1) : init;",
      "    const entries = typeof init?.[Symbol.iterator] === 'function' ? [...init] : Object.entries(init);",
      "    return entries.map(([name, value]) => encodeParam(name) + '=' + encodeParam(value)).join('&');",
      "  };",
      "  class SandboxURLSearchParams {",
      "    constructor(ownerOrInit) {",
      "      this[urlOwner] = ownerOrInit instanceof SandboxURL",
      "        ? ownerOrInit",
      "        : new SandboxURL(",
      "            'https://sandbox.invalid/?' +",
      "              safeStringReplace(serializeParamsInit(ownerOrInit), /#/g, '%23')",
      "          );",
      "    }",
      "    append(name, value) { this[urlOwner][applyUrl]({ searchParams: { method: 'append', args: [safeString(name), safeString(value)] } }); }",
      "    delete(name, value) {",
      "      const args = value === undefined ? [safeString(name)] : [safeString(name), safeString(value)];",
      "      this[urlOwner][applyUrl]({ searchParams: { method: 'delete', args } });",
      "    }",
      "    get(name) { const pair = this[urlOwner][urlSnapshot].searchParams.find(([key]) => key === safeString(name)); return pair?.[1] ?? null; }",
      "    getAll(name) { return this[urlOwner][urlSnapshot].searchParams.filter(([key]) => key === safeString(name)).map(([, value]) => value); }",
      "    has(name, value) {",
      "      return this[urlOwner][urlSnapshot].searchParams.some(([key, entryValue]) =>",
      "        key === safeString(name) && (value === undefined || entryValue === safeString(value))",
      "      );",
      "    }",
      "    set(name, value) { this[urlOwner][applyUrl]({ searchParams: { method: 'set', args: [safeString(name), safeString(value)] } }); }",
      "    sort() { this[urlOwner][applyUrl]({ searchParams: { method: 'sort', args: [] } }); }",
      "    get size() { return this[urlOwner][urlSnapshot].searchParams.length; }",
      "    toString() { return this[urlOwner][urlSnapshot].searchParamsString; }",
      "    *entries() { for (const [name, value] of this[urlOwner][urlSnapshot].searchParams) yield [name, value]; }",
      "    *keys() { for (const [name] of this[urlOwner][urlSnapshot].searchParams) yield name; }",
      "    *values() { for (const [, value] of this[urlOwner][urlSnapshot].searchParams) yield value; }",
      "    forEach(callback, thisArg) { for (const [name, value] of this) callback.call(thisArg, value, name, this); }",
      "    [Symbol.iterator]() { return this.entries(); }",
      "  }",
      "  class SandboxURL {",
      "    constructor(input, base) {",
      "      this[urlSnapshot] = runUrlOperation({",
      "        input: safeString(input),",
      "        ...(base === undefined ? {} : { base: safeString(base) })",
      "      });",
      "      this[urlParams] = new SandboxURLSearchParams(this);",
      "    }",
      "    [applyUrl](operation) { this[urlSnapshot] = runUrlOperation({ href: this.href, ...operation }); }",
      "    get href() { return this[urlSnapshot].href; }",
      "    set href(value) { this[applyUrl]({ set: { name: 'href', value: safeString(value) } }); }",
      "    get origin() { return this[urlSnapshot].origin; }",
      "    get protocol() { return this[urlSnapshot].protocol; }",
      "    set protocol(value) { this[applyUrl]({ set: { name: 'protocol', value: safeString(value) } }); }",
      "    get username() { return this[urlSnapshot].username; }",
      "    set username(value) { this[applyUrl]({ set: { name: 'username', value: safeString(value) } }); }",
      "    get password() { return this[urlSnapshot].password; }",
      "    set password(value) { this[applyUrl]({ set: { name: 'password', value: safeString(value) } }); }",
      "    get host() { return this[urlSnapshot].host; }",
      "    set host(value) { this[applyUrl]({ set: { name: 'host', value: safeString(value) } }); }",
      "    get hostname() { return this[urlSnapshot].hostname; }",
      "    set hostname(value) { this[applyUrl]({ set: { name: 'hostname', value: safeString(value) } }); }",
      "    get port() { return this[urlSnapshot].port; }",
      "    set port(value) { this[applyUrl]({ set: { name: 'port', value: safeString(value) } }); }",
      "    get pathname() { return this[urlSnapshot].pathname; }",
      "    set pathname(value) { this[applyUrl]({ set: { name: 'pathname', value: safeString(value) } }); }",
      "    get search() { return this[urlSnapshot].search; }",
      "    set search(value) { this[applyUrl]({ set: { name: 'search', value: safeString(value) } }); }",
      "    get searchParams() { return this[urlParams]; }",
      "    get hash() { return this[urlSnapshot].hash; }",
      "    set hash(value) { this[applyUrl]({ set: { name: 'hash', value: safeString(value) } }); }",
      "    toString() { return this.href; }",
      "    toJSON() { return this.href; }",
      "    static canParse(input, base) { try { new SandboxURL(input, base); return true; } catch { return false; } }",
      "    static parse(input, base) { try { return new SandboxURL(input, base); } catch { return null; } }",
      "  }",
      "  Object.freeze(SandboxURLSearchParams.prototype);",
      "  Object.freeze(SandboxURLSearchParams);",
      "  Object.freeze(SandboxURL.prototype);",
      "  Object.freeze(SandboxURL);",
      "  globalThis.URL = SandboxURL;",
      "  globalThis.URLSearchParams = SandboxURLSearchParams;",
      "  globalThis.fetch = async (input) => {",
      "    try {",
      "      return await fetchBridge(safeString(input));",
      "    } catch (error) {",
      "      throw bridgeError(error);",
      "    }",
      "  };",
      "  globalThis.module = { exports: {} };",
      "  globalThis.exports = globalThis.module.exports;",
      "  const invocationContext = Object.freeze({",
      "    capability: async (name, input) => {",
      "      let inputJson;",
      "      try {",
      "        inputJson = " + resultValidatorName + "(input, 'capabilityInput');",
      "      } catch (_error) {",
      "        throw new TypeError('capability input must be lossless JSON');",
      "      }",
      "      try {",
      "        const resultJson = await capabilityBridge(safeString(name), inputJson);",
      "        return safeJsonParse(resultJson);",
      "      } catch (error) {",
      "        throw bridgeError(error);",
      "      }",
      "    }",
      "  });",
      "  const invocationPayload = safeJsonParse(payloadJson);",
      "  let installed = false;",
      "  return () => {",
      "    if (installed) throw new Error('invocation state is already installed');",
      "    installed = true;",
      "    defineProperties(globalThis, {",
      "      __tenant_handler_name: { value: handlerName, writable: false, configurable: false },",
      "      __tenant_payload: { value: invocationPayload, writable: false, configurable: false },",
      "      __tenant_context: { value: invocationContext, writable: false, configurable: false }",
      "    });",
      "  };",
      "})();"
    ].join("\n"),
    { filename: "tenant-sandbox-init.cjs" }
  );
  initialization.runInContext(sandbox, { timeout: limits.timeoutMs });
  const validateResult = new vm.Script(resultValidatorName, {
    filename: "tenant-sandbox-result-validator.cjs"
  }).runInContext(sandbox, { timeout: limits.timeoutMs });
  return { installerName, promiseResolveName, validateResult };
}

function installInvocationState(sandbox, limits, installerName) {
  const installer = new vm.Script(installerName + "();", {
    filename: "tenant-sandbox-invocation.cjs"
  });
  installer.runInContext(sandbox, { timeout: limits.timeoutMs });
}

function hardenBridge(bridge) {
  Object.setPrototypeOf(bridge, null);
  return Object.freeze(bridge);
}

// JSON.stringify is a serializer, not a validator: it silently rewrites undefined, non-finite
// numbers, sparse arrays, and objects such as Date. Reject those values before they cross the
// local worker boundary so replay and development enforce the same data model as production.
function assertLosslessJsonValue(value, ancestors = new Set()) {
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
        Object.getOwnPropertyNames(value).length !== value.length + 1 ||
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

    const prototype = Object.getPrototypeOf(value);
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

function serializeSandboxValue(value, label) {
  try {
    assertLosslessJsonValue(value);
    return JSON.stringify(value);
  } catch (_error) {
    throw new TypeError(label + " must be lossless JSON");
  }
}

function serializeBridgeError(error) {
  return JSON.stringify(serializeError(error));
}

function snapshotUrl(url) {
  return {
    href: url.href,
    origin: url.origin,
    protocol: url.protocol,
    username: url.username,
    password: url.password,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    searchParams: [...url.searchParams],
    searchParamsString: url.searchParams.toString()
  };
}

function evaluateBundle(bundleCode, sandbox, limits) {
  try {
    const script = new vm.Script(bundleCode, { filename: "tenant-plugin.cjs" });
    script.runInContext(sandbox, { timeout: limits.timeoutMs });
  } catch (error) {
    if (isVmTimeout(error)) {
      throw new ScopedRuntimeTimeoutError("bundle evaluation exceeded " + String(limits.timeoutMs) + "ms");
    }
    throw error;
  }
}

function assertEntrypointExists(exportedModule, handlerName, entrypoint) {
  if (entrypoint === "pluginDispatch") {
    const plugin = isRecord(exportedModule)
      ? (exportedModule.plugin ?? exportedModule.default ?? exportedModule)
      : undefined;
    if (!isRecord(plugin) || typeof plugin.dispatch !== "function") {
      throw new Error("plugin bundle must export plugin.dispatch");
    }
    return;
  }

  const handlers = isRecord(exportedModule) ? exportedModule.handlers : undefined;
  if (!isRecord(handlers)) {
    throw new Error("plugin bundle must export a handlers object");
  }

  if (typeof handlers[handlerName] !== "function") {
    throw new Error("plugin bundle does not export handler " + handlerName);
  }
}

function invokeEntrypointInSandbox(sandbox, limits, entrypoint, promiseResolveName) {
  const invocationSource =
    entrypoint === "pluginDispatch"
      ? [
          "(() => {",
          "  const exported = module.exports;",
          "  const plugin = exported.plugin ?? exported.default ?? exported;",
          "  return " + promiseResolveName + "(plugin.dispatch({",
          "    hookName: __tenant_handler_name,",
          "    payload: __tenant_payload,",
          "    context: __tenant_context",
          "  }));",
          "})()"
        ]
      : [
          promiseResolveName + "(",
          "  module.exports.handlers[__tenant_handler_name](__tenant_payload, __tenant_context)",
          ")"
        ];
  const invocation = new vm.Script(
    invocationSource.join("\n"),
    { filename: "tenant-plugin-handler.cjs" }
  );

  try {
    return invocation.runInContext(sandbox, { timeout: limits.timeoutMs });
  } catch (error) {
    if (isVmTimeout(error)) {
      throw new ScopedRuntimeTimeoutError(
        "handler " + sandbox.__tenant_handler_name + " exceeded " + String(limits.timeoutMs) + "ms"
      );
    }
    throw error;
  }
}

function callParentCapability(limits, name, input) {
  countSubrequest(limits, "capability:" + name);
  const id = nextCapabilityId;
  nextCapabilityId += 1;
  parentPort.postMessage({ type: "capability", id, name, input });
  return new Promise((resolve, reject) => {
    pendingCapabilities.set(id, { resolve, reject });
  });
}

function countSubrequest(limits, target) {
  subrequests += 1;
  if (subrequests > limits.maxSubrequests) {
    logs.push({ reason: "subrequest_limit_exceeded", target });
    throw new ScopedRuntimeLimitError(
      "subrequest limit exceeded: " + String(limits.maxSubrequests),
      logs
    );
  }
}

async function withWallClockTimeout(result, timeoutMs, handlerName) {
  let timeoutId;
  const timeout = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new ScopedRuntimeTimeoutError("handler " + handlerName + " exceeded " + String(timeoutMs) + "ms"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([result, timeout]);
  } catch (error) {
    if (isVmTimeout(error)) {
      throw new ScopedRuntimeTimeoutError("handler " + handlerName + " exceeded " + String(timeoutMs) + "ms");
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function getFetchTarget(input) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (isRecord(input) && typeof input.url === "string") {
    return input.url;
  }
  return String(input);
}

function isVmTimeout(error) {
  return isRecord(error) &&
    typeof error.message === "string" &&
    error.message.includes("Script execution timed out");
}

function serializeError(error) {
  if (error instanceof ScopedRuntimeLimitError) {
    return {
      name: error.name,
      message: error.message,
      executionStatus: error.executionStatus,
      logs: error.logs
    };
  }
  if (error instanceof ScopedRuntimeTimeoutError) {
    return {
      name: error.name,
      message: error.message,
      executionStatus: error.executionStatus
    };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  if (
    isRecord(error) &&
    error.executionStatus === "budget_exceeded" &&
    Array.isArray(error.logs) &&
    typeof error.name === "string" &&
    typeof error.message === "string"
  ) {
    return {
      name: error.name,
      message: error.message,
      executionStatus: error.executionStatus,
      logs: error.logs
    };
  }
  // Errors created inside node:vm are from another realm, so instanceof Error is false. Preserve
  // only their stable name/message fields instead of reflecting stack or plugin-owned metadata.
  if (isRecord(error) && typeof error.name === "string" && typeof error.message === "string") {
    return { name: error.name, message: error.message };
  }
  const rendered = String(error);
  const match = rendered.match(/^([A-Za-z]+Error):\s([\s\S]*)$/);
  return match === null
    ? { name: "Error", message: rendered }
    : { name: match[1], message: match[2] };
}

function deserializeError(error) {
  const deserialized = new Error(error.message);
  deserialized.name = error.name;
  return deserialized;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
`;
