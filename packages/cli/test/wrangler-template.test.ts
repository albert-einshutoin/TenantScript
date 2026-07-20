import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseProductionWranglerInput,
  renderProductionWranglerConfig,
  runExtCli,
  type CliIo,
  type ProductionWranglerInputV1,
  type RollbackClient
} from "../src/index.js";

const validInput: ProductionWranglerInputV1 = {
  version: 1,
  workerName: "tenantscript-control-plane",
  compatibilityDate: "2026-07-20",
  database: {
    name: "tenantscript-control-plane",
    id: "0123456789abcdef0123456789abcdef"
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
  it("renders only Worker bindings that production composition currently consumes", () => {
    const first = renderProductionWranglerConfig(validInput);
    const second = renderProductionWranglerConfig(validInput);

    expect(first).toBe(second);
    expect(JSON.parse(first)).toMatchObject({
      name: "tenantscript-control-plane",
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
      durable_objects: {
        bindings: [
          {
            name: "ADMIN_MUTATION_RATE_LIMITER_DO",
            class_name: "AdminMutationRateLimitDurableObject"
          }
        ]
      },
      migrations: [
        {
          tag: "v1",
          new_sqlite_classes: ["AdminMutationRateLimitDurableObject"]
        }
      ]
    });
    expect(first).not.toMatch(
      /ARTIFACTS|EXECUTION_ARCHIVE|PROVIDER_SECRET_STORE_DO|APPROVAL_WORKFLOW|USAGE_ANALYTICS/u
    );
    expect(first).not.toMatch(/token|secret|account_id/iu);
  });

  it.each([
    ["unknown field", { ...validInput, apiToken: "secret-sentinel" }],
    ["missing database", { ...validInput, database: undefined }],
    ["invalid worker name", { ...validInput, workerName: "Tenant Script" }],
    [
      "unresolved database id",
      { ...validInput, database: { ...validInput.database, id: "${CONTROL_PLANE_D1_ID}" } }
    ],
    ["invalid date", { ...validInput, compatibilityDate: "2026-02-30" }]
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
      name: "tenantscript-control-plane",
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
    expect(JSON.parse(generated)).toMatchObject({ name: "tenantscript-control-plane" });

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
