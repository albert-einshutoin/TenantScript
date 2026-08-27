import type { z } from "zod";
import { maxSatisfying, valid, validRange } from "semver";
import {
  defaultFailurePolicyForHookType,
  isValidHookConfiguration,
  isHookType,
  type FailurePolicy,
  type HookErrorCode,
  type HookType
} from "@tenantscript/manifest";

export {
  allowedFailurePolicies,
  defaultFailurePolicies,
  defaultFailurePolicyForHookType,
  failurePolicies,
  hookErrorCodes,
  hookTypes,
  isAllowedFailurePolicy,
  isHookErrorCode,
  isHookType,
  isValidHookConfiguration,
  type FailurePolicy,
  type HookErrorCode,
  type HookType
} from "@tenantscript/manifest";
export type ExecutionMode = "parallel" | "serial";
export const hookFailureKinds = ["handler_error", "timeout", "budget_exceeded"] as const;
export type HookFailureKind = (typeof hookFailureKinds)[number];

export type EventHookDefinition<TPayload> = {
  type: "event";
  name: string;
  payloadSchema: z.ZodType<TPayload>;
  failurePolicy?: "record-only";
  timeoutMs?: number;
  priority?: number;
};

export type TransformHookDefinition<TPayload> = {
  type: "transform";
  name: string;
  payloadSchema: z.ZodType<TPayload>;
  failurePolicy?: "fail-closed" | "use-original";
  budgetMs: number;
  timeoutMs?: number;
  priority?: number;
};

export type PolicyHookDefinition<TPayload> = {
  type: "policy";
  name: string;
  payloadSchema: z.ZodType<TPayload>;
  failurePolicy?: "fail-closed";
  budgetMs: number;
  timeoutMs?: number;
  priority?: number;
};

export type BlockingHookDefinition<TPayload> =
  | TransformHookDefinition<TPayload>
  | PolicyHookDefinition<TPayload>;

export type HookDefinition<TPayload = unknown> =
  | EventHookDefinition<TPayload>
  | BlockingHookDefinition<TPayload>;

export type DefinedHook<TPayload = unknown> = HookDefinition<TPayload> & {
  failurePolicy: FailurePolicy;
};

export interface HooksDefinition<TPayload = unknown> {
  hooks: readonly DefinedHook<TPayload>[];
}

export interface HookPayloadError {
  name: "HookPayloadError";
  code: "input_invalid";
  hookName: string;
  issues: Array<{ path: string; message: string }>;
}

export interface HookExecutionError {
  name: "HookExecutionError";
  code: "plugin_result_invalid";
  hookName: string;
}

export type HookRunResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HookPayloadError | HookExecutionError };

export class HookContractError extends Error {
  override readonly name = "HookContractError";

  constructor(readonly code: HookErrorCode) {
    super(code);
  }
}

export interface TransformHookResult<TOutput> {
  status: "transformed";
  output: TOutput;
}

export interface PolicyHookResult {
  decision: "allow" | "deny";
  reasonCode: string;
}

export interface EventHookResult {
  status: "accepted";
}

export interface Installation {
  id: string;
  tenantId: string;
  pluginId: string;
  enabled: boolean;
  priority: number;
  hooks: readonly string[];
}

export interface SchemaCompatibleInstallation extends Installation {
  hookSchemaRanges: Readonly<Record<string, string>>;
}

export interface VersionedHookSchema<TPayload> {
  version: string;
  payloadSchema: z.ZodType<unknown>;
  project: (payload: TPayload) => unknown;
}

export interface RoutedHookPayload {
  installationId: string;
  pluginId: string;
  schemaVersion: string;
  payload: unknown;
}

export class HookSchemaCompatibilityError extends Error {
  override readonly name = "HookSchemaCompatibilityError";
}

export interface ExecutionStep {
  installationId: string;
  pluginId: string;
  priority: number;
}

export interface ExecutionPlan {
  hookName: string;
  hookType: HookType;
  failurePolicy: FailurePolicy;
  mode: ExecutionMode;
  steps: readonly ExecutionStep[];
}

export interface HookRetryPolicy {
  hookType: HookType;
  failurePolicy: FailurePolicy;
  retry: boolean;
  maxAttempts: number;
}

export type HookRetryRunResult<TResult> =
  | {
      ok: true;
      value: TResult;
      attempts: number;
    }
  | {
      ok: false;
      error: unknown;
      attempts: number;
      failurePolicy: FailurePolicy;
    };

export function defineHooks<TPayload>(
  hooks: readonly HookDefinition<TPayload>[]
): HooksDefinition<TPayload> {
  return {
    hooks: hooks.map((hook) => {
      if (!isHookType(hook.type)) {
        throw new HookContractError("input_invalid");
      }
      const failurePolicy = hook.failurePolicy ?? defaultFailurePolicyForHookType(hook.type);
      if (!isValidHookConfiguration(hook.name, hook.type, failurePolicy)) {
        throw new HookContractError("input_invalid");
      }
      return { ...hook, failurePolicy } as DefinedHook<TPayload>;
    })
  };
}

export async function runHook<TPayload, TResult>(
  hook: DefinedHook<TPayload>,
  payload: unknown,
  execute: (payload: TPayload) => Promise<TResult> | TResult
): Promise<HookRunResult<TResult>> {
  const parsedPayload = hook.payloadSchema.safeParse(payload);
  if (!parsedPayload.success) {
    return {
      ok: false,
      error: {
        name: "HookPayloadError",
        code: "input_invalid",
        hookName: hook.name,
        issues: parsedPayload.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      }
    };
  }

  try {
    return { ok: true, value: await execute(parsedPayload.data) };
  } catch {
    return {
      ok: false,
      error: { name: "HookExecutionError", code: "plugin_result_invalid", hookName: hook.name }
    };
  }
}

export function planExecution(params: {
  hookName: string;
  hookType: HookType;
  failurePolicy?: FailurePolicy;
  installations: readonly Installation[];
}): ExecutionPlan {
  if (!isHookType(params.hookType)) {
    throw new HookContractError("input_invalid");
  }
  const failurePolicy = params.failurePolicy ?? defaultFailurePolicyForHookType(params.hookType);
  if (!isValidHookConfiguration(params.hookName, params.hookType, failurePolicy)) {
    throw new HookContractError("input_invalid");
  }
  const steps = params.installations
    .filter((installation) => installation.enabled && installation.hooks.includes(params.hookName))
    .map((installation) => ({
      installationId: installation.id,
      pluginId: installation.pluginId,
      priority: installation.priority
    }));

  if (params.hookType === "event") {
    return {
      hookName: params.hookName,
      hookType: params.hookType,
      failurePolicy,
      mode: "parallel",
      steps
    };
  }

  return {
    hookName: params.hookName,
    hookType: params.hookType,
    failurePolicy,
    mode: "serial",
    steps: [...steps].sort((left, right) => left.priority - right.priority)
  };
}

export function routeHookPayloads<TPayload>(params: {
  hookName: string;
  payload: TPayload;
  installations: readonly SchemaCompatibleInstallation[];
  schemas: readonly VersionedHookSchema<TPayload>[];
}): RoutedHookPayload[] {
  const schemasByVersion = new Map<string, VersionedHookSchema<TPayload>>();
  for (const schema of params.schemas) {
    if (valid(schema.version) === null) {
      throw new HookSchemaCompatibilityError(
        `published ${params.hookName} schema version ${schema.version} is invalid`
      );
    }
    if (schemasByVersion.has(schema.version)) {
      throw new HookSchemaCompatibilityError(
        `published ${params.hookName} schema version ${schema.version} is duplicated`
      );
    }
    schemasByVersion.set(schema.version, schema);
  }

  const publishedVersions = [...schemasByVersion.keys()];
  const payloadsByVersion = new Map<string, unknown>();
  const projectPayload = (
    schemaVersion: string,
    schema: VersionedHookSchema<TPayload>
  ): unknown => {
    if (payloadsByVersion.has(schemaVersion)) {
      return payloadsByVersion.get(schemaVersion);
    }

    let projectedPayload: unknown;
    try {
      projectedPayload = schema.project(params.payload);
    } catch {
      // Adapter errors can include customer payload values, so only a stable category
      // crosses the host boundary while the selected version remains diagnosable.
      throw new HookSchemaCompatibilityError(
        `schema adapter failed for ${params.hookName}@${schemaVersion}`
      );
    }
    const parsedPayload = schema.payloadSchema.safeParse(projectedPayload);
    if (!parsedPayload.success) {
      throw new HookSchemaCompatibilityError(
        `schema adapter produced an invalid ${params.hookName}@${schemaVersion} payload`
      );
    }
    // This cache lives only for one routing call, so repeated installations share work
    // without ever retaining or reusing one tenant's payload in another execution.
    payloadsByVersion.set(schemaVersion, parsedPayload.data);
    return parsedPayload.data;
  };

  return params.installations
    .filter((installation) => installation.enabled && installation.hooks.includes(params.hookName))
    .map((installation) => {
      const range = installation.hookSchemaRanges[params.hookName];
      if (range === undefined || validRange(range) === null) {
        throw new HookSchemaCompatibilityError(
          `installation ${installation.id} has no valid ${params.hookName} schema range`
        );
      }
      const schemaVersion = maxSatisfying(publishedVersions, range);
      if (schemaVersion === null) {
        throw new HookSchemaCompatibilityError(
          `installation ${installation.id} has no compatible ${params.hookName} schema for range ${range}`
        );
      }
      const schema = schemasByVersion.get(schemaVersion);
      if (schema === undefined) {
        throw new HookSchemaCompatibilityError(
          `published ${params.hookName} schema ${schemaVersion} could not be resolved`
        );
      }

      return {
        installationId: installation.id,
        pluginId: installation.pluginId,
        schemaVersion,
        payload: projectPayload(schemaVersion, schema)
      };
    });
}

export async function runTransformChain<TPayload>(
  plan: ExecutionPlan,
  initialPayload: TPayload,
  execute: (
    step: ExecutionStep,
    payload: TPayload
  ) => Promise<TransformHookResult<TPayload>> | TransformHookResult<TPayload>
): Promise<TPayload> {
  if (plan.hookType !== "transform") {
    throw new HookContractError("input_invalid");
  }

  let payload = initialPayload;
  for (const step of plan.steps) {
    let result: TransformHookResult<TPayload>;
    try {
      result = await execute(step, payload);
    } catch (error) {
      if (plan.failurePolicy === "use-original") return initialPayload;
      if (error instanceof HookContractError) throw error;
      throw new HookContractError("plugin_result_invalid");
    }
    if (!isCanonicalTransformResult(result)) {
      if (plan.failurePolicy === "use-original") return initialPayload;
      throw new HookContractError("plugin_result_invalid");
    }
    payload = result.output;
  }
  return payload;
}

export function retryPolicyForHookType(hookType: HookType): HookRetryPolicy {
  return {
    hookType,
    failurePolicy: defaultFailurePolicyForHookType(hookType),
    retry: hookType === "event",
    maxAttempts: hookType === "event" ? 2 : 1
  };
}

export function shouldRetryHookFailure(params: {
  hookType: HookType;
  failure: HookFailureKind;
  attempt: number;
}): boolean {
  const policy = retryPolicyForHookType(params.hookType);
  return policy.retry && params.attempt < policy.maxAttempts;
}

export async function runWithRetryPolicy<TResult>(params: {
  hookType: HookType;
  execute: (attempt: number) => Promise<TResult> | TResult;
  failureKind?: HookFailureKind;
}): Promise<HookRetryRunResult<TResult>> {
  const policy = retryPolicyForHookType(params.hookType);
  const failure = params.failureKind ?? "handler_error";

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return {
        ok: true,
        value: await params.execute(attempt),
        attempts: attempt
      };
    } catch (error) {
      if (shouldRetryHookFailure({ hookType: params.hookType, failure, attempt })) {
        continue;
      }

      return {
        ok: false,
        error,
        attempts: attempt,
        failurePolicy: policy.failurePolicy
      };
    }
  }

  throw new Error(`retry policy exhausted without a result for ${params.hookType}`);
}

function isCanonicalTransformResult<TOutput>(
  value: unknown
): value is TransformHookResult<TOutput> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const names = Object.getOwnPropertyNames(value);
    if (
      names.length !== 2 ||
      !names.includes("status") ||
      !names.includes("output") ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      return false;
    }
    const status = Object.getOwnPropertyDescriptor(value, "status");
    const output = Object.getOwnPropertyDescriptor(value, "output");
    return (
      status !== undefined &&
      "value" in status &&
      status.value === "transformed" &&
      output !== undefined &&
      "value" in output &&
      output.value !== undefined
    );
  } catch {
    return false;
  }
}
