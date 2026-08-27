import { describe, expect, it, vi } from "vitest";
import { definePlugin, type PluginContext } from "../src/index.js";
import type { TenantScriptManifest } from "@tenantscript/manifest";

const manifest = {
  name: "workflow-plugin",
  version: "0.1.0",
  hooks: [
    { name: "invoice.created", type: "event", timeoutMs: 250, schemaVersionRange: "^1.0.0" },
    { name: "webhook.outbound", type: "transform", timeoutMs: 250, schemaVersionRange: "^1.0.0" },
    { name: "invoice.approve", type: "policy", timeoutMs: 250, schemaVersionRange: "^1.0.0" }
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
        "invoice.created": vi.fn().mockResolvedValue({ status: "accepted" })
      }
    });

    const result = await plugin.dispatch({
      hookName: "invoice.created",
      payload: { invoiceId: "inv_1" },
      context
    });

    expect(result).toEqual({ ok: true, value: { status: "accepted" } });
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
      error: { code: "plugin_artifact_invalid" }
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
      error: { code: "plugin_result_invalid" }
    });
  });

  it("requires transform hooks to return a transformed result", async () => {
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
      error: { code: "plugin_result_invalid" }
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
      error: { code: "plugin_result_invalid" }
    });
  });

  it("rejects policy decisions without a reason code", async () => {
    const plugin = definePlugin({
      manifest,
      handlers: {
        "invoice.approve": () => ({ decision: "deny" })
      }
    });

    const result = await plugin.dispatch({
      hookName: "invoice.approve",
      payload: {},
      context
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "plugin_result_invalid" }
    });
  });

  it("rejects the removed modify policy decision", async () => {
    const plugin = definePlugin({
      manifest,
      handlers: {
        "invoice.approve": () => ({ decision: "modify", reasonCode: "not_allowed" })
      }
    });

    await expect(
      plugin.dispatch({ hookName: "invoice.approve", payload: {}, context })
    ).resolves.toEqual({ ok: false, error: { code: "plugin_result_invalid" } });
  });

  it("rejects inherited handlers instead of dispatching them", async () => {
    const inheritedHandlers = Object.create({
      "invoice.created": () => ({ status: "accepted" })
    }) as Record<string, (payload: unknown, context: PluginContext) => unknown>;
    const plugin = definePlugin({ manifest, handlers: inheritedHandlers });

    await expect(
      plugin.dispatch({ hookName: "invoice.created", payload: {}, context })
    ).resolves.toEqual({ ok: false, error: { code: "plugin_artifact_invalid" } });
  });

  it("collapses result accessors that throw into a stable error", async () => {
    const plugin = definePlugin({
      manifest,
      handlers: {
        "invoice.created": () =>
          Object.defineProperty({ status: "accepted" }, "status", {
            enumerable: true,
            get: () => {
              throw new Error("result-secret");
            }
          })
      }
    });

    await expect(
      plugin.dispatch({ hookName: "invoice.created", payload: {}, context })
    ).resolves.toEqual({ ok: false, error: { code: "plugin_result_invalid" } });
  });

  it("rejects non-enumerable host-owned fields in a result", async () => {
    const plugin = definePlugin({
      manifest,
      handlers: {
        "invoice.created": () =>
          Object.defineProperty({ status: "accepted" }, "tenantId", {
            enumerable: false,
            value: "tenant-secret"
          })
      }
    });

    await expect(
      plugin.dispatch({ hookName: "invoice.created", payload: {}, context })
    ).resolves.toEqual({ ok: false, error: { code: "plugin_result_invalid" } });
  });

  it("rejects canonical results with a custom prototype", async () => {
    const plugin = definePlugin({
      manifest,
      handlers: {
        "invoice.created": () =>
          Object.assign(Object.create({ inherited: true }), { status: "accepted" })
      }
    });

    await expect(
      plugin.dispatch({ hookName: "invoice.created", payload: {}, context })
    ).resolves.toEqual({ ok: false, error: { code: "plugin_result_invalid" } });
  });

  it("accepts policy allow and deny decisions with reason codes", async () => {
    for (const decision of [
      { decision: "allow", reasonCode: "approved" },
      { decision: "deny", reasonCode: "not_a_manager" }
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
