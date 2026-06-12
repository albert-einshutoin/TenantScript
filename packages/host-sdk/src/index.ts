import type { z } from "zod";

export const hookTypes = ["event", "transform", "policy"] as const;

export type HookType = (typeof hookTypes)[number];
export type FailurePolicy = "fail-open" | "skip" | "deny";
export type ExecutionMode = "parallel" | "serial";

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
