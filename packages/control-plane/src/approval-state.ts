export type ApprovalDecision = "approved" | "rejected";
export type ApprovalState = "pending" | ApprovalDecision | "expired";

export interface ApprovalDecisionTransition {
  from: ApprovalState;
  decision: ApprovalDecision;
  to: ApprovalState;
  allowed: boolean;
}

export const approvalDecisionTransitions = [
  { from: "pending", decision: "approved", to: "approved", allowed: true },
  { from: "pending", decision: "rejected", to: "rejected", allowed: true },
  { from: "approved", decision: "approved", to: "approved", allowed: false },
  { from: "approved", decision: "rejected", to: "approved", allowed: false },
  { from: "rejected", decision: "approved", to: "rejected", allowed: false },
  { from: "rejected", decision: "rejected", to: "rejected", allowed: false },
  { from: "expired", decision: "approved", to: "expired", allowed: false },
  { from: "expired", decision: "rejected", to: "expired", allowed: false }
] as const satisfies readonly ApprovalDecisionTransition[];

export function resolveApprovalDecisionTransition(
  from: ApprovalState,
  decision: ApprovalDecision
): ApprovalDecisionTransition {
  const transition = approvalDecisionTransitions.find(
    (candidate) => candidate.from === from && candidate.decision === decision
  );
  if (transition === undefined) {
    throw new Error(`missing approval transition for ${from}:${decision}`);
  }

  return transition;
}
