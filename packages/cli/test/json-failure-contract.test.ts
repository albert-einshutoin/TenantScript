import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runExtCli, type CliIo, type RollbackClient } from "../src/index.js";

const sentinelSecret = "ts_sentinel_secret_must_not_leak";
const tempDirs: string[] = [];

interface JsonFailureCase {
  name: string;
  createArgs: () => Promise<string[]>;
  assertStableFields: (payload: unknown) => void;
}

describe("CLI JSON failure contract", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it.each<JsonFailureCase>([
    {
      name: "manifest lint validation",
      createArgs: async () => {
        const manifest = await writeInvalidManifest();
        return ["manifest", "lint", "--manifest", manifest];
      },
      assertStableFields: assertManifestFailure
    },
    {
      name: "deploy manifest validation",
      createArgs: async () => {
        const root = await createTempDir();
        const entry = join(root, "plugin.ts");
        const manifest = await writeInvalidManifest();
        await writeFile(entry, "export const handlers = { 'invoice.created': () => undefined };");
        return [
          "deploy",
          "--app",
          "app_1",
          "--plugin",
          "large-invoice-notify",
          "--version",
          "v1",
          "--entry",
          entry,
          "--manifest",
          manifest,
          "--dry-run",
          "true"
        ];
      },
      assertStableFields: assertManifestFailure
    },
    {
      name: "schema compatibility failure",
      createArgs: async () => {
        const root = await createTempDir();
        const from = join(root, "from.json");
        const to = join(root, "to.json");
        await writeFile(
          from,
          JSON.stringify({
            properties: { invoiceId: { type: "string" }, amountCents: { type: "number" } },
            required: ["invoiceId"]
          })
        );
        await writeFile(
          to,
          JSON.stringify({
            properties: { invoiceId: { type: "number" } },
            required: ["invoiceId"]
          })
        );
        return ["schema", "diff", "--from", from, "--to", to];
      },
      assertStableFields: (payload) => {
        expect(payload).toEqual({
          compatible: false,
          breaking: [
            "field invoiceId changed type from string to number",
            "field amountCents was removed"
          ],
          warnings: []
        });
      }
    }
  ])("keeps $name parseable, stable, and redacted", async ({ createArgs, assertStableFields }) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const args = await createArgs();

    await expect(
      runExtCli(
        [...args, "--sentinel-secret", sentinelSecret],
        unusedRollbackClient,
        captureIo(stdout, stderr)
      )
    ).resolves.toBe(1);

    expect(stdout).toHaveLength(1);
    expect(stderr).toEqual([]);
    assertStableFields(JSON.parse(stdout[0] ?? ""));
    expect(JSON.stringify({ stdout, stderr })).not.toContain(sentinelSecret);
  });
});

const unusedRollbackClient: RollbackClient = {
  rollbackInstallation: () => {
    throw new Error("rollback client should not be called");
  }
};

async function writeInvalidManifest(): Promise<string> {
  const root = await createTempDir();
  const manifest = join(root, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      name: "large-invoice-notify",
      version: "v1",
      hooks: [],
      capabilities: {},
      configSchema: { properties: {}, required: [] },
      egress: { mode: "deny" },
      limits: { cpuMs: 50, timeoutMs: 500 },
      sentinelSecret
    })
  );
  return manifest;
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tenantscript-cli-json-failure-"));
  tempDirs.push(dir);
  return dir;
}

function captureIo(stdout: string[], stderr: string[]): CliIo {
  return {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  };
}

function assertManifestFailure(payload: unknown): void {
  expect(isRecord(payload)).toBe(true);
  if (!isRecord(payload)) throw new Error("manifest failure must be an object");
  expect(payload.ok).toBe(false);
  expect(Array.isArray(payload.errors)).toBe(true);
  if (!Array.isArray(payload.errors)) throw new Error("manifest failure must contain errors");

  const paths = payload.errors.map((error) =>
    isRecord(error) && typeof error.path === "string" ? error.path : ""
  );
  expect(paths).toEqual(expect.arrayContaining(["version", "hooks"]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
