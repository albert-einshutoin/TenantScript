import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ScopedRuntimeLimitError,
  ScopedRuntimeTimeoutError,
  bundlePlugin,
  runScopedHandler
} from "../src/index.js";

describe("loader chaos scenarios", () => {
  it("terminates a CPU-bound plugin within its wall-clock budget", async () => {
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
        limits: { timeoutMs: 20, memoryMb: 32 }
      })
    ).rejects.toBeInstanceOf(ScopedRuntimeTimeoutError);
  });

  it("terminates a memory-exhausting plugin without crashing the host process", async () => {
    const bundle = await bundleFromSource(`
      exports.handlers = {
        "invoice.created": () => {
          const retained = [];
          while (true) {
            retained.push(new Array(250000).fill(retained.length));
          }
        }
      };
    `);

    await expect(
      runScopedHandler({
        bundleCode: bundle,
        handlerName: "invoice.created",
        payload: {},
        context: { capability: vi.fn() },
        limits: { timeoutMs: 2_000, memoryMb: 16 }
      })
    ).rejects.toMatchObject({
      name: "ScopedRuntimeLimitError",
      executionStatus: "budget_exceeded"
    } satisfies Partial<ScopedRuntimeLimitError>);
  });

  it("contains recursive plugin failure inside the worker", async () => {
    const bundle = await bundleFromSource(`
      const recurse = () => recurse();
      exports.handlers = {
        "invoice.created": recurse
      };
    `);

    await expect(
      runScopedHandler({
        bundleCode: bundle,
        handlerName: "invoice.created",
        payload: {},
        context: { capability: vi.fn() },
        limits: { timeoutMs: 250, memoryMb: 32 }
      })
    ).rejects.toMatchObject({ name: "RangeError" });
  });

  it("propagates a stopped broker as an execution failure without hanging", async () => {
    const bundle = await bundleFromSource(`
      exports.handlers = {
        "invoice.created": (_payload, context) =>
          context.capability("slack.send", { channel: "C123", text: "hello" })
      };
    `);

    await expect(
      runScopedHandler({
        bundleCode: bundle,
        handlerName: "invoice.created",
        payload: {},
        context: {
          capability: vi.fn().mockRejectedValue(new Error("synthetic broker unavailable"))
        },
        limits: { timeoutMs: 250, memoryMb: 32 }
      })
    ).rejects.toThrow("synthetic broker unavailable");
  });

  it.each([
    [{ timeoutMs: 0 }, "runtime timeoutMs must be a positive safe integer"],
    [{ maxSubrequests: -1 }, "runtime maxSubrequests must be a non-negative safe integer"],
    [{ memoryMb: 7 }, "runtime memoryMb must be a safe integer of at least 8"]
  ] as const)("rejects invalid runtime limits before worker startup", async (limits, message) => {
    const bundle = await bundleFromSource(`
      exports.handlers = {
        "invoice.created": () => "ok"
      };
    `);

    await expect(
      runScopedHandler({
        bundleCode: bundle,
        handlerName: "invoice.created",
        payload: {},
        context: { capability: vi.fn() },
        limits
      })
    ).rejects.toThrow(message);
  });
});

async function bundleFromSource(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tenantscript-loader-chaos-"));
  const entry = join(dir, "plugin.cjs");
  await writeFile(entry, source);
  const bundled = await bundlePlugin(entry);
  expect(bundled.sha256).toMatch(/^[a-f0-9]{64}$/);
  return readFile(entry, "utf8");
}
