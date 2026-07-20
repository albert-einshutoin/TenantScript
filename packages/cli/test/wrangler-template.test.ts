import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveCloudflareR2BucketName,
  deriveControlPlaneWorkerName,
  parseProductionWranglerInput,
  renderProductionWranglerConfig,
  runExtCli,
  type CliIo,
  type ProductionWranglerInputV2,
  type RollbackClient
} from "../src/index.js";

const validInput: ProductionWranglerInputV2 = {
  version: 2,
  baseWorkerName: "tenantscript-control-plane",
  setupRunId: "run-owned-worker",
  compatibilityDate: "2026-07-20",
  database: {
    name: "tenantscript-control-plane",
    id: "0123456789abcdef0123456789abcdef"
  },
  executionArchive: {
    baseBucketName: "tenantscript-execution-archive",
    hotRetentionDays: 30
  }
};

const temporaryDirectories: string[] = [];
const temporaryFiles: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
  await Promise.all(temporaryFiles.splice(0).map((path) => rm(path, { force: true })));
});

describe("production Wrangler template", () => {
  it("keeps version 1 inputs compatible without enabling retention implicitly", () => {
    const legacy = renderProductionWranglerConfig({
      version: 1,
      baseWorkerName: validInput.baseWorkerName,
      setupRunId: validInput.setupRunId,
      compatibilityDate: validInput.compatibilityDate,
      database: validInput.database
    });

    expect(JSON.parse(legacy)).not.toHaveProperty("r2_buckets");
    expect(JSON.parse(legacy)).not.toHaveProperty("triggers");
    expect(legacy).not.toContain("EXECUTION_ARCHIVE_HOT_RETENTION_DAYS");
  });

  it("derives one stable non-reflective Worker target from the reconcile key", () => {
    const first = deriveControlPlaneWorkerName(validInput.baseWorkerName, validInput.setupRunId);
    const second = deriveControlPlaneWorkerName(validInput.baseWorkerName, validInput.setupRunId);
    const differentRun = deriveControlPlaneWorkerName(validInput.baseWorkerName, "another-run");

    expect(first).toBe(second);
    expect(first).toBe("tenantscript-control-plane-3e4cec91c270a29d79d819be");
    expect(first).not.toContain(validInput.setupRunId);
    expect(differentRun).not.toBe(first);
  });

  it("keeps the derived Worker target within Cloudflare's 63 character limit", () => {
    const target = deriveControlPlaneWorkerName("a".repeat(38), validInput.setupRunId);

    expect(target).toHaveLength(63);
  });

  it.each([
    ["uppercase base", "TenantScript", validInput.setupRunId],
    ["oversized base", "a".repeat(39), validInput.setupRunId],
    ["unsafe run id", "tenantscript", "run id"],
    ["credential-shaped run id", "tenantscript", "secret-sentinel"]
  ])("rejects %s without reflecting target input", (_name, baseName, runId) => {
    expect(() => deriveControlPlaneWorkerName(baseName, runId)).toThrow(
      "Control Plane Worker target is invalid"
    );
  });

  it("renders only Worker bindings that production composition currently consumes", () => {
    const first = renderProductionWranglerConfig(validInput);
    const second = renderProductionWranglerConfig(validInput);

    expect(first).toBe(second);
    expect(JSON.parse(first)).toMatchObject({
      name: deriveControlPlaneWorkerName(validInput.baseWorkerName, validInput.setupRunId),
      main: "packages/control-plane/src/worker-entry.ts",
      compatibility_date: "2026-07-20",
      d1_databases: [
        {
          binding: "DB",
          database_name: "tenantscript-control-plane",
          database_id: "0123456789abcdef0123456789abcdef",
          migrations_dir: "packages/control-plane/migrations"
        }
      ],
      r2_buckets: [
        {
          binding: "EXECUTION_ARCHIVE",
          bucket_name: deriveCloudflareR2BucketName(
            validInput.executionArchive.baseBucketName,
            validInput.setupRunId,
            "create:execution-archive-r2"
          )
        }
      ],
      vars: {
        EXECUTION_ARCHIVE_HOT_RETENTION_DAYS: "30"
      },
      triggers: { crons: ["0 2 * * *"] },
      durable_objects: {
        bindings: [
          {
            name: "ADMIN_MUTATION_RATE_LIMITER_DO",
            class_name: "AdminMutationRateLimitDurableObject"
          }
        ]
      },
      exports: {
        AdminMutationRateLimitDurableObject: {
          type: "durable-object",
          storage: "sqlite"
        }
      }
    });
    expect(JSON.parse(first)).not.toHaveProperty("migrations");
    expect(first).not.toMatch(
      /ARTIFACTS|PROVIDER_SECRET_STORE_DO|APPROVAL_WORKFLOW|USAGE_ANALYTICS/u
    );
    expect(first).not.toMatch(/token|secret|account_id/iu);
  });

  it.each([
    ["unknown field", { ...validInput, apiToken: "secret-sentinel" }],
    ["missing database", { ...validInput, database: undefined }],
    ["invalid worker base name", { ...validInput, baseWorkerName: "Tenant Script" }],
    ["invalid setup run id", { ...validInput, setupRunId: "secret-sentinel" }],
    [
      "operator-selected reconcile key",
      { ...validInput, setupRunId: undefined, reconcileIdempotencyKey: `tssetup-${"a".repeat(64)}` }
    ],
    [
      "operator-selected final worker name",
      {
        version: validInput.version,
        workerName: "tenantscript-control-plane",
        compatibilityDate: validInput.compatibilityDate,
        database: validInput.database
      }
    ],
    [
      "unresolved database id",
      { ...validInput, database: { ...validInput.database, id: "${CONTROL_PLANE_D1_ID}" } }
    ],
    ["invalid date", { ...validInput, compatibilityDate: "2026-02-30" }],
    [
      "operator-selected archive target",
      {
        ...validInput,
        executionArchive: {
          bucketName: "operator-selected-target",
          hotRetentionDays: 30
        }
      }
    ],
    [
      "invalid hot retention",
      {
        ...validInput,
        executionArchive: {
          ...validInput.executionArchive,
          hotRetentionDays: 0
        }
      }
    ]
  ])("rejects %s without reflecting input", (_name, input) => {
    expect(() => parseProductionWranglerInput(input)).toThrow("wrangler input is invalid");
  });

  it("prints generated config from an exact accountless input file", async () => {
    const inputPath = await writeInput(validInput);
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
          "true",
          "--wrangler-input",
          inputPath
        ],
        rollbackOnlyClient,
        captureIo(stdout, stderr)
      )
    ).resolves.toBe(0);

    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout[0] ?? "null")).toMatchObject({
      name: deriveControlPlaneWorkerName(validInput.baseWorkerName, validInput.setupRunId),
      d1_databases: [{ binding: "DB" }]
    });
  });

  it("writes atomically only when the explicit output path does not exist", async () => {
    const inputPath = await writeInput(validInput);
    const outputPath = join(process.cwd(), `wrangler-${crypto.randomUUID()}.jsonc`);
    temporaryFiles.push(outputPath);
    const firstIo = captureIo([], []);

    await expect(
      runExtCli(
        [
          "setup",
          "--profile",
          "production",
          "--runtime",
          "cloudflare-workers",
          "--dry-run",
          "true",
          "--wrangler-input",
          inputPath,
          "--output",
          outputPath
        ],
        rollbackOnlyClient,
        firstIo
      )
    ).resolves.toBe(0);
    const generated = await readFile(outputPath, "utf8");
    expect(JSON.parse(generated)).toMatchObject({
      name: deriveControlPlaneWorkerName(validInput.baseWorkerName, validInput.setupRunId)
    });

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
          "true",
          "--wrangler-input",
          inputPath,
          "--output",
          outputPath
        ],
        rollbackOnlyClient,
        captureIo(stdout, stderr)
      )
    ).resolves.toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["wrangler config could not be written"]);
    expect(await readFile(outputPath, "utf8")).toBe(generated);
  });

  it("rejects output outside the repository root because relative config paths would be invalid", async () => {
    const inputPath = await writeInput(validInput);
    const directory = await temporaryDirectory();
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
          "true",
          "--wrangler-input",
          inputPath,
          "--output",
          join(directory, "wrangler.jsonc")
        ],
        rollbackOnlyClient,
        captureIo(stdout, stderr)
      )
    ).resolves.toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["invalid setup options"]);
  });

  it("rejects secret-shaped unknown input with a stable CLI diagnostic", async () => {
    const inputPath = await writeInput({ ...validInput, apiToken: "secret-sentinel" });
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
          "true",
          "--wrangler-input",
          inputPath
        ],
        rollbackOnlyClient,
        captureIo(stdout, stderr)
      )
    ).resolves.toBe(2);

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["wrangler input is invalid"]);
    expect(JSON.stringify(stderr)).not.toContain("secret-sentinel");
  });

  it("classifies malformed JSON as invalid without reflecting parser input", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "wrangler-input.json");
    await writeFile(inputPath, '{"apiToken":"secret-sentinel"');
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
          "true",
          "--wrangler-input",
          inputPath
        ],
        rollbackOnlyClient,
        captureIo(stdout, stderr)
      )
    ).resolves.toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["wrangler input is invalid"]);
    expect(JSON.stringify(stderr)).not.toContain("secret-sentinel");
  });
});

async function writeInput(value: unknown): Promise<string> {
  const directory = await temporaryDirectory();
  const path = join(directory, "wrangler-input.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tenantscript-wrangler-template-"));
  temporaryDirectories.push(directory);
  return directory;
}

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
