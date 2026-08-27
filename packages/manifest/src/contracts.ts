export const hookTypes = ["event", "transform", "policy"] as const;
export type HookType = (typeof hookTypes)[number];

export const failurePolicies = ["fail-closed", "use-original", "record-only"] as const;
export type FailurePolicy = (typeof failurePolicies)[number];

export const allowedFailurePolicies: Readonly<{
  [K in HookType]: readonly FailurePolicy[];
}> = {
  event: ["record-only"],
  transform: ["fail-closed", "use-original"],
  policy: ["fail-closed"]
};

export const defaultFailurePolicies: Readonly<Record<HookType, FailurePolicy>> = {
  event: "record-only",
  transform: "fail-closed",
  policy: "fail-closed"
};

export const hookErrorCodes = [
  "input_invalid",
  "snapshot_unavailable",
  "snapshot_integrity_failed",
  "plugin_artifact_invalid",
  "plugin_timeout",
  "plugin_memory_exceeded",
  "plugin_subrequest_exceeded",
  "plugin_result_invalid",
  "capability_denied",
  "capability_failed",
  "egress_denied",
  "destination_unavailable",
  "evidence_unavailable",
  "runtime_unavailable"
] as const;
export type HookErrorCode = (typeof hookErrorCodes)[number];

export function defaultFailurePolicyForHookType(type: HookType): FailurePolicy {
  return defaultFailurePolicies[type];
}

export function isAllowedFailurePolicy(type: HookType, policy: FailurePolicy): boolean {
  return allowedFailurePolicies[type].includes(policy);
}

export function isValidHookConfiguration(
  name: string,
  type: HookType,
  failurePolicy: FailurePolicy
): boolean {
  return (
    isAllowedFailurePolicy(type, failurePolicy) &&
    (name !== "webhook.outbound" || (type === "transform" && failurePolicy === "fail-closed"))
  );
}

export function isHookType(value: unknown): value is HookType {
  return typeof value === "string" && (hookTypes as readonly string[]).includes(value);
}

export function isHookErrorCode(value: unknown): value is HookErrorCode {
  return typeof value === "string" && (hookErrorCodes as readonly string[]).includes(value);
}
