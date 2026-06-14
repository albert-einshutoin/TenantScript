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
}

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
  return await runHandlerInWorker({ ...params, limits });
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
  return {
    timeoutMs: limits?.timeoutMs ?? 250,
    maxSubrequests: limits?.maxSubrequests ?? Number.POSITIVE_INFINITY
  };
}

function runHandlerInWorker(params: {
  bundleCode: string;
  handlerName: string;
  payload: unknown;
  context: ScopedRuntimeContext;
  limits: RuntimeLimitState;
}): Promise<ScopedRuntimeResult> {
  const worker = new Worker(RUNTIME_WORKER_SOURCE, {
    eval: true,
    workerData: {
      bundleCode: params.bundleCode,
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
      finishReject(error as Error);
    });

    worker.on("exit", (code) => {
      if (!settled && code !== 0) {
        finishReject(new Error(`runtime worker exited with code ${String(code)}`));
      }
    });
  });
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
      pending.resolve(message.value);
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
  const moduleExports = {};
  const sandbox = vm.createContext(
    {
      module: { exports: moduleExports },
      exports: moduleExports,
      URL,
      fetch: (input) => {
        const url = getFetchTarget(input);
        countSubrequest(limits, "fetch:" + url);
        logs.push({ reason: "egress_denied", target: url });
        return Promise.reject(new Error("egress denied: " + url));
      }
    },
    {
      codeGeneration: {
        strings: false,
        wasm: false
      }
    }
  );

  evaluateBundle(workerData.bundleCode, sandbox, limits);
  assertHandlerExists(sandbox.module.exports, workerData.handlerName);
  sandbox.__tenant_handler_name = workerData.handlerName;
  sandbox.__tenant_payload = workerData.payload;
  sandbox.__tenant_context = {
    capability: (name, input) => callParentCapability(limits, name, input)
  };

  parentPort.postMessage({ type: "started" });
  const result = invokeHandlerInSandbox(sandbox, limits);
  return await withWallClockTimeout(result, limits.timeoutMs, workerData.handlerName);
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

function assertHandlerExists(exportedModule, handlerName) {
  const handlers = isRecord(exportedModule) ? exportedModule.handlers : undefined;
  if (!isRecord(handlers)) {
    throw new Error("plugin bundle must export a handlers object");
  }

  if (typeof handlers[handlerName] !== "function") {
    throw new Error("plugin bundle does not export handler " + handlerName);
  }
}

function invokeHandlerInSandbox(sandbox, limits) {
  const invocation = new vm.Script(
    [
      "Promise.resolve(",
      "  module.exports.handlers[__tenant_handler_name](__tenant_payload, __tenant_context)",
      ");"
    ].join("\n"),
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
  return { name: "Error", message: String(error) };
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
