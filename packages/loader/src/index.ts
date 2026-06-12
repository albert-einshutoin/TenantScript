import { createHash } from "node:crypto";
import vm from "node:vm";
import { build } from "esbuild";

export interface PluginBundle {
  code: string;
  sha256: string;
}

export interface ScopedRuntimeLog {
  reason: "egress_denied";
  url: string;
}

export interface ScopedRuntimeContext {
  capability: (name: string, input: unknown) => Promise<unknown>;
}

export interface ScopedRuntimeResult {
  value: unknown;
  logs: readonly ScopedRuntimeLog[];
}

type Sandbox = vm.Context & {
  module: {
    exports: unknown;
  };
};

type HandlerFunction = (payload: unknown, context: ScopedRuntimeContext) => unknown;

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
}): Promise<ScopedRuntimeResult> {
  const logs: ScopedRuntimeLog[] = [];
  const sandbox = createSandbox(params.context, logs);
  const script = new vm.Script(params.bundleCode, {
    filename: "tenant-plugin.cjs"
  });

  script.runInContext(sandbox, { timeout: 50 });

  const exportedModule = sandbox.module.exports;
  const handlers = isRecord(exportedModule) ? exportedModule.handlers : undefined;
  if (!isRecord(handlers)) {
    throw new Error("plugin bundle must export a handlers object");
  }

  const handler = handlers[params.handlerName];
  if (!isHandlerFunction(handler)) {
    throw new Error(`plugin bundle does not export handler ${params.handlerName}`);
  }

  return {
    value: await handler(params.payload, params.context),
    logs
  };
}

function createSandbox(context: ScopedRuntimeContext, logs: ScopedRuntimeLog[]): Sandbox {
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
        logs.push({ reason: "egress_denied", url });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHandlerFunction(value: unknown): value is HandlerFunction {
  return typeof value === "function";
}
