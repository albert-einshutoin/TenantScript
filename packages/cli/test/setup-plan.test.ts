import { describe, expect, it } from "vitest";
import {
  createProductionSetupPlan,
  runExtCli,
  type CliIo,
  type RollbackClient
} from "../src/index.js";

describe("ext setup production dry-run", () => {
  it("plans every production resource and migration in dependency order", () => {
    const plan = createProductionSetupPlan("cloudflare-workers");

    expect(plan).toMatchObject({
      version: 1,
      dryRun: true,
      profile: "production",
      runtime: "cloudflare-workers",
      liveValidationRequired: true
    });
    expect(plan.operations.map((operation) => operation.id)).toEqual([
      "create:control-plane-d1",
      "declare:app-database-boundary",
      "create:artifact-r2",
      "create:execution-archive-r2",
      "create:admin-rate-limiter-do",
      "create:secret-store-do",
      "create:approval-workflow",
      "create:usage-analytics-engine",
      "create:runtime-worker",
      "apply:control-plane-migrations",
      "bind:control-plane-worker"
    ]);
    expect(plan.operations.at(-2)?.dependsOn).toEqual(["create:control-plane-d1"]);
    expect(
      plan.operations
        .filter((operation) =>
          ["create:artifact-r2", "create:execution-archive-r2"].includes(operation.id)
        )
        .map((operation) => operation.implementationStatus)
    ).toEqual(["implemented", "implemented"]);
    expect(plan.operations.at(-1)?.dependsOn).toEqual([
      "create:control-plane-d1",
      "create:artifact-r2",
      "create:execution-archive-r2",
      "create:admin-rate-limiter-do",
      "create:secret-store-do",
      "create:approval-workflow",
      "create:usage-analytics-engine",
      "create:runtime-worker",
      "apply:control-plane-migrations"
    ]);
  });

  it("limits cleanup to created resources in exact reverse order", () => {
    const plan = createProductionSetupPlan("cloudflare-workers");
    const created = plan.operations
      .filter((operation) => operation.action === "create")
      .map((operation) => operation.id);

    expect(plan.cleanup.map((step) => step.targetOperationId)).toEqual([...created].reverse());
    for (const step of plan.cleanup) {
      expect(step).toMatchObject({ action: "delete", onlyIfCreatedBySetup: true });
    }
    expect(JSON.stringify(plan.cleanup)).not.toContain("declare:app-database-boundary");
    expect(JSON.stringify(plan.cleanup)).not.toContain("apply:control-plane-migrations");
  });

  it("publishes logical permissions and current-pricing verification for every service", () => {
    const plan = createProductionSetupPlan("cloudflare-workers");

    expect(plan.permissions.map((permission) => permission.id)).toEqual([
      "workers:write",
      "d1:write",
      "r2:write",
      "durable-objects:write",
      "workflows:write",
      "analytics-engine:write"
    ]);
    expect(plan.costs.map((cost) => cost.service)).toEqual([
      "workers",
      "d1",
      "r2",
      "durable-objects",
      "workflows",
      "analytics-engine"
    ]);
    for (const cost of plan.costs) {
      expect(cost.meteredBy.length).toBeGreaterThan(0);
      expect(cost.pricingUrl).toMatch(/^https:\/\/developers\.cloudflare\.com\//u);
      expect(cost.verifyBeforeApply).toBe(true);
      expect(cost).not.toHaveProperty("amount");
    }
  });

  it("is byte deterministic and warns about the Workers for Platforms workflow boundary", () => {
    const first = createProductionSetupPlan("workers-for-platforms");
    const second = createProductionSetupPlan("workers-for-platforms");

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.warnings.map((warning) => warning.code)).toContain(
      "setup_workflow_requires_separate_worker"
    );
  });

  it("routes each runtime to an official current-pricing reference", () => {
    const dynamicWorkers = createProductionSetupPlan("dynamic-workers");
    const workersForPlatforms = createProductionSetupPlan("workers-for-platforms");
    const dynamicCost = dynamicWorkers.costs.find((cost) => cost.service === "workers");
    const platformCost = workersForPlatforms.costs.find((cost) => cost.service === "workers");

    expect(dynamicCost?.pricingUrl).toBe(
      "https://developers.cloudflare.com/dynamic-workers/pricing/"
    );
    expect(platformCost?.pricingUrl).toBe(
      "https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/"
    );
    for (const service of ["durable-objects", "analytics-engine"] as const) {
      expect(dynamicWorkers.costs.find((cost) => cost.service === service)?.availability).toBe(
        "free-and-paid"
      );
    }
  });

  it("prints a plan without invoking the Control Plane client", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(
      runExtCli(
        [
          "setup",
          "--profile",
          "production",
          "--runtime",
          "cloudflare-workers",
          "--dry-run",
          "true"
        ],
        rollbackOnlyClient,
        captureIo(stdout, stderr)
      )
    ).resolves.toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout[0] ?? "null")).toMatchObject({ dryRun: true, profile: "production" });
  });

  it.each([
    ["missing options", ["setup"]],
    [
      "unsupported profile",
      ["setup", "--profile", "preview", "--runtime", "cloudflare-workers", "--dry-run", "true"]
    ],
    [
      "unsupported runtime",
      ["setup", "--profile", "production", "--runtime", "unknown", "--dry-run", "true"]
    ],
    [
      "live apply",
      ["setup", "--profile", "production", "--runtime", "cloudflare-workers", "--dry-run", "false"]
    ],
    [
      "secret-shaped unknown option",
      [
        "setup",
        "--profile",
        "production",
        "--runtime",
        "cloudflare-workers",
        "--dry-run",
        "true",
        "--token",
        "secret-sentinel"
      ]
    ]
  ])("rejects invalid setup input without reflection: %s", async (_name, argv) => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(runExtCli(argv, rollbackOnlyClient, captureIo(stdout, stderr))).resolves.toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["invalid setup options"]);
    expect(JSON.stringify(stderr)).not.toContain("secret-sentinel");
  });
});

const rollbackOnlyClient: RollbackClient = {
  rollbackInstallation: () => {
    throw new Error("rollback client must not be called");
  }
};

function captureIo(stdout: string[], stderr: string[]): CliIo {
  return {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  };
}
