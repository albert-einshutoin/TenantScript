import { describe, expect, it, vi } from "vitest";
import { definePlugin, type PluginContext } from "../src/index.js";
import type { TenantScriptManifest } from "@tenantscript/manifest";

const manifest = {
  name: "workflow-plugin",
  version: "0.1.0",
  hooks: [
    { name: "invoice.created", type: "event", timeoutMs: 250 },
    { name: "webhook.outbound", type: "transform", timeoutMs: 250 },
    { name: "invoice.approve", type: "policy", timeoutMs: 250 }
  ],
  capabilities: {
    "slack.send": { channel: "C123" }
  },
  configSchema: {
    properties: {},
    required: []
  },
  egress: { mode: "deny" },
  limits: { cpuMs: 50, timeoutMs: 500 }
} satisfies TenantScriptManifest;

const context: PluginContext = {
  capability: vi.fn()
};

describe("definePlugin", () => {
  it("dispatches a declared handler", async () => {
    const plugin = definePlugin({
      manifest,
      handlers: {
        "invoice.created": vi.fn().mockResolvedValue({ ignored: true })
      }
    });

    const result = await plugin.dispatch({
      hookName: "invoice.created",
      payload: { invoiceId: "inv_1" },
      context
    });

    expect(result).toEqual({ ok: true, value: undefined });
  });

  it("rejects calls to hooks not declared in the manifest", async () => {
    const plugin = definePlugin({ manifest, handlers: {} });

    const result = await plugin.dispatch({
      hookName: "unknown.hook",
      payload: {},
      context
    });

    expect(result).toEqual({
      ok: false,
      error: { name: "UnknownHookError", hookName: "unknown.hook" }
    });
  });

  it("propagates handler exceptions as structured errors", async () => {
    const plugin = definePlugin({
      manifest,
      handlers: {
        "invoice.created": () => {
          throw new Error("boom");
        }
      }
    });

    const result = await plugin.dispatch({
      hookName: "invoice.created",
      payload: {},
      context
    });

    expect(result).toEqual({
      ok: false,
      error: { name: "PluginHandlerError", hookName: "invoice.created", message: "boom" }
    });
  });

  it("requires transform hooks to return a payload", async () => {
    const plugin = definePlugin({
      manifest,
      handlers: {
        "webhook.outbound": () => undefined
      }
    });

    const result = await plugin.dispatch({
      hookName: "webhook.outbound",
      payload: { body: "raw" },
      context
    });

    expect(result).toEqual({
      ok: false,
      error: {
        name: "HookReturnContractError",
        hookName: "webhook.outbound",
        message: "transform hooks must return a payload"
      }
    });
  });

  it("rejects invalid policy decisions", async () => {
    const plugin = definePlugin({
      manifest,
      handlers: {
        "invoice.approve": () => ({ decision: "maybe" })
      }
    });

    const result = await plugin.dispatch({
      hookName: "invoice.approve",
      payload: {},
      context
    });

    expect(result).toEqual({
      ok: false,
      error: {
        name: "HookReturnContractError",
        hookName: "invoice.approve",
        message: "policy hooks must return allow, deny, or modify"
      }
    });
  });

  it("accepts policy allow, deny, and modify decisions", async () => {
    for (const decision of [
      { decision: "allow" },
      { decision: "deny", reason: "not a manager" },
      { decision: "modify", payload: { approved: false } }
    ]) {
      const plugin = definePlugin({
        manifest,
        handlers: {
          "invoice.approve": () => decision
        }
      });

      await expect(
        plugin.dispatch({
          hookName: "invoice.approve",
          payload: {},
          context
        })
      ).resolves.toEqual({ ok: true, value: decision });
    }
  });
});
