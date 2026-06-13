import type { TenantScriptManifest } from "@tenantscript/manifest";

export interface PluginContext {
  capability: (name: string, input: unknown) => Promise<unknown>;
}

export type PluginHandler = (payload: unknown, context: PluginContext) => unknown;

export interface TenantScriptPlugin {
  manifest: TenantScriptManifest;
  dispatch: (request: DispatchRequest) => Promise<DispatchResult>;
}

export interface DispatchRequest {
  hookName: string;
  payload: unknown;
  context: PluginContext;
}

export type DispatchResult =
  | { ok: true; value: unknown }
  | { ok: false; error: PluginDispatchError };

export type PluginDispatchError =
  | { name: "UnknownHookError"; hookName: string }
  | { name: "MissingHandlerError"; hookName: string }
  | { name: "PluginHandlerError"; hookName: string; message: string }
  | { name: "HookReturnContractError"; hookName: string; message: string };

export interface DefinePluginInput {
  manifest: TenantScriptManifest;
  handlers: Record<string, PluginHandler>;
}

export function definePlugin(input: DefinePluginInput): TenantScriptPlugin {
  return {
    manifest: input.manifest,
    dispatch: (request) => dispatchPlugin(input, request)
  };
}

async function dispatchPlugin(
  input: DefinePluginInput,
  request: DispatchRequest
): Promise<DispatchResult> {
  const hook = input.manifest.hooks.find((candidate) => candidate.name === request.hookName);
  if (hook === undefined) {
    return { ok: false, error: { name: "UnknownHookError", hookName: request.hookName } };
  }

  const handler = input.handlers[request.hookName];
  if (handler === undefined) {
    return { ok: false, error: { name: "MissingHandlerError", hookName: request.hookName } };
  }

  let handlerResult: unknown;
  try {
    handlerResult = await handler(request.payload, request.context);
  } catch (error) {
    return {
      ok: false,
      error: {
        name: "PluginHandlerError",
        hookName: request.hookName,
        message: error instanceof Error ? error.message : "Unknown plugin handler failure"
      }
    };
  }

  return validateHookReturn(request.hookName, hook.type, handlerResult);
}

function validateHookReturn(
  hookName: string,
  hookType: "event" | "transform" | "policy",
  value: unknown
): DispatchResult {
  if (hookType === "event") {
    return { ok: true, value: undefined };
  }

  if (hookType === "transform") {
    if (value === undefined) {
      return {
        ok: false,
        error: {
          name: "HookReturnContractError",
          hookName,
          message: "transform hooks must return a payload"
        }
      };
    }
    return { ok: true, value };
  }

  if (!isPolicyDecision(value)) {
    return {
      ok: false,
      error: {
        name: "HookReturnContractError",
        hookName,
        message: "policy hooks must return allow, deny, or modify with a payload"
      }
    };
  }

  return { ok: true, value };
}

function isPolicyDecision(
  value: unknown
): value is
  | { decision: "allow" }
  | { decision: "deny"; reason?: string }
  | { decision: "modify"; payload: unknown } {
  if (typeof value !== "object" || value === null || !("decision" in value)) {
    return false;
  }

  const decision = value.decision;
  if (decision === "allow" || decision === "deny") {
    return true;
  }

  return decision === "modify" && "payload" in value;
}
