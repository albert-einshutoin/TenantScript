import type { z } from "zod";
import { maxSatisfying, valid, validRange } from "semver";

export const hookTypes = ["event", "transform", "policy"] as const;

export type HookType = (typeof hookTypes)[number];
export type FailurePolicy = "fail-open" | "skip" | "deny";
export type ExecutionMode = "parallel" | "serial";
export const hookFailureKinds = ["handler_error", "timeout", "budget_exceeded"] as const;
export type HookFailureKind = (typeof hookFailureKinds)[number];

export type EventHookDefinition<TPayload> = {
  type: "event";
  name: string;
  payloadSchema: z.ZodType<TPayload>;
  timeoutMs?: number;
  priority?: number;
};

export type BlockingHookDefinition<TPayload> = {
  type: "transform" | "policy";
  name: string;
  payloadSchema: z.ZodType<TPayload>;
  budgetMs: number;
  timeoutMs?: number;
  priority?: number;
};

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
  hookName: string;
  issues: Array<{ path: string; message: string }>;
}

export type HookRunResult<T> = { ok: true; value: T } | { ok: false; error: HookPayloadError };

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
    hooks: hooks.map((hook) => ({
      ...hook,
      failurePolicy: defaultFailurePolicyFor(hook.type)
    }))
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
        hookName: hook.name,
        issues: parsedPayload.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      }
    };
  }

  return { ok: true, value: await execute(parsedPayload.data) };
}

export function planExecution(params: {
  hookName: string;
  hookType: HookType;
  installations: readonly Installation[];
}): ExecutionPlan {
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
      mode: "parallel",
      steps
    };
  }

  return {
    hookName: params.hookName,
    hookType: params.hookType,
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
  execute: (step: ExecutionStep, payload: TPayload) => Promise<TPayload> | TPayload
): Promise<TPayload> {
  if (plan.hookType !== "transform") {
    throw new Error("runTransformChain only accepts transform execution plans");
  }

  let payload = initialPayload;
  for (const step of plan.steps) {
    payload = await execute(step, payload);
  }
  return payload;
}

export function retryPolicyForHookType(hookType: HookType): HookRetryPolicy {
  return {
    hookType,
    failurePolicy: defaultFailurePolicyFor(hookType),
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

function defaultFailurePolicyFor(type: HookType): FailurePolicy {
  switch (type) {
    case "event":
      return "fail-open";
    case "transform":
      return "skip";
    case "policy":
      return "deny";
  }

  throw new Error(`Unknown hook type: ${String(type)}`);
}
