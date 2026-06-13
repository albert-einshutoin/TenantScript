import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineHooks,
  hookFailureKinds,
  retryPolicyForHookType,
  shouldRetryHookFailure,
  planExecution,
  runHook,
  runTransformChain,
  runWithRetryPolicy,
  type HookType,
  type HookDefinition,
  type HooksDefinition,
  type Installation
} from "../src/index.js";

const invoicePayloadSchema = z.object({
  invoiceId: z.string(),
  amountCents: z.number()
});

describe("defineHooks", () => {
  it("assigns default failure policies by hook type", () => {
    const definition = defineHooks([
      { type: "event", name: "invoice.created", payloadSchema: invoicePayloadSchema },
      {
        type: "transform",
        name: "webhook.outbound",
        payloadSchema: invoicePayloadSchema,
        budgetMs: 10
      },
      { type: "policy", name: "invoice.approve", payloadSchema: invoicePayloadSchema, budgetMs: 10 }
    ]);

    expect(definition.hooks.map((hook) => [hook.type, hook.failurePolicy])).toEqual([
      ["event", "fail-open"],
      ["transform", "skip"],
      ["policy", "deny"]
    ]);
  });

  it("rejects unknown hook types at runtime when untyped input is forced through", () => {
    expect(() =>
      defineHooks([
        {
          type: "unknown",
          name: "bad.hook",
          payloadSchema: invoicePayloadSchema
        } as unknown as HookDefinition
      ])
    ).toThrow();
  });

  it("rejects blocking hooks without a budget at type level", () => {
    defineHooks([
      // @ts-expect-error transform hooks must declare a budgetMs value.
      { type: "transform", name: "webhook.outbound", payloadSchema: invoicePayloadSchema }
    ]);
  });
});

describe("runHook", () => {
  it("does not execute the handler when payload validation fails", async () => {
    const hook = onlyHook(
      defineHooks([{ type: "event", name: "invoice.created", payloadSchema: invoicePayloadSchema }])
    );
    const execute = vi.fn();

    const result = await runHook(hook, { invoiceId: "inv_1" }, execute);

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      error: {
        name: "HookPayloadError",
        hookName: "invoice.created",
        issues: [{ path: "amountCents", message: "Required" }]
      }
    });
  });

  it("passes parsed payloads to the handler", async () => {
    const hook = onlyHook(
      defineHooks([{ type: "event", name: "invoice.created", payloadSchema: invoicePayloadSchema }])
    );

    const result = await runHook(hook, { invoiceId: "inv_1", amountCents: 5000 }, (payload) => ({
      accepted: payload.amountCents > 0
    }));

    expect(result).toEqual({ ok: true, value: { accepted: true } });
  });
});

describe("retry policy", () => {
  it.each([
    { hookType: "event", failurePolicy: "fail-open", retry: true },
    { hookType: "transform", failurePolicy: "skip", retry: false },
    { hookType: "policy", failurePolicy: "deny", retry: false }
  ] as const)("maps $hookType hooks to retry=$retry", ({ hookType, failurePolicy, retry }) => {
    expect(retryPolicyForHookType(hookType)).toEqual({
      hookType,
      failurePolicy,
      maxAttempts: retry ? 2 : 1,
      retry
    });
  });

  it.each(
    (["event", "transform", "policy"] satisfies HookType[]).flatMap((hookType) =>
      hookFailureKinds.map((failure) => ({
        hookType,
        failure,
        retry: hookType === "event"
      }))
    )
  )("decides retry for $hookType $failure failures", ({ hookType, failure, retry }) => {
    expect(shouldRetryHookFailure({ hookType, failure, attempt: 1 })).toBe(retry);
  });

  it("stops event retries after the at-least-once retry attempt", () => {
    expect(
      shouldRetryHookFailure({ hookType: "event", failure: "handler_error", attempt: 2 })
    ).toBe(false);
  });

  it("retries event failures once and returns the successful retry result", async () => {
    const execute = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce("delivered");

    await expect(runWithRetryPolicy({ hookType: "event", execute })).resolves.toEqual({
      ok: true,
      value: "delivered",
      attempts: 2
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each([
    { hookType: "transform", failurePolicy: "skip" },
    { hookType: "policy", failurePolicy: "deny" }
  ] as const)("does not retry $hookType failures", async ({ hookType, failurePolicy }) => {
    const error = new Error("blocking failure");
    const execute = vi.fn<() => Promise<string>>().mockRejectedValue(error);

    await expect(runWithRetryPolicy({ hookType, execute })).resolves.toEqual({
      ok: false,
      error,
      attempts: 1,
      failurePolicy
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe("planExecution", () => {
  const installations = [
    installation({ id: "inst_3", pluginId: "plugin_c", priority: 30 }),
    installation({ id: "inst_1", pluginId: "plugin_a", priority: 10 }),
    installation({ id: "disabled", pluginId: "plugin_disabled", priority: 0, enabled: false }),
    installation({
      id: "other_hook",
      pluginId: "plugin_other",
      priority: 5,
      hooks: ["other.hook"]
    }),
    installation({ id: "inst_2", pluginId: "plugin_b", priority: 20 })
  ];

  it("plans event hooks for parallel execution without priority sorting", () => {
    const plan = planExecution({
      hookName: "invoice.created",
      hookType: "event",
      installations
    });

    expect(plan.mode).toBe("parallel");
    expect(plan.steps.map((step) => step.installationId)).toEqual(["inst_3", "inst_1", "inst_2"]);
  });

  it("plans transform hooks for serial priority order and excludes disabled installations", () => {
    const plan = planExecution({
      hookName: "invoice.created",
      hookType: "transform",
      installations
    });

    expect(plan.mode).toBe("serial");
    expect(plan.steps.map((step) => step.installationId)).toEqual(["inst_1", "inst_2", "inst_3"]);
  });

  it("threads transform output into the next transform input", async () => {
    const plan = planExecution({
      hookName: "invoice.created",
      hookType: "transform",
      installations
    });

    const result = await runTransformChain(plan, { value: "" }, (step, payload) => ({
      value: `${payload.value}${step.installationId}`
    }));

    expect(result.value).toBe("inst_1inst_2inst_3");
  });
});

function installation(overrides: Partial<Installation>): Installation {
  return {
    id: "inst",
    tenantId: "tenant_1",
    pluginId: "plugin",
    enabled: true,
    priority: 10,
    hooks: ["invoice.created"],
    ...overrides
  };
}

function onlyHook<TPayload>(definition: HooksDefinition<TPayload>) {
  const hook = definition.hooks[0];
  if (hook === undefined) {
    throw new Error("expected hook definition");
  }
  return hook;
}
