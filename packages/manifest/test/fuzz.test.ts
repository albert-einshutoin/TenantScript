import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseManifest, validateConfig } from "../src/index.js";

const validConfigSchema = {
  properties: {
    channel: { type: "string" as const },
    retries: { type: "number" as const, default: 1 }
  },
  required: ["channel"]
};

describe("manifest boundary fuzzing", () => {
  it("returns a structured result for arbitrary manifest input", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const result = parseManifest(input);

        expect(typeof result.ok).toBe("boolean");
        if (!result.ok) {
          expect(result.errors.every(isStructuredIssue)).toBe(true);
        }
      }),
      fuzzParameters()
    );
  });

  it("returns structured errors instead of throwing for arbitrary config input", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const result = validateConfig(validConfigSchema, input);

        expect(typeof result.ok).toBe("boolean");
        if (!result.ok) {
          expect(result.errors.every(isStructuredIssue)).toBe(true);
        }
      }),
      fuzzParameters()
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

function fuzzParameters(): { numRuns: number; seed: number } {
  return {
    numRuns: parsePositiveInteger(process.env.FUZZ_RUNS, 1_000),
    seed: parseInteger(process.env.FUZZ_SEED, 20_260_720)
  };
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
