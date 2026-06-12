import { createHash } from "node:crypto";
import vm from "node:vm";
import { build } from "esbuild";

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

type Sandbox = vm.Context & {
  module: {
    exports: unknown;
  };
  __tenant_handler_name?: string;
  __tenant_payload?: unknown;
  __tenant_context?: ScopedRuntimeContext;
};

type HandlerFunction = (payload: unknown, context: ScopedRuntimeContext) => unknown;

interface RuntimeLimitState {
  timeoutMs: number;
  maxSubrequests: number;
  subrequests: number;
}

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

export async function runScopedHandler(params: {
  bundleCode: string;
  handlerName: string;
  payload: unknown;
  context: ScopedRuntimeContext;
  limits?: ScopedRuntimeLimits;
}): Promise<ScopedRuntimeResult> {
  const logs: ScopedRuntimeLog[] = [];
  const limits = normalizeLimits(params.limits);
  const guardedContext = createGuardedContext(params.context, limits, logs);
  const sandbox = createSandbox(guardedContext, limits, logs);
  const script = new vm.Script(params.bundleCode, {
    filename: "tenant-plugin.cjs"
  });

  script.runInContext(sandbox, { timeout: limits.timeoutMs });

  const exportedModule = sandbox.module.exports;
  const handlers = isRecord(exportedModule) ? exportedModule.handlers : undefined;
  if (!isRecord(handlers)) {
    throw new Error("plugin bundle must export a handlers object");
  }

  const handler = handlers[params.handlerName];
  if (!isHandlerFunction(handler)) {
    throw new Error(`plugin bundle does not export handler ${params.handlerName}`);
  }

  sandbox.__tenant_handler_name = params.handlerName;
  sandbox.__tenant_payload = params.payload;
  sandbox.__tenant_context = guardedContext;

  const invocation = new vm.Script(
    [
      "Promise.resolve(",
      "  module.exports.handlers[__tenant_handler_name](__tenant_payload, __tenant_context)",
      ");"
    ].join("\n"),
    { filename: "tenant-plugin-handler.cjs" }
  );

  let handlerResult: Promise<unknown>;
  try {
    handlerResult = invocation.runInContext(sandbox, {
      timeout: limits.timeoutMs
    }) as Promise<unknown>;
  } catch (error) {
    if (isVmTimeout(error)) {
      throw new ScopedRuntimeTimeoutError(
        `handler ${params.handlerName} exceeded ${String(limits.timeoutMs)}ms`
      );
    }
    throw error;
  }

  return {
    value: await withWallClockTimeout(handlerResult, limits.timeoutMs, params.handlerName),
    logs
  };
}

function createSandbox(
  context: ScopedRuntimeContext,
  limits: RuntimeLimitState,
  logs: ScopedRuntimeLog[]
): Sandbox {
  const moduleExports: Record<string, unknown> = {};
  const sandbox = vm.createContext(
    {
      module: { exports: moduleExports },
      exports: moduleExports,
      ctx: context,
      URL,
      fetch: (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        countSubrequest({ limits, logs, target: `fetch:${url}` });
        logs.push({ reason: "egress_denied", target: url });
        return Promise.reject(new Error(`egress denied: ${url}`));
      }
    },
    {
      codeGeneration: {
        strings: false,
        wasm: false
      }
    }
  );

  return sandbox as Sandbox;
}

function createGuardedContext(
  context: ScopedRuntimeContext,
  limits: RuntimeLimitState,
  logs: ScopedRuntimeLog[]
): ScopedRuntimeContext {
  return {
    capability: async (name, input) => {
      countSubrequest({ limits, logs, target: `capability:${name}` });
      return await context.capability(name, input);
    }
  };
}

function countSubrequest(params: {
  limits: RuntimeLimitState;
  logs: ScopedRuntimeLog[];
  target: string;
}): void {
  params.limits.subrequests += 1;
  if (params.limits.subrequests > params.limits.maxSubrequests) {
    params.logs.push({ reason: "subrequest_limit_exceeded", target: params.target });
    throw new ScopedRuntimeLimitError(
      `subrequest limit exceeded: ${String(params.limits.maxSubrequests)}`,
      params.logs
    );
  }
}

function normalizeLimits(limits: ScopedRuntimeLimits | undefined): RuntimeLimitState {
  return {
    timeoutMs: limits?.timeoutMs ?? 250,
    maxSubrequests: limits?.maxSubrequests ?? Number.POSITIVE_INFINITY,
    subrequests: 0
  };
}

async function withWallClockTimeout(
  result: Promise<unknown>,
  timeoutMs: number,
  handlerName: string
): Promise<unknown> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new ScopedRuntimeTimeoutError(`handler ${handlerName} exceeded ${String(timeoutMs)}ms`)
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([result, timeout]);
  } catch (error) {
    if (isVmTimeout(error)) {
      throw new ScopedRuntimeTimeoutError(`handler ${handlerName} exceeded ${String(timeoutMs)}ms`);
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function isVmTimeout(error: unknown): boolean {
  return (
    isRecord(error) &&
    typeof error.message === "string" &&
    error.message.includes("Script execution timed out")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHandlerFunction(value: unknown): value is HandlerFunction {
  return typeof value === "function";
}
