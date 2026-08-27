import type { HookType, TenantScriptManifest } from "@tenantscript/manifest";

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
  | { code: "plugin_artifact_invalid" }
  | { code: "plugin_result_invalid" };

export interface TransformResult<TOutput = unknown> {
  status: "transformed";
  output: TOutput;
}

export interface PolicyResult {
  decision: "allow" | "deny";
  reasonCode: string;
}

export interface EventResult {
  status: "accepted";
}

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
  let hook;
  try {
    hook = input.manifest.hooks.find((candidate) => candidate.name === request.hookName);
  } catch {
    return { ok: false, error: { code: "plugin_artifact_invalid" } };
  }
  if (hook === undefined) {
    return { ok: false, error: { code: "plugin_artifact_invalid" } };
  }

  let handler: PluginHandler;
  try {
    if (!Object.hasOwn(input.handlers, request.hookName)) {
      return { ok: false, error: { code: "plugin_artifact_invalid" } };
    }
    const candidate = input.handlers[request.hookName];
    if (typeof candidate !== "function") {
      return { ok: false, error: { code: "plugin_artifact_invalid" } };
    }
    handler = candidate;
  } catch {
    return { ok: false, error: { code: "plugin_artifact_invalid" } };
  }

  let handlerResult: unknown;
  try {
    handlerResult = await handler(request.payload, request.context);
  } catch {
    return { ok: false, error: { code: "plugin_result_invalid" } };
  }

  try {
    return validateHookReturn(request.hookName, hook.type, handlerResult);
  } catch {
    return { ok: false, error: { code: "plugin_result_invalid" } };
  }
}

function validateHookReturn(_hookName: string, hookType: HookType, value: unknown): DispatchResult {
  if (hookType === "event") {
    return isEventResult(value)
      ? { ok: true, value }
      : { ok: false, error: { code: "plugin_result_invalid" } };
  }

  if (hookType === "transform") {
    return isTransformResult(value)
      ? { ok: true, value }
      : { ok: false, error: { code: "plugin_result_invalid" } };
  }

  return isPolicyResult(value)
    ? { ok: true, value }
    : { ok: false, error: { code: "plugin_result_invalid" } };
}

function isEventResult(value: unknown): value is EventResult {
  return isRecordWithKeys(value, ["status"]) && value.status === "accepted";
}

function isTransformResult(value: unknown): value is TransformResult {
  return (
    isRecordWithKeys(value, ["status", "output"]) &&
    value.status === "transformed" &&
    value.output !== undefined
  );
}

function isPolicyResult(value: unknown): value is PolicyResult {
  return (
    isRecordWithKeys(value, ["decision", "reasonCode"]) &&
    (value.decision === "allow" || value.decision === "deny") &&
    typeof value.reasonCode === "string" &&
    /^[a-z][a-z0-9._-]{0,63}$/.test(value.reasonCode)
  );
}

function isRecordWithKeys(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownNames = Object.getOwnPropertyNames(value);
  if (
    ownNames.length !== keys.length ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    !keys.every((key) => ownNames.includes(key))
  ) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
  });
}
