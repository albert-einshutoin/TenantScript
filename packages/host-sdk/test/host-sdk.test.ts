import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineHooks,
  HookSchemaCompatibilityError,
  hookFailureKinds,
  retryPolicyForHookType,
  shouldRetryHookFailure,
  planExecution,
  runHook,
  routeHookPayloads,
  runTransformChain,
  runWithRetryPolicy,
  type HookType,
  type HookDefinition,
  type HooksDefinition,
  type SchemaCompatibleInstallation
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

describe("schema dual-publish routing", () => {
  const schemaV1 = {
    version: "1.0.0",
    payloadSchema: z.object({ invoiceId: z.string() }).strict(),
    project: (payload: { invoiceId: string; amountCents: number }) => ({
      invoiceId: payload.invoiceId
    })
  };
  const schemas = [
    schemaV1,
    {
      version: "2.0.0",
      payloadSchema: invoicePayloadSchema.strict(),
      project: (payload: { invoiceId: string; amountCents: number }) => payload
    }
  ];

  it("delivers the highest compatible payload schema to each installation", () => {
    const deliveries = routeHookPayloads({
      hookName: "invoice.created",
      payload: { invoiceId: "inv_1", amountCents: 5_000 },
      schemas,
      installations: [
        installation({
          id: "v1-only",
          hookSchemaRanges: { "invoice.created": "^1.0.0" }
        }),
        installation({
          id: "v2-only",
          hookSchemaRanges: { "invoice.created": "^2.0.0" }
        }),
        installation({
          id: "both",
          hookSchemaRanges: { "invoice.created": ">=1.0.0 <3.0.0" }
        })
      ]
    });

    expect(deliveries).toEqual([
      {
        installationId: "v1-only",
        pluginId: "plugin",
        schemaVersion: "1.0.0",
        payload: { invoiceId: "inv_1" }
      },
      {
        installationId: "v2-only",
        pluginId: "plugin",
        schemaVersion: "2.0.0",
        payload: { invoiceId: "inv_1", amountCents: 5_000 }
      },
      {
        installationId: "both",
        pluginId: "plugin",
        schemaVersion: "2.0.0",
        payload: { invoiceId: "inv_1", amountCents: 5_000 }
      }
    ]);
  });

  it("fails closed when an enabled installation has no compatible published schema", () => {
    expect(() =>
      routeHookPayloads({
        hookName: "invoice.created",
        payload: { invoiceId: "inv_1", amountCents: 5_000 },
        schemas,
        installations: [
          installation({
            id: "v3-only",
            hookSchemaRanges: { "invoice.created": "^3.0.0" }
          })
        ]
      })
    ).toThrow(
      new HookSchemaCompatibilityError(
        "installation v3-only has no compatible invoice.created schema for range ^3.0.0"
      )
    );
  });

  it("rejects adapter output that does not satisfy the selected schema", () => {
    expect(() =>
      routeHookPayloads({
        hookName: "invoice.created",
        payload: { invoiceId: "inv_1", amountCents: 5_000 },
        schemas: [
          {
            version: "1.0.0",
            payloadSchema: z.object({ invoiceId: z.string() }).strict(),
            project: () => ({ invoiceId: 42 })
          }
        ],
        installations: [
          installation({
            id: "invalid-projection",
            hookSchemaRanges: { "invoice.created": "^1.0.0" }
          })
        ]
      })
    ).toThrow("schema adapter produced an invalid invoice.created@1.0.0 payload");
  });

  it.each([
    {
      name: "invalid",
      schemas: [{ ...schemaV1, version: "v1" }],
      message: "published invoice.created schema version v1 is invalid"
    },
    {
      name: "duplicate",
      schemas: [schemaV1, schemaV1],
      message: "published invoice.created schema version 1.0.0 is duplicated"
    }
  ])("rejects $name published schema versions", ({ schemas: invalidSchemas, message }) => {
    expect(() =>
      routeHookPayloads({
        hookName: "invoice.created",
        payload: { invoiceId: "inv_1", amountCents: 5_000 },
        schemas: invalidSchemas,
        installations: []
      })
    ).toThrow(message);
  });

  it("does not reflect adapter errors or payloads across the host boundary", () => {
    expect(() =>
      routeHookPayloads({
        hookName: "invoice.created",
        payload: { invoiceId: "customer-secret", amountCents: 5_000 },
        schemas: [
          {
            ...schemaV1,
            project: () => {
              throw new Error("customer-secret");
            }
          }
        ],
        installations: [
          installation({
            id: "adapter-failure",
            hookSchemaRanges: { "invoice.created": "^1.0.0" }
          })
        ]
      })
    ).toThrow("schema adapter failed for invoice.created@1.0.0");
  });

  it("requires a valid range for every enabled hook installation", () => {
    expect(() =>
      routeHookPayloads({
        hookName: "invoice.created",
        payload: { invoiceId: "inv_1", amountCents: 5_000 },
        schemas,
        installations: [installation({ hookSchemaRanges: {} })]
      })
    ).toThrow("installation inst has no valid invoice.created schema range");
  });

  it("projects each selected schema once per hook routing call", () => {
    const project = vi.fn(schemaV1.project);

    routeHookPayloads({
      hookName: "invoice.created",
      payload: { invoiceId: "inv_1", amountCents: 5_000 },
      schemas: [{ ...schemaV1, project }],
      installations: [installation({ id: "first" }), installation({ id: "second" })]
    });

    expect(project).toHaveBeenCalledOnce();
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

function installation(
  overrides: Partial<SchemaCompatibleInstallation>
): SchemaCompatibleInstallation {
  return {
    id: "inst",
    tenantId: "tenant_1",
    pluginId: "plugin",
    enabled: true,
    priority: 10,
    hooks: ["invoice.created"],
    hookSchemaRanges: { "invoice.created": "^1.0.0" },
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
