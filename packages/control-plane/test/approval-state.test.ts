import { describe, expect, it } from "vitest";
import {
  approvalDecisionTransitions,
  resolveApprovalDecisionTransition
} from "../src/approval-state.js";

describe("approval decision state machine", () => {
  it.each(approvalDecisionTransitions)(
    "$from + $decision => $to when allowed=$allowed",
    (transition) => {
      expect(resolveApprovalDecisionTransition(transition.from, transition.decision)).toEqual(
        transition
      );
    }
  );

  it("keeps one table row for every state and decision pair", () => {
    expect(approvalDecisionTransitions).toHaveLength(8);
    expect(
      new Set(
        approvalDecisionTransitions.map((transition) => `${transition.from}:${transition.decision}`)
      ).size
    ).toBe(approvalDecisionTransitions.length);
  });
});
