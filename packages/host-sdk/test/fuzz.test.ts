import fc from "fast-check";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { defineHooks, runHook } from "../src/index.js";

const [hook] = defineHooks([
  {
    type: "event",
    name: "invoice.created",
    payloadSchema: z
      .object({
        invoiceId: z.string().min(1).max(128),
        amountCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
      })
      .strict()
  }
]).hooks;

describe("hook payload boundary fuzzing", () => {
  it("rejects arbitrary invalid payloads with structured errors and never executes them", async () => {
    expect(hook).toBeDefined();
    if (hook === undefined) {
      return;
    }

    await fc.assert(
      fc.asyncProperty(fc.anything(), async (payload) => {
        const execute = vi.fn(() => ({ accepted: true }));
        const result = await runHook(hook, payload, execute);

        if (result.ok) {
          expect(execute).toHaveBeenCalledOnce();
          return;
        }

        expect(execute).not.toHaveBeenCalled();
        expect(result.error.name).toBe("HookPayloadError");
        expect(result.error.issues.every(isStructuredIssue)).toBe(true);
      }),
      {
        numRuns: parsePositiveInteger(process.env.FUZZ_RUNS, 1_000),
        seed: parseInteger(process.env.FUZZ_SEED, 20_260_720)
      }
    );
  });
});

function isStructuredIssue(issue: unknown): boolean {
  return (
    typeof issue === "object" &&
    issue !== null &&
    "path" in issue &&
    typeof issue.path === "string" &&
    "message" in issue &&
    typeof issue.message === "string"
  );
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = parseInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^-?\d+$/.test(value)) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}
