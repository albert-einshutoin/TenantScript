import { createHash } from "node:crypto";
import type { ExecutionUsageRecordingRequest } from "@tenantscript/control-plane";
import { describe, expect, it, vi } from "vitest";
import type { DynamicWorkerCode } from "../src/cloudflare.js";
import { createCloudflareDynamicWorkerCaller } from "../src/cloudflare.js";

describe("Cloudflare Dynamic Worker runtime caller", () => {
  it("publishes a Worker-compatible caller entrypoint", async () => {
    const cloudflare = await import("../src/cloudflare.js");

    expect(cloudflare.createCloudflareDynamicWorkerCaller).toBeTypeOf("function");
  });

  it("reuses one scoped worker while recording trusted execution evidence per invocation", async () => {
    const artifact =
      "exports.plugin = { dispatch: async () => ({ ok: true, value: undefined }) }; exports.default = exports.plugin;";
    const artifactSha256 = sha256(artifact);
    const loader = createCachingLoader(() =>
      Response.json({ value: { accepted: true, subrequests: 999, workflowRuns: 999 } })
    );
    const loadArtifact = vi.fn(() => Promise.resolve(artifact));
    const capabilityBinding = { call: vi.fn(() => Promise.resolve(undefined)) };
    const createScopeBindings = vi.fn(() => ({ CAPABILITIES: capabilityBinding }));
    const readInvocationEvidence = vi.fn(() =>
      Promise.resolve({
        capabilityCalls: [{ name: "slack.send", status: "success" as const }],
        subrequests: 1,
        workflowRuns: 0
      })
    );
    const record = vi.fn((request: ExecutionUsageRecordingRequest) =>
      Promise.resolve(request.execution)
    );
    const caller = createCloudflareDynamicWorkerCaller({
      loader,
      compatibilityDate: "2026-07-21",
      loadArtifact,
      createScopeBindings,
      readInvocationEvidence,
      recorder: { record },
      now: () => new Date("2026-07-21T00:00:00.000Z"),
      monotonicNow: monotonicClock([10, 13, 20, 25])
    });
    const base = {
      tenantId: "tenant_1",
      installationId: "installation_1",
      pluginId: "plugin_1",
      hookName: "invoice.created",
      hookType: "event" as const,
      version: "1.0.0",
      artifactSha256,
      grantRevision: "grant_7",
      payload: { invoiceId: "inv_1" },
      limits: { cpuMs: 10, timeoutMs: 250, subrequests: 3 }
    };

    const first = await caller.run({ ...base, executionId: "exec_1" });
    const second = await caller.run({ ...base, executionId: "exec_2" });

    expect(first.value).toEqual({ accepted: true, subrequests: 999, workflowRuns: 999 });
    expect(second.value).toEqual({ accepted: true, subrequests: 999, workflowRuns: 999 });
    expect(loader.ids).toHaveLength(2);
    expect(new Set(loader.ids).size).toBe(1);
    expect(loader.ids[0]).toMatch(/^tsdw_[a-f0-9]{32}$/u);
    expect(loadArtifact).toHaveBeenCalledTimes(1);
    expect(createScopeBindings).toHaveBeenCalledTimes(1);
    expect(loader.loadedCode).toMatchObject({
      compatibilityDate: "2026-07-21",
      mainModule: "tenantscript-runtime.js",
      env: { CAPABILITIES: capabilityBinding },
      globalOutbound: null
    });
    expect(loader.loadedCode?.modules["tenant-plugin.cjs"]).toEqual({ cjs: artifact });
    const runtimeModule = loader.loadedCode?.modules["tenantscript-runtime.js"];
    expect(runtimeModule).toBeTypeOf("string");
    if (typeof runtimeModule !== "string") throw new Error("runtime module was not generated");
    expect(runtimeModule).toContain('await import("./tenant-plugin.cjs")');
    expect(runtimeModule).toContain("pluginModule.plugin ??");
    expect(runtimeModule).toContain("plugin.dispatch");
    expect(runtimeModule).toContain("pluginModule.handlers ?? commonJsExports?.handlers");
    expect(runtimeModule).toContain(
      "env.CAPABILITIES.call(input.executionId, name, capabilityInput)"
    );
    expect(runtimeModule).toContain("assertJsonValue(value);");
    expect(runtimeModule).toContain("invalid TenantScript plugin return value");
    expect(runtimeModule).toContain("validateHookReturn(input.hookType, result.value)");
    expect(runtimeModule).toContain("serializeJsonValue(value === undefined ? null : value)");
    expect(runtimeModule).toContain("commonJsExports?.plugin");
    expect(runtimeModule).toContain('safeObjectGetOwnPropertyDescriptor(value, "decision")');
    expect(runtimeModule).toContain("Native Promise await can bypass an own then property");
    expect(runtimeModule).toContain("!tracked.wasObserved()");
    const lossyRuntimeSource = runtimeModule.replace(
      'const pluginModule = await import("./tenant-plugin.cjs");',
      'const pluginModule = { default: { plugin: { dispatch: async () => ({ ok: true, value: new Map([["invoiceId", "inv_1"]]) }) } } };'
    );
    const runtimeNamespace = (await import(
      `data:text/javascript;base64,${Buffer.from(lossyRuntimeSource).toString("base64")}`
    )) as unknown as {
      default: { fetch: (request: Request, env: Record<string, unknown>) => Promise<Response> };
    };
    await expect(
      runtimeNamespace.default.fetch(
        new Request("https://runtime.tenantscript.internal/v1/executions/exec_lossy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            executionId: "exec_lossy",
            hookName: "invoice.created",
            hookType: "transform",
            payload: {}
          })
        }),
        {}
      )
    ).rejects.toThrow("invalid TenantScript plugin return value");
    const legacyRuntimeSource = runtimeModule.replace(
      'const pluginModule = await import("./tenant-plugin.cjs");',
      'const pluginModule = { handlers: { "invoice.policy": async () => ({ arbitrary: true }) } };'
    );
    const legacyRuntimeNamespace = (await import(
      `data:text/javascript;base64,${Buffer.from(legacyRuntimeSource).toString("base64")}`
    )) as unknown as {
      default: { fetch: (request: Request, env: Record<string, unknown>) => Promise<Response> };
    };
    await expect(
      legacyRuntimeNamespace.default.fetch(
        new Request("https://runtime.tenantscript.internal/v1/executions/exec_policy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            executionId: "exec_policy",
            hookName: "invoice.policy",
            hookType: "policy",
            payload: {}
          })
        }),
        {}
      )
    ).rejects.toThrow("TenantScript legacy hook return contract failed");
    await expect(
      legacyRuntimeNamespace.default.fetch(
        new Request("https://runtime.tenantscript.internal/v1/executions/exec_inherited", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            executionId: "exec_inherited",
            hookName: "toString",
            hookType: "event",
            payload: {}
          })
        }),
        {}
      )
    ).rejects.toThrow("TenantScript handler is unavailable");
    const capabilityRuntimeSource = runtimeModule.replace(
      'const pluginModule = await import("./tenant-plugin.cjs");',
      'const pluginModule = { plugin: { dispatch: async ({ context }) => { void context.capability("slack.send", {}); return { ok: true, value: undefined }; } } };'
    );
    const capabilityRuntimeNamespace = (await import(
      `data:text/javascript;base64,${Buffer.from(capabilityRuntimeSource).toString("base64")}`
    )) as unknown as {
      default: { fetch: (request: Request, env: Record<string, unknown>) => Promise<Response> };
    };
    let resolveCapability: (() => void) | undefined;
    const capability = new Promise<void>((resolve) => {
      resolveCapability = resolve;
    });
    const capabilityFetch = capabilityRuntimeNamespace.default.fetch(
      new Request("https://runtime.tenantscript.internal/v1/executions/exec_capability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executionId: "exec_capability",
          hookName: "invoice.created",
          hookType: "event",
          payload: {}
        })
      }),
      { CAPABILITIES: { call: () => capability } }
    );
    let capabilityFetchSettled = false;
    void capabilityFetch.then(() => {
      capabilityFetchSettled = true;
    });
    await Promise.resolve();
    expect(capabilityFetchSettled).toBe(false);
    resolveCapability?.();
    await expect(capabilityFetch).resolves.toBeInstanceOf(Response);
    const caughtCapabilityRuntimeSource = runtimeModule.replace(
      'const pluginModule = await import("./tenant-plugin.cjs");',
      'const pluginModule = { plugin: { dispatch: async ({ context }) => { try { await context.capability("optional.lookup", {}); } catch { return { ok: true, value: undefined }; } return { ok: false }; } } };'
    );
    const caughtCapabilityRuntimeNamespace = (await import(
      `data:text/javascript;base64,${Buffer.from(caughtCapabilityRuntimeSource).toString("base64")}`
    )) as unknown as {
      default: { fetch: (request: Request, env: Record<string, unknown>) => Promise<Response> };
    };
    const caughtCapabilityFetch = caughtCapabilityRuntimeNamespace.default.fetch(
      new Request("https://runtime.tenantscript.internal/v1/executions/exec_caught_capability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executionId: "exec_caught_capability",
          hookName: "invoice.created",
          hookType: "event",
          payload: {}
        })
      }),
      { CAPABILITIES: { call: () => Promise.reject(new Error("optional service unavailable")) } }
    );
    await expect(caughtCapabilityFetch).resolves.toBeInstanceOf(Response);
    const unhandledCapabilityFetch = capabilityRuntimeNamespace.default.fetch(
      new Request("https://runtime.tenantscript.internal/v1/executions/exec_unhandled_capability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executionId: "exec_unhandled_capability",
          hookName: "invoice.created",
          hookType: "event",
          payload: {}
        })
      }),
      { CAPABILITIES: { call: () => Promise.reject(new Error("capability failed")) } }
    );
    await expect(unhandledCapabilityFetch).rejects.toThrow(
      "TenantScript unhandled capability call failed"
    );
    expect(loader.entrypointLimits).toEqual([
      { cpuMs: 10, subRequests: 3 },
      { cpuMs: 10, subRequests: 3 }
    ]);
    expect(loader.requests.map((request) => request.url)).toEqual([
      "https://runtime.tenantscript.internal/v1/executions/exec_1",
      "https://runtime.tenantscript.internal/v1/executions/exec_2"
    ]);
    await expect(Promise.all(loader.requests.map((request) => request.json()))).resolves.toEqual([
      {
        executionId: "exec_1",
        hookName: "invoice.created",
        hookType: "event",
        payload: { invoiceId: "inv_1" }
      },
      {
        executionId: "exec_2",
        hookName: "invoice.created",
        hookType: "event",
        payload: { invoiceId: "inv_1" }
      }
    ]);
    expect(record).toHaveBeenCalledTimes(2);
    const firstRecording = record.mock.calls[0]?.[0];
    expect(firstRecording?.execution).toMatchObject({
      id: "exec_1",
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      status: "success",
      durationMs: 3,
      capabilityCalls: [{ name: "slack.send", status: "success" }]
    });
    expect(firstRecording?.metrics).toEqual({
      hookType: "event",
      cpuMs: 0,
      subrequests: 1,
      workflowRuns: 0
    });
  });

  it("isolates worker reuse across every tenant capability scope and artifact revision", async () => {
    const firstArtifact = "export default { fetch: () => Response.json({ value: 1 }) };";
    const secondArtifact = "export default { fetch: () => Response.json({ value: 2 }) };";
    const artifacts = new Map([
      [sha256(firstArtifact), firstArtifact],
      [sha256(secondArtifact), secondArtifact]
    ]);
    const loader = createCachingLoader(() => Response.json({ value: true }));
    const caller = createCloudflareDynamicWorkerCaller({
      loader,
      compatibilityDate: "2026-07-21",
      loadArtifact: ({ sha256: expected }) => Promise.resolve(artifacts.get(expected) ?? "missing"),
      createScopeBindings: () => ({}),
      readInvocationEvidence: () =>
        Promise.resolve({ capabilityCalls: [], subrequests: 0, workflowRuns: 0 }),
      recorder: { record: ({ execution }) => Promise.resolve(execution) }
    });
    const base = {
      executionId: "exec_base",
      tenantId: "tenant_1",
      installationId: "installation_1",
      pluginId: "plugin_1",
      hookName: "invoice.created",
      hookType: "event" as const,
      version: "1.0.0",
      artifactSha256: sha256(firstArtifact),
      grantRevision: "grant_1",
      payload: {},
      limits: { cpuMs: 10, timeoutMs: 250, subrequests: 2 }
    };
    const variants = [
      base,
      { ...base, executionId: "exec_tenant", tenantId: "tenant_2" },
      { ...base, executionId: "exec_installation", installationId: "installation_2" },
      { ...base, executionId: "exec_plugin", pluginId: "plugin_2" },
      { ...base, executionId: "exec_grant", grantRevision: "grant_2" },
      {
        ...base,
        executionId: "exec_artifact",
        artifactSha256: sha256(secondArtifact)
      }
    ];

    for (const request of variants) await caller.run(request);

    expect(new Set(loader.ids).size).toBe(variants.length);
  });

  it("accepts manifest-valid hook names without narrowing dispatch keys", async () => {
    const artifact = "exports.handlers = { hook: async () => true };";
    const loader = createCachingLoader(() => Response.json({ value: true }));
    const caller = createCloudflareDynamicWorkerCaller({
      loader,
      compatibilityDate: "2026-07-21",
      loadArtifact: () => Promise.resolve(artifact),
      createScopeBindings: () => ({}),
      readInvocationEvidence: () =>
        Promise.resolve({ capabilityCalls: [], subrequests: 0, workflowRuns: 0 }),
      recorder: { record: ({ execution }) => Promise.resolve(execution) }
    });

    await caller.run({
      executionId: "exec_hook_name",
      tenantId: "tenant_1",
      installationId: "installation_1",
      pluginId: "plugin_1",
      hookName: "請求書/ 作成",
      hookType: "event",
      version: "1.0.0",
      artifactSha256: sha256(artifact),
      grantRevision: "grant_1",
      payload: {},
      limits: { cpuMs: 10, timeoutMs: 250, subrequests: 2 }
    });

    await expect(loader.requests[0]?.json()).resolves.toMatchObject({ hookName: "請求書/ 作成" });
  });

  it("invalidates cached worker code when the compatibility date changes", async () => {
    const artifact = "exports.handlers = { event: async () => true };";
    const loader = createCachingLoader(() => Response.json({ value: true }));
    const createCaller = (compatibilityDate: string) =>
      createCloudflareDynamicWorkerCaller({
        loader,
        compatibilityDate,
        loadArtifact: () => Promise.resolve(artifact),
        createScopeBindings: () => ({}),
        readInvocationEvidence: () =>
          Promise.resolve({ capabilityCalls: [], subrequests: 0, workflowRuns: 0 }),
        recorder: { record: ({ execution }) => Promise.resolve(execution) }
      });
    const request = {
      executionId: "exec_compatibility",
      tenantId: "tenant_1",
      installationId: "installation_1",
      pluginId: "plugin_1",
      hookName: "event",
      hookType: "event" as const,
      version: "1.0.0",
      artifactSha256: sha256(artifact),
      grantRevision: "grant_1",
      payload: {},
      limits: { cpuMs: 10, timeoutMs: 250, subrequests: 2 }
    };

    await createCaller("2026-07-20").run(request);
    await createCaller("2026-07-21").run({ ...request, executionId: "exec_compatibility_2" });

    expect(new Set(loader.ids).size).toBe(2);
  });

  it("rejects an artifact hash mismatch before invoking tenant code", async () => {
    const loader = createCachingLoader(() => Response.json({ value: "must-not-run" }));
    const caller = createCloudflareDynamicWorkerCaller({
      loader,
      compatibilityDate: "2026-07-21",
      loadArtifact: () => Promise.resolve("tampered-artifact-secret-sentinel"),
      createScopeBindings: () => ({}),
      readInvocationEvidence: () =>
        Promise.resolve({ capabilityCalls: [], subrequests: 0, workflowRuns: 0 }),
      recorder: { record: ({ execution }) => Promise.resolve(execution) }
    });

    await expect(
      caller.run({
        executionId: "exec_integrity",
        tenantId: "tenant_1",
        installationId: "installation_1",
        pluginId: "plugin_1",
        hookName: "invoice.created",
        hookType: "event",
        version: "1.0.0",
        artifactSha256: "a".repeat(64),
        grantRevision: "grant_1",
        payload: {},
        limits: { cpuMs: 10, timeoutMs: 250, subrequests: 2 }
      })
    ).rejects.toMatchObject({
      name: "CloudflareDynamicWorkerCallerError",
      code: "artifact_integrity_failed",
      message: "artifact_integrity_failed"
    });
    expect(loader.requests).toEqual([]);
  });

  it.each([
    ["provider failure", () => Promise.reject(new Error("artifact-provider-secret-sentinel"))],
    ["oversized code", () => Promise.resolve("x".repeat(4_194_305))]
  ])("rejects %s as a non-reflective artifact failure before execution", async (_label, load) => {
    const loader = createCachingLoader(() => Response.json({ value: "must-not-run" }));
    const record = vi.fn((request: ExecutionUsageRecordingRequest) =>
      Promise.resolve(request.execution)
    );
    const caller = createCloudflareDynamicWorkerCaller({
      loader,
      compatibilityDate: "2026-07-21",
      loadArtifact: load,
      createScopeBindings: () => ({}),
      readInvocationEvidence: () =>
        Promise.resolve({ capabilityCalls: [], subrequests: 0, workflowRuns: 0 }),
      recorder: { record }
    });

    const thrown = await caller
      .run({
        executionId: "exec_artifact_unavailable",
        tenantId: "tenant_1",
        installationId: "installation_1",
        pluginId: "plugin_1",
        hookName: "invoice.created",
        hookType: "event",
        version: "1.0.0",
        artifactSha256: "a".repeat(64),
        grantRevision: "grant_1",
        payload: {},
        limits: { cpuMs: 10, timeoutMs: 250, subrequests: 2 }
      })
      .catch((error: unknown) => error);

    expect(thrown).toMatchObject({
      name: "CloudflareDynamicWorkerCallerError",
      code: "artifact_unavailable",
      message: "artifact_unavailable"
    });
    expect(JSON.stringify(thrown)).not.toContain("secret-sentinel");
    expect(loader.requests).toEqual([]);
    expect(record).not.toHaveBeenCalled();
  });

  it("records a stable error execution before rejecting a runtime exception", async () => {
    const loader = createCachingLoader(() => {
      throw new Error("runtime-provider-secret-sentinel");
    });
    const record = vi.fn((request: ExecutionUsageRecordingRequest) =>
      Promise.resolve(request.execution)
    );
    const caller = createCloudflareDynamicWorkerCaller({
      loader,
      compatibilityDate: "2026-07-21",
      loadArtifact: () => Promise.resolve("runtime-code"),
      createScopeBindings: () => ({}),
      readInvocationEvidence: () =>
        Promise.resolve({
          capabilityCalls: [{ name: "slack.send", status: "error" }],
          subrequests: 1,
          workflowRuns: 0
        }),
      recorder: { record },
      now: () => new Date("2026-07-21T01:00:00.000Z"),
      monotonicNow: monotonicClock([100, 107])
    });

    const thrown = await caller
      .run({
        executionId: "exec_error",
        tenantId: "tenant_1",
        installationId: "installation_1",
        pluginId: "plugin_1",
        hookName: "invoice.created",
        hookType: "event",
        version: "1.0.0",
        artifactSha256: sha256("runtime-code"),
        grantRevision: "grant_1",
        payload: {},
        limits: { cpuMs: 10, timeoutMs: 250, subrequests: 2 }
      })
      .catch((error: unknown) => error);

    expect(thrown).toMatchObject({
      name: "CloudflareDynamicWorkerCallerError",
      code: "runtime_invocation_failed",
      message: "runtime_invocation_failed"
    });
    expect(JSON.stringify(thrown)).not.toContain("secret-sentinel");
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({
      execution: {
        id: "exec_error",
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        hookName: "invoice.created",
        version: "1.0.0",
        status: "error",
        durationMs: 7,
        error: "dynamic_worker_invocation_failed",
        capabilityCalls: [{ name: "slack.send", status: "error" }],
        createdAt: new Date("2026-07-21T01:00:00.000Z")
      },
      metrics: {
        hookType: "event",
        cpuMs: 0,
        subrequests: 1,
        workflowRuns: 0
      }
    });
  });

  it("records a classified Dynamic Worker limit exception as budget exceeded", async () => {
    const limitError = new Error("opaque platform limit");
    const loader = createCachingLoader(() => {
      throw limitError;
    });
    const record = vi.fn((request: ExecutionUsageRecordingRequest) =>
      Promise.resolve(request.execution)
    );
    const caller = createCloudflareDynamicWorkerCaller({
      loader,
      compatibilityDate: "2026-07-21",
      loadArtifact: () => Promise.resolve("runtime-code"),
      createScopeBindings: () => ({}),
      classifyInvocationError: (error) => (error === limitError ? "budget_exceeded" : "error"),
      readInvocationEvidence: () =>
        Promise.resolve({ capabilityCalls: [], subrequests: 0, workflowRuns: 0 }),
      recorder: { record }
    });

    const thrown = await caller
      .run({
        executionId: "exec_budget",
        tenantId: "tenant_1",
        installationId: "installation_1",
        pluginId: "plugin_1",
        hookName: "invoice.created",
        hookType: "event",
        version: "1.0.0",
        artifactSha256: sha256("runtime-code"),
        grantRevision: "grant_1",
        payload: {},
        limits: { cpuMs: 10, timeoutMs: 250, subrequests: 2 }
      })
      .catch((error: unknown) => error);

    expect(thrown).toMatchObject({ code: "runtime_invocation_budget_exceeded" });
    expect(record.mock.calls[0]?.[0].execution).toMatchObject({
      status: "budget_exceeded",
      error: "dynamic_worker_budget_exceeded"
    });
  });

  it("aborts a wall-clock timeout and records a stable timeout execution", async () => {
    vi.useFakeTimers();
    try {
      let invokedRequest: Request | undefined;
      let resolveInvocationStarted: (() => void) | undefined;
      const invocationStarted = new Promise<void>((resolve) => {
        resolveInvocationStarted = resolve;
      });
      const loader = {
        get() {
          return {
            getEntrypoint() {
              return {
                fetch(request: Request) {
                  invokedRequest = request;
                  resolveInvocationStarted?.();
                  // Model a provider promise whose abort rejection reaches Promise.race without an
                  // extra native Promise hop; this preserves the ordering that exposed the deadline race.
                  const rejectionHandlers: Array<(reason: unknown) => unknown> = [];
                  const abortableInvocation = {
                    then(
                      _onFulfilled?: (response: Response) => unknown,
                      onRejected?: (reason: unknown) => unknown
                    ) {
                      if (onRejected !== undefined) rejectionHandlers.push(onRejected);
                      return abortableInvocation;
                    }
                  };
                  request.signal.addEventListener(
                    "abort",
                    () => {
                      for (const reject of rejectionHandlers) {
                        reject(new DOMException("The operation was aborted", "AbortError"));
                      }
                    },
                    { once: true }
                  );
                  return abortableInvocation as unknown as Promise<Response>;
                }
              };
            }
          };
        }
      };
      const record = vi.fn((request: ExecutionUsageRecordingRequest) =>
        Promise.resolve(request.execution)
      );
      const caller = createCloudflareDynamicWorkerCaller({
        loader,
        compatibilityDate: "2026-07-21",
        loadArtifact: () => Promise.resolve("runtime-code"),
        createScopeBindings: () => ({}),
        readInvocationEvidence: () =>
          Promise.resolve({ capabilityCalls: [], subrequests: 0, workflowRuns: 0 }),
        recorder: { record },
        now: () => new Date("2026-07-21T01:00:00.000Z"),
        monotonicNow: monotonicClock([100, 107])
      });

      const run = caller
        .run({
          executionId: "exec_timeout",
          tenantId: "tenant_1",
          installationId: "installation_1",
          pluginId: "plugin_1",
          hookName: "invoice.created",
          hookType: "event",
          version: "1.0.0",
          artifactSha256: sha256("runtime-code"),
          grantRevision: "grant_1",
          payload: {},
          limits: { cpuMs: 10, timeoutMs: 5, subrequests: 2 }
        })
        .catch((error: unknown) => error);
      await invocationStarted;
      await vi.advanceTimersByTimeAsync(5);
      const thrown = await run;

      expect(thrown).toMatchObject({
        code: "runtime_invocation_timed_out",
        message: "runtime_invocation_timed_out"
      });
      expect(invokedRequest?.signal.aborted).toBe(true);
      expect(record).toHaveBeenCalledOnce();
      expect(record.mock.calls[0]?.[0].execution).toMatchObject({
        status: "timeout",
        durationMs: 7,
        error: "dynamic_worker_timeout"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["non-success status", () => Response.json({ value: "response-secret" }, { status: 502 })],
    ["invalid JSON", () => new Response("invalid-response-secret")],
    [
      "oversized body",
      () => Response.json({ value: "x".repeat(1_048_577), secret: "response-secret" })
    ],
    ["widened envelope", () => Response.json({ value: true, token: "response-secret" })]
  ])("records and rejects a %s with one non-reflective error", async (_label, respond) => {
    const loader = createCachingLoader(respond);
    const record = vi.fn((request: ExecutionUsageRecordingRequest) =>
      Promise.resolve(request.execution)
    );
    const caller = createCloudflareDynamicWorkerCaller({
      loader,
      compatibilityDate: "2026-07-21",
      loadArtifact: () => Promise.resolve("runtime-code"),
      createScopeBindings: () => ({}),
      readInvocationEvidence: () =>
        Promise.resolve({ capabilityCalls: [], subrequests: 0, workflowRuns: 0 }),
      recorder: { record }
    });

    const thrown = await caller
      .run({
        executionId: "exec_bad_response",
        tenantId: "tenant_1",
        installationId: "installation_1",
        pluginId: "plugin_1",
        hookName: "invoice.created",
        hookType: "event",
        version: "1.0.0",
        artifactSha256: sha256("runtime-code"),
        grantRevision: "grant_1",
        payload: {},
        limits: { cpuMs: 10, timeoutMs: 250, subrequests: 2 }
      })
      .catch((error: unknown) => error);

    expect(thrown).toMatchObject({ code: "runtime_invocation_failed" });
    expect(JSON.stringify(thrown)).not.toContain("response-secret");
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[0].execution).toMatchObject({
      status: "error",
      error: "dynamic_worker_invocation_failed"
    });
  });

  it("does not record success when trusted evidence observes denied egress", async () => {
    const record = vi.fn((request: ExecutionUsageRecordingRequest) =>
      Promise.resolve(request.execution)
    );
    const caller = createCloudflareDynamicWorkerCaller({
      loader: createCachingLoader(() => Response.json({ value: "caught-denial" })),
      compatibilityDate: "2026-07-21",
      loadArtifact: () => Promise.resolve("runtime-code"),
      createScopeBindings: () => ({}),
      readInvocationEvidence: () =>
        Promise.resolve({
          capabilityCalls: [],
          subrequests: 0,
          workflowRuns: 0,
          deniedEgressAttempts: 1
        }),
      recorder: { record }
    });

    await expect(
      caller.run({
        executionId: "exec_denied_egress",
        tenantId: "tenant_1",
        installationId: "installation_1",
        pluginId: "plugin_1",
        hookName: "invoice.created",
        hookType: "event",
        version: "1.0.0",
        artifactSha256: sha256("runtime-code"),
        grantRevision: "grant_1",
        payload: {},
        limits: { cpuMs: 10, timeoutMs: 250, subrequests: 2 }
      })
    ).rejects.toMatchObject({ code: "runtime_invocation_egress_denied" });
    expect(record.mock.calls[0]?.[0].execution).toMatchObject({
      status: "egress_denied",
      error: "dynamic_worker_egress_denied"
    });
  });

  it("keeps a successful execution when trusted evidence and failure reporting are unavailable", async () => {
    const loader = createCachingLoader(() => Response.json({ value: "completed" }));
    const record = vi.fn((request: ExecutionUsageRecordingRequest) =>
      Promise.resolve(request.execution)
    );
    const reportFailure = vi.fn(() => new Promise<void>(() => undefined));
    const caller = createCloudflareDynamicWorkerCaller({
      loader,
      compatibilityDate: "2026-07-21",
      loadArtifact: () => Promise.resolve("runtime-code"),
      createScopeBindings: () => ({}),
      readInvocationEvidence: () => Promise.reject(new Error("journal-provider-secret-sentinel")),
      recorder: { record },
      reportFailure
    });

    const run = caller.run({
      executionId: "exec_evidence_failure",
      tenantId: "tenant_1",
      installationId: "installation_1",
      pluginId: "plugin_1",
      hookName: "invoice.created",
      hookType: "event",
      version: "1.0.0",
      artifactSha256: sha256("runtime-code"),
      grantRevision: "grant_1",
      payload: {},
      limits: { cpuMs: 10, timeoutMs: 250, subrequests: 2 }
    });
    await vi.waitFor(() => {
      expect(reportFailure).toHaveBeenCalledOnce();
    });
    await vi.waitFor(
      () => {
        expect(record).toHaveBeenCalledOnce();
      },
      { timeout: 100 }
    );
    await expect(run).resolves.toMatchObject({
      value: "completed",
      execution: { status: "success" }
    });
    expect(reportFailure).toHaveBeenCalledWith({
      code: "runtime_evidence_unavailable",
      executionId: "exec_evidence_failure",
      tenantId: "tenant_1",
      pluginId: "plugin_1"
    });
    const recording = record.mock.calls[0]?.[0];
    expect(recording?.execution).toMatchObject({
      status: "success",
      capabilityCalls: []
    });
    expect(recording?.metrics).toEqual({
      hookType: "event",
      cpuMs: 0,
      subrequests: 0,
      workflowRuns: 0
    });
  });

  it("bounds a stalled evidence read before persisting zero evidence", async () => {
    vi.useFakeTimers();
    try {
      let resolveEvidenceStarted: (() => void) | undefined;
      const evidenceStarted = new Promise<void>((resolve) => {
        resolveEvidenceStarted = resolve;
      });
      const record = vi.fn((request: ExecutionUsageRecordingRequest) =>
        Promise.resolve(request.execution)
      );
      const caller = createCloudflareDynamicWorkerCaller({
        loader: createCachingLoader(() => Response.json({ value: "completed" })),
        compatibilityDate: "2026-07-21",
        loadArtifact: () => Promise.resolve("runtime-code"),
        createScopeBindings: () => ({}),
        readInvocationEvidence: () => {
          resolveEvidenceStarted?.();
          return new Promise(() => undefined);
        },
        recorder: { record }
      });

      const run = caller.run({
        executionId: "exec_stalled_evidence",
        tenantId: "tenant_1",
        installationId: "installation_1",
        pluginId: "plugin_1",
        hookName: "invoice.created",
        hookType: "event",
        version: "1.0.0",
        artifactSha256: sha256("runtime-code"),
        grantRevision: "grant_1",
        payload: {},
        limits: { cpuMs: 10, timeoutMs: 250, subrequests: 2 }
      });
      await evidenceStarted;
      await vi.advanceTimersByTimeAsync(250);

      await expect(run).resolves.toMatchObject({ execution: { status: "success" } });
      expect(record.mock.calls[0]?.[0]).toMatchObject({
        execution: { capabilityCalls: [] },
        metrics: { subrequests: 0, workflowRuns: 0 }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects closed, bounded request violations before touching the Loader binding", async () => {
    const loader = createCachingLoader(() => Response.json({ value: true }));
    const loadArtifact = vi.fn(() => Promise.resolve("runtime-code"));
    const record = vi.fn((request: ExecutionUsageRecordingRequest) =>
      Promise.resolve(request.execution)
    );
    const caller = createCloudflareDynamicWorkerCaller({
      loader,
      compatibilityDate: "2026-07-21",
      loadArtifact,
      createScopeBindings: () => ({}),
      readInvocationEvidence: () =>
        Promise.resolve({ capabilityCalls: [], subrequests: 0, workflowRuns: 0 }),
      recorder: { record }
    });
    const base = {
      executionId: "exec_valid",
      tenantId: "tenant_1",
      installationId: "installation_1",
      pluginId: "plugin_1",
      hookName: "invoice.created",
      hookType: "event" as const,
      version: "1.0.0",
      artifactSha256: sha256("runtime-code"),
      grantRevision: "grant_1",
      payload: {},
      limits: { cpuMs: 10, timeoutMs: 250, subrequests: 2 }
    };
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const invalid = [
      { ...base, token: "credential-secret-sentinel" },
      { ...base, executionId: "exec\ninvalid" },
      { ...base, hookName: "x".repeat(257) },
      { ...base, version: `v${"1".repeat(128)}` },
      { ...base, artifactSha256: "A".repeat(64) },
      { ...base, hookType: "unknown" },
      { ...base, limits: { cpuMs: 0, timeoutMs: 250, subrequests: 2 } },
      { ...base, limits: { cpuMs: 10, timeoutMs: 0, subrequests: 2 } },
      { ...base, limits: { cpuMs: 10, timeoutMs: 250, subrequests: -1 } },
      { ...base, payload: circular },
      { ...base, hookName: "invoice\ncreated" },
      { ...base, payload: new Map([["invoiceId", "inv_1"]]) },
      { ...base, payload: { invoiceId: undefined } },
      { ...base, payload: { amount: Number.NaN } },
      {
        ...base,
        payload: Object.defineProperty([], "token", { value: "hidden", enumerable: false })
      },
      { ...base, payload: { value: "x".repeat(1_048_577) } }
    ];
    const codes: unknown[] = [];

    for (const request of invalid) {
      const result = await caller
        .run(request as never)
        .catch((error: unknown) => error as { code?: unknown });
      codes.push("code" in result ? result.code : undefined);
    }

    expect(codes).toEqual(invalid.map(() => "invalid_request"));
    expect(loader.ids).toEqual([]);
    expect(loadArtifact).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("rejects widened configuration before constructing a caller", () => {
    const loader = createCachingLoader(() => Response.json({ value: true }));
    const configuration = {
      loader,
      compatibilityDate: "2026-07-21",
      loadArtifact: () => Promise.resolve("runtime-code"),
      createScopeBindings: () => ({}),
      readInvocationEvidence: () =>
        Promise.resolve({ capabilityCalls: [], subrequests: 0, workflowRuns: 0 }),
      recorder: { record: ({ execution }: { execution: object }) => Promise.resolve(execution) },
      apiToken: "credential-secret-sentinel"
    };

    expect(() => createCloudflareDynamicWorkerCaller(configuration as never)).toThrow(
      expect.objectContaining({
        name: "CloudflareDynamicWorkerCallerError",
        code: "invalid_configuration"
      })
    );
  });

  it.each(["SLACK_TOKEN", "LOADER", "lowercase", "A".repeat(65), "CAPABILITIES"])(
    "rejects unsafe scoped binding name %s before tenant code runs",
    async (bindingName) => {
      const loader = createCachingLoader(() => Response.json({ value: true }));
      const caller = createCloudflareDynamicWorkerCaller({
        loader,
        compatibilityDate: "2026-07-21",
        loadArtifact: () => Promise.resolve("runtime-code"),
        createScopeBindings: () => ({ [bindingName]: { kind: "stub" } }),
        readInvocationEvidence: () =>
          Promise.resolve({ capabilityCalls: [], subrequests: 0, workflowRuns: 0 }),
        recorder: { record: ({ execution }) => Promise.resolve(execution) }
      });

      await expect(
        caller.run({
          executionId: "exec_binding",
          tenantId: "tenant_1",
          installationId: "installation_1",
          pluginId: "plugin_1",
          hookName: "invoice.created",
          hookType: "event",
          version: "1.0.0",
          artifactSha256: sha256("runtime-code"),
          grantRevision: "grant_1",
          payload: {},
          limits: { cpuMs: 10, timeoutMs: 250, subrequests: 2 }
        })
      ).rejects.toMatchObject({ code: "invalid_configuration" });
      expect(loader.requests).toEqual([]);
    }
  );

  it("treats malformed journal evidence as unavailable instead of widening usage authority", async () => {
    const loader = createCachingLoader(() => Response.json({ value: "completed" }));
    const record = vi.fn((request: ExecutionUsageRecordingRequest) =>
      Promise.resolve(request.execution)
    );
    const reportFailure = vi.fn();
    const caller = createCloudflareDynamicWorkerCaller({
      loader,
      compatibilityDate: "2026-07-21",
      loadArtifact: () => Promise.resolve("runtime-code"),
      createScopeBindings: () => ({}),
      readInvocationEvidence: () =>
        Promise.resolve({
          capabilityCalls: [
            { name: "slack.send", status: "success", token: "journal-secret-sentinel" }
          ],
          subrequests: -1,
          workflowRuns: 0
        } as never),
      recorder: { record },
      reportFailure
    });

    await expect(
      caller.run({
        executionId: "exec_bad_evidence",
        tenantId: "tenant_1",
        installationId: "installation_1",
        pluginId: "plugin_1",
        hookName: "invoice.created",
        hookType: "event",
        version: "1.0.0",
        artifactSha256: sha256("runtime-code"),
        grantRevision: "grant_1",
        payload: {},
        limits: { cpuMs: 10, timeoutMs: 250, subrequests: 2 }
      })
    ).resolves.toMatchObject({ value: "completed" });
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "runtime_evidence_unavailable" })
    );
    const recording = record.mock.calls[0]?.[0];
    expect(recording?.execution.capabilityCalls).toEqual([]);
    expect(recording?.metrics).toMatchObject({ subrequests: 0, workflowRuns: 0 });
    expect(JSON.stringify(record.mock.calls)).not.toContain("journal-secret-sentinel");
  });

  it("does not retry or reflect an execution persistence failure", async () => {
    const loader = createCachingLoader(() => Response.json({ value: "completed" }));
    const record = vi.fn(() => Promise.reject(new Error("database-secret-sentinel")));
    const caller = createCloudflareDynamicWorkerCaller({
      loader,
      compatibilityDate: "2026-07-21",
      loadArtifact: () => Promise.resolve("runtime-code"),
      createScopeBindings: () => ({}),
      readInvocationEvidence: () =>
        Promise.resolve({ capabilityCalls: [], subrequests: 0, workflowRuns: 0 }),
      recorder: { record }
    });

    const thrown = await caller
      .run({
        executionId: "exec_store_failure",
        tenantId: "tenant_1",
        installationId: "installation_1",
        pluginId: "plugin_1",
        hookName: "invoice.created",
        hookType: "event",
        version: "1.0.0",
        artifactSha256: sha256("runtime-code"),
        grantRevision: "grant_1",
        payload: {},
        limits: { cpuMs: 10, timeoutMs: 250, subrequests: 2 }
      })
      .catch((error: unknown) => error);

    expect(thrown).toMatchObject({
      code: "execution_recording_failed",
      message: "execution_recording_failed"
    });
    expect(JSON.stringify(thrown)).not.toContain("database-secret-sentinel");
    expect(record).toHaveBeenCalledOnce();
    expect(loader.requests).toHaveLength(1);
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function monotonicClock(values: readonly number[]): () => number {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? 0;
}

function createCachingLoader(respond: (request: Request) => Response | Promise<Response>) {
  const codeById = new Map<string, Promise<DynamicWorkerCode>>();
  const ids: string[] = [];
  const requests: Request[] = [];
  const entrypointLimits: unknown[] = [];
  let loadedCode: DynamicWorkerCode | undefined;

  return {
    ids,
    requests,
    entrypointLimits,
    get loadedCode() {
      return loadedCode;
    },
    get(id: string, getCode: () => DynamicWorkerCode | Promise<DynamicWorkerCode>) {
      ids.push(id);
      let code = codeById.get(id);
      if (code === undefined) {
        code = Promise.resolve(getCode());
        codeById.set(id, code);
      }
      return {
        getEntrypoint(_name?: string | null, options?: { limits?: unknown }) {
          entrypointLimits.push(options?.limits);
          return {
            async fetch(request: Request) {
              loadedCode = await code;
              requests.push(request.clone());
              return respond(request);
            }
          };
        }
      };
    }
  };
}
