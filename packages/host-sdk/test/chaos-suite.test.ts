import { describe, expect, it, vi } from "vitest";
import {
  hookFailureKinds,
  runWithRetryPolicy,
  type FailurePolicy,
  type HookFailureKind,
  type HookType
} from "../src/index.js";

const hookPolicies = [
  { hookType: "event", attempts: 2, failurePolicy: "fail-open" },
  { hookType: "transform", attempts: 1, failurePolicy: "skip" },
  { hookType: "policy", attempts: 1, failurePolicy: "deny" }
] as const satisfies readonly {
  hookType: HookType;
  attempts: number;
  failurePolicy: FailurePolicy;
}[];

describe("hook failure policy chaos matrix", () => {
  it.each(
    hookPolicies.flatMap((policy) =>
      hookFailureKinds.map((failureKind) => ({ ...policy, failureKind }))
    )
  )(
    "$hookType applies $failurePolicy after $failureKind chaos",
    async ({ hookType, attempts, failurePolicy, failureKind }) => {
      const injectedFailure = chaosFailure(failureKind);
      const execute = vi.fn<() => Promise<never>>().mockRejectedValue(injectedFailure);

      await expect(runWithRetryPolicy({ hookType, failureKind, execute })).resolves.toEqual({
        ok: false,
        error: injectedFailure,
        attempts,
        failurePolicy
      });
      expect(execute).toHaveBeenCalledTimes(attempts);
    }
  );
});

function chaosFailure(kind: HookFailureKind): Error {
  const error = new Error(`synthetic ${kind}`);
  error.name = "SyntheticChaosError";
  return error;
}
