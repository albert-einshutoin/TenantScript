import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ScopedRuntimeLimitError,
  ScopedRuntimeTimeoutError,
  bundlePlugin,
  createApprovalContinuationRunner,
  runScopedHandler
} from "../src/index.js";

describe("bundlePlugin", () => {
  it("produces deterministic hashes for the same input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tenantscript-loader-"));
    const entry = join(dir, "plugin.ts");
    await writeFile(
      entry,
      [
        "const channel = 'C123';",
        "export const handlers = {",
        "  'invoice.created': () => ({ channel })",
        "};"
      ].join("\n")
    );

    const first = await bundlePlugin(entry);
    const second = await bundlePlugin(entry);

    expect(first.sha256).toBe(second.sha256);
    expect(first.code).toBe(second.code);
  });

  it("changes the hash when bundle content changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tenantscript-loader-"));
    const entry = join(dir, "plugin.ts");
    await writeFile(entry, "export const handlers = { 'invoice.created': () => 'v1' };");
    const first = await bundlePlugin(entry);

    await writeFile(entry, "export const handlers = { 'invoice.created': () => 'v2' };");
    const second = await bundlePlugin(entry);

    expect(first.sha256).not.toBe(second.sha256);
  });

  it("resolves external relative imports into the bundle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tenantscript-loader-"));
    const entry = join(dir, "plugin.ts");
    const helper = join(dir, "helper.ts");
    await writeFile(helper, "export const message = 'from-helper';");
    await writeFile(
      entry,
      "import { message } from './helper'; export const handlers = { 'invoice.created': () => message };"
    );

    const bundle = await bundlePlugin(entry);

    expect(bundle.code).toContain("from-helper");
  });
});

describe("runScopedHandler", () => {
  it("injects only scoped context and hides process/global bindings", async () => {
    const bundle = await bundleFromSource(`
      exports.handlers = {
        "invoice.created": async (_payload, context) => ({
          canUseCapability: await context.capability("slack.send", { channel: "C123" }),
          processVisible: typeof process !== "undefined",
          secretBindingVisible: typeof SECRET_BINDING !== "undefined"
        })
      };
    `);

    const result = await runScopedHandler({
      bundleCode: bundle,
      handlerName: "invoice.created",
      payload: {},
      context: {
        capability: vi.fn().mockResolvedValue("ok")
      }
    });

    expect(result.value).toEqual({
      canUseCapability: "ok",
      processVisible: false,
      secretBindingVisible: false
    });
  });

  it("denies outbound fetch by default and records egress_denied", async () => {
    const bundle = await bundleFromSource(`
      exports.handlers = {
        "invoice.created": async () => {
          await fetch("https://example.com/webhook");
        }
      };
    `);

    await expect(
      runScopedHandler({
        bundleCode: bundle,
        handlerName: "invoice.created",
        payload: {},
        context: { capability: vi.fn() }
      })
    ).rejects.toThrow("egress denied: https://example.com/webhook");
  });

  it("keeps egress denial logs for audit", async () => {
    const bundle = await bundleFromSource(`
      exports.handlers = {
        "invoice.created": async () => {
          try {
            await fetch("https://example.com/webhook");
          } catch (_error) {
            return "handled";
          }
        }
      };
    `);

    const result = await runScopedHandler({
      bundleCode: bundle,
      handlerName: "invoice.created",
      payload: {},
      context: { capability: vi.fn() }
    });

    expect(result).toEqual({
      value: "handled",
      logs: [{ reason: "egress_denied", target: "https://example.com/webhook" }]
    });
  });

  it("records URL object egress attempts", async () => {
    const bundle = await bundleFromSource(`
      exports.handlers = {
        "invoice.created": async () => {
          try {
            await fetch(new URL("https://example.com/url-object"));
          } catch (_error) {
            return "handled";
          }
        }
      };
    `);

    const result = await runScopedHandler({
      bundleCode: bundle,
      handlerName: "invoice.created",
      payload: {},
      context: { capability: vi.fn() }
    });

    expect(result.logs).toEqual([
      { reason: "egress_denied", target: "https://example.com/url-object" }
    ]);
  });

  it("terminates synchronous infinite-loop handlers with a timeout status", async () => {
    const bundle = await bundleFromSource(`
      exports.handlers = {
        "invoice.created": () => {
          while (true) {}
        }
      };
    `);

    await expect(
      runScopedHandler({
        bundleCode: bundle,
        handlerName: "invoice.created",
        payload: {},
        context: { capability: vi.fn() },
        limits: { timeoutMs: 10 }
      })
    ).rejects.toMatchObject({
      name: "ScopedRuntimeTimeoutError",
      executionStatus: "timeout"
    } satisfies Partial<ScopedRuntimeTimeoutError>);
  });

  it("terminates async handlers that starve the microtask queue", async () => {
    const bundle = await bundleFromSource(`
      exports.handlers = {
        "invoice.created": async () => {
          while (true) {
            await Promise.resolve();
          }
        }
      };
    `);
    const startedAt = Date.now();

    await expect(
      runScopedHandler({
        bundleCode: bundle,
        handlerName: "invoice.created",
        payload: {},
        context: { capability: vi.fn() },
        limits: { timeoutMs: 25 }
      })
    ).rejects.toMatchObject({
      name: "ScopedRuntimeTimeoutError",
      executionStatus: "timeout"
    } satisfies Partial<ScopedRuntimeTimeoutError>);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("rejects capability calls after the subrequest limit is exceeded", async () => {
    const bundle = await bundleFromSource(`
      exports.handlers = {
        "invoice.created": async (_payload, context) => {
          await context.capability("slack.send", { channel: "C123", text: "one" });
          await context.capability("slack.send", { channel: "C123", text: "two" });
        }
      };
    `);

    await expect(
      runScopedHandler({
        bundleCode: bundle,
        handlerName: "invoice.created",
        payload: {},
        context: { capability: vi.fn().mockResolvedValue({ ok: true }) },
        limits: { maxSubrequests: 1 }
      })
    ).rejects.toThrow(ScopedRuntimeLimitError);
  });

  it("records subrequest limit violations for audit", async () => {
    const bundle = await bundleFromSource(`
      exports.handlers = {
        "invoice.created": async (_payload, context) => {
          await context.capability("slack.send", { channel: "C123", text: "one" });
          await context.capability("slack.send", { channel: "C123", text: "two" });
        }
      };
    `);

    const capability = vi.fn().mockResolvedValue({ ok: true });
    let error: unknown;

    try {
      await runScopedHandler({
        bundleCode: bundle,
        handlerName: "invoice.created",
        payload: {},
        context: { capability },
        limits: { maxSubrequests: 1 }
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ScopedRuntimeLimitError);
    expect(error).toMatchObject({
      executionStatus: "budget_exceeded",
      logs: [{ reason: "subrequest_limit_exceeded", target: "capability:slack.send" }]
    });
    expect(capability).toHaveBeenCalledOnce();
  });

  it("propagates capability failures across the worker boundary", async () => {
    const bundle = await bundleFromSource(`
      exports.handlers = {
        "invoice.created": async (_payload, context) => {
          await context.capability("slack.send", { channel: "C123", text: "fail" });
        }
      };
    `);

    await expect(
      runScopedHandler({
        bundleCode: bundle,
        handlerName: "invoice.created",
        payload: {},
        context: {
          capability: vi.fn().mockRejectedValue(new Error("capability failed"))
        }
      })
    ).rejects.toThrow("capability failed");
  });

  it("serializes non-error capability failures across the worker boundary", async () => {
    const bundle = await bundleFromSource(`
      exports.handlers = {
        "invoice.created": async (_payload, context) => {
          await context.capability("slack.send", { channel: "C123", text: "fail" });
        }
      };
    `);

    await expect(
      runScopedHandler({
        bundleCode: bundle,
        handlerName: "invoice.created",
        payload: {},
        context: {
          capability: vi.fn().mockRejectedValue("capability failed")
        }
      })
    ).rejects.toThrow("capability failed");
  });

  it("rejects bundles without a handlers object", async () => {
    await expect(
      runScopedHandler({
        bundleCode: "exports.notHandlers = {};",
        handlerName: "invoice.created",
        payload: {},
        context: { capability: vi.fn() }
      })
    ).rejects.toThrow("plugin bundle must export a handlers object");
  });

  it("rejects missing handlers", async () => {
    await expect(
      runScopedHandler({
        bundleCode: "exports.handlers = {};",
        handlerName: "invoice.created",
        payload: {},
        context: { capability: vi.fn() }
      })
    ).rejects.toThrow("plugin bundle does not export handler invoice.created");
  });
});

describe("createApprovalContinuationRunner", () => {
  it("runs the approval resumeHook with the decision payload", async () => {
    const capture = vi.fn().mockResolvedValue({ ok: true });
    const runner = createApprovalContinuationRunner({
      bundleCode: await bundleFromSource(`
        exports.handlers = {
          onInvoiceApprovalDecided: async (payload, context) => {
            await context.capability("test.capture", payload);
          }
        };
      `),
      version: "1.0.0",
      context: { capability: capture },
      generateExecutionId: () => "exec_resume_1",
      now: () => new Date("2026-06-13T01:15:00.000Z")
    });

    await expect(
      runner.runApprovalContinuation({
        approval: {
          id: "approval_1",
          tenantId: "tenant_1",
          pluginId: "plugin_1",
          role: "manager",
          subject: { invoiceId: "inv_1" },
          resumeHook: "onInvoiceApprovalDecided",
          state: "approved",
          expiresAt: new Date("2026-06-14T01:00:00.000Z"),
          createdAt: new Date("2026-06-13T01:00:00.000Z"),
          decidedBy: "manager@example.com",
          decidedAt: new Date("2026-06-13T01:15:00.000Z")
        },
        payload: {
          approvalId: "approval_1",
          decision: "approved",
          subject: { invoiceId: "inv_1" },
          decidedBy: "manager@example.com"
        },
        decidedAt: new Date("2026-06-13T01:15:00.000Z")
      })
    ).resolves.toEqual({
      id: "exec_resume_1",
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      hookName: "onInvoiceApprovalDecided",
      version: "1.0.0",
      status: "success",
      durationMs: 0,
      capabilityCalls: [],
      createdAt: new Date("2026-06-13T01:15:00.000Z")
    });
    expect(capture).toHaveBeenCalledWith("test.capture", {
      approvalId: "approval_1",
      decision: "approved",
      subject: { invoiceId: "inv_1" },
      decidedBy: "manager@example.com"
    });
  });

  it("supports default clocks and scoped runtime limits", async () => {
    const runner = createApprovalContinuationRunner({
      bundleCode: await bundleFromSource(`
        exports.handlers = {
          onInvoiceApprovalDecided: () => "continued"
        };
      `),
      version: "1.0.0",
      context: { capability: vi.fn() },
      limits: { timeoutMs: 250, maxSubrequests: 0 },
      generateExecutionId: () => "exec_resume_default_clock"
    });

    await expect(
      runner.runApprovalContinuation({
        approval: {
          id: "approval_1",
          tenantId: "tenant_1",
          pluginId: "plugin_1",
          role: "manager",
          subject: { invoiceId: "inv_1" },
          resumeHook: "onInvoiceApprovalDecided",
          state: "rejected",
          expiresAt: new Date("2026-06-14T01:00:00.000Z"),
          createdAt: new Date("2026-06-13T01:00:00.000Z"),
          decidedBy: "manager@example.com",
          decidedAt: new Date("2026-06-13T01:15:00.000Z")
        },
        payload: {
          approvalId: "approval_1",
          decision: "rejected",
          subject: { invoiceId: "inv_1" },
          decidedBy: "manager@example.com"
        },
        decidedAt: new Date("2026-06-13T01:15:00.000Z")
      })
    ).resolves.toEqual(
      expect.objectContaining({
        id: "exec_resume_default_clock",
        status: "success",
        hookName: "onInvoiceApprovalDecided"
      })
    );
  });
});

async function bundleFromSource(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "tenantscript-loader-"));
  const entry = join(dir, "plugin.cjs");
  await writeFile(entry, source);
  const bundled = await bundlePlugin(entry);
  const code = await readFile(entry, "utf8");
  expect(bundled.sha256).toMatch(/^[a-f0-9]{64}$/);
  return code;
}
