import type { DoctorRuntimePrimitive } from "./doctor.js";

export type SetupRuntimePrimitive = DoctorRuntimePrimitive;

export type SetupResourceKind =
  | "worker"
  | "d1"
  | "r2"
  | "durable-object"
  | "workflow"
  | "analytics-engine"
  | "migration";

export interface SetupOperation {
  id: string;
  kind: SetupResourceKind;
  action: "create" | "declare" | "apply" | "bind";
  logicalName: string;
  implementationStatus: "implemented" | "integration-required";
  dependsOn: string[];
}

export interface SetupPermission {
  id:
    | "workers:write"
    | "d1:write"
    | "r2:write"
    | "durable-objects:write"
    | "workflows:write"
    | "analytics-engine:write";
  reason: string;
}

export interface SetupCostBoundary {
  service: "workers" | "d1" | "r2" | "durable-objects" | "workflows" | "analytics-engine";
  meteredBy: string[];
  availability: "free-and-paid" | "subscription-required" | "plan-dependent";
  pricingUrl: string;
  verifyBeforeApply: true;
}

export interface SetupCleanupStep {
  targetOperationId: string;
  action: "delete";
  onlyIfCreatedBySetup: true;
}

export interface SetupWarning {
  code:
    | "setup_pricing_must_be_reverified"
    | "setup_tier2_validation_required"
    | "setup_runtime_decision_is_operator_owned"
    | "setup_workflow_requires_separate_worker";
  message: string;
}

export interface ProductionSetupPlanV1 {
  version: 1;
  dryRun: true;
  profile: "production";
  runtime: SetupRuntimePrimitive;
  operations: SetupOperation[];
  permissions: SetupPermission[];
  costs: SetupCostBoundary[];
  cleanup: SetupCleanupStep[];
  warnings: SetupWarning[];
  liveValidationRequired: true;
}

const runtimePrimitives: readonly SetupRuntimePrimitive[] = [
  "cloudflare-workers",
  "dynamic-workers",
  "workers-for-platforms"
];

export function createProductionSetupPlan(runtime: SetupRuntimePrimitive): ProductionSetupPlanV1 {
  const operations: SetupOperation[] = [
    operation("create:control-plane-d1", "d1", "create", "DB", "implemented"),
    operation("declare:app-database-boundary", "d1", "declare", "APP_<APP_ID>_DB", "implemented", [
      "create:control-plane-d1"
    ]),
    operation("create:artifact-r2", "r2", "create", "ARTIFACTS", "implemented"),
    operation("create:execution-archive-r2", "r2", "create", "EXECUTION_ARCHIVE", "implemented"),
    operation(
      "create:admin-rate-limiter-do",
      "durable-object",
      "create",
      "ADMIN_MUTATION_RATE_LIMITER_DO",
      "implemented"
    ),
    operation(
      "create:secret-store-do",
      "durable-object",
      "create",
      "PROVIDER_SECRET_STORE_DO",
      "integration-required"
    ),
    operation(
      "create:approval-workflow",
      "workflow",
      "create",
      "APPROVAL_WORKFLOW",
      "integration-required"
    ),
    operation(
      "create:usage-analytics-engine",
      "analytics-engine",
      "create",
      "USAGE_ANALYTICS",
      "integration-required"
    ),
    operation(
      "create:runtime-worker",
      "worker",
      "create",
      `TENANT_RUNTIME:${runtime}`,
      "integration-required"
    ),
    operation(
      "apply:control-plane-migrations",
      "migration",
      "apply",
      "packages/control-plane/migrations",
      "implemented",
      ["create:control-plane-d1"]
    ),
    operation(
      "bind:control-plane-worker",
      "worker",
      "bind",
      "TENANTSCRIPT_CONTROL_PLANE",
      "integration-required",
      [
        "create:control-plane-d1",
        "create:artifact-r2",
        "create:execution-archive-r2",
        "create:admin-rate-limiter-do",
        "create:secret-store-do",
        "create:approval-workflow",
        "create:usage-analytics-engine",
        "create:runtime-worker",
        "apply:control-plane-migrations"
      ]
    )
  ];
  const created = operations.filter((item) => item.action === "create");
  // Cleanup is derived only from resources this setup run would create. Reversing that fixed list
  // preserves dependency safety and never implies deletion of adopted or declarative resources.
  const cleanup = [...created].reverse().map(
    (item): SetupCleanupStep => ({
      targetOperationId: item.id,
      action: "delete",
      onlyIfCreatedBySetup: true
    })
  );
  const warnings: SetupWarning[] = [
    {
      code: "setup_pricing_must_be_reverified",
      message: "Cloudflare pricing and plan availability must be reverified before live apply."
    },
    {
      code: "setup_tier2_validation_required",
      message: "This accountless plan is not live Cloudflare or clean-account evidence."
    },
    {
      code: "setup_runtime_decision_is_operator_owned",
      message: "The selected runtime is explicit because ADR-001 remains externally blocked."
    },
    ...(runtime === "workers-for-platforms"
      ? [
          {
            code: "setup_workflow_requires_separate_worker" as const,
            message:
              "Cloudflare Workflows must be deployed on a separate Worker, not inside a Workers for Platforms namespace."
          }
        ]
      : [])
  ];
  return {
    version: 1,
    dryRun: true,
    profile: "production",
    runtime,
    operations,
    permissions: permissions(),
    costs: costs(runtime),
    cleanup,
    warnings,
    liveValidationRequired: true
  };
}

export function isSetupRuntimePrimitive(value: unknown): value is SetupRuntimePrimitive {
  return runtimePrimitives.some((runtime) => runtime === value);
}

function operation(
  id: string,
  kind: SetupResourceKind,
  action: SetupOperation["action"],
  logicalName: string,
  implementationStatus: SetupOperation["implementationStatus"],
  dependsOn: string[] = []
): SetupOperation {
  return { id, kind, action, logicalName, implementationStatus, dependsOn };
}

function permissions(): SetupPermission[] {
  return [
    { id: "workers:write", reason: "Deploy and bind the Control Plane and selected runtime." },
    { id: "d1:write", reason: "Create databases and apply versioned migrations." },
    { id: "r2:write", reason: "Create artifact and execution archive buckets." },
    { id: "durable-objects:write", reason: "Declare rate-limit and secret-store namespaces." },
    { id: "workflows:write", reason: "Deploy the approval lifecycle Workflow." },
    { id: "analytics-engine:write", reason: "Declare the usage-meter dataset binding." }
  ];
}

function costs(runtime: SetupRuntimePrimitive): SetupCostBoundary[] {
  return [
    {
      service: "workers",
      meteredBy: ["requests", "cpu-time"],
      availability: runtime === "cloudflare-workers" ? "free-and-paid" : "plan-dependent",
      pricingUrl:
        runtime === "dynamic-workers"
          ? "https://developers.cloudflare.com/dynamic-workers/pricing/"
          : runtime === "workers-for-platforms"
            ? "https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/"
            : "https://developers.cloudflare.com/workers/platform/pricing/",
      verifyBeforeApply: true
    },
    {
      service: "d1",
      meteredBy: ["rows-read", "rows-written", "storage"],
      availability: "free-and-paid",
      pricingUrl: "https://developers.cloudflare.com/d1/platform/pricing/",
      verifyBeforeApply: true
    },
    {
      service: "r2",
      meteredBy: ["storage", "class-a-operations", "class-b-operations", "retrieval"],
      availability: "subscription-required",
      pricingUrl: "https://developers.cloudflare.com/r2/pricing/",
      verifyBeforeApply: true
    },
    {
      service: "durable-objects",
      meteredBy: ["requests", "duration", "storage"],
      availability: "free-and-paid",
      pricingUrl: "https://developers.cloudflare.com/durable-objects/platform/pricing/",
      verifyBeforeApply: true
    },
    {
      service: "workflows",
      meteredBy: ["requests", "cpu-time", "storage", "steps"],
      availability: "free-and-paid",
      pricingUrl: "https://developers.cloudflare.com/workflows/reference/pricing/",
      verifyBeforeApply: true
    },
    {
      service: "analytics-engine",
      meteredBy: ["data-points-written", "queries"],
      availability: "free-and-paid",
      pricingUrl: "https://developers.cloudflare.com/analytics/analytics-engine/pricing/",
      verifyBeforeApply: true
    }
  ];
}
