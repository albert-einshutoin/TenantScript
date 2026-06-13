import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runExtCli, type CliIo, type RollbackClient } from "../src/index.js";

const tempDirs: string[] = [];

describe("ext schema diff", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("fails when fields are removed or their types change", async () => {
    const root = await createTempDir();
    const from = join(root, "from.json");
    const to = join(root, "to.json");
    const stdout: string[] = [];
    await writeFile(
      from,
      JSON.stringify({
        properties: {
          invoiceId: { type: "string" },
          amountCents: { type: "number" }
        },
        required: ["invoiceId"]
      })
    );
    await writeFile(
      to,
      JSON.stringify({
        properties: {
          invoiceId: { type: "number" }
        },
        required: ["invoiceId"]
      })
    );

    await expect(
      runExtCli(
        ["schema", "diff", "--from", from, "--to", to],
        rollbackOnlyClient,
        captureIo(stdout, [])
      )
    ).resolves.toBe(1);

    expect(parseJson(stdout[0])).toEqual({
      compatible: false,
      breaking: [
        "field invoiceId changed type from string to number",
        "field amountCents was removed"
      ],
      warnings: []
    });
  });

  it("allows optional additions while warning about the new field", async () => {
    const root = await createTempDir();
    const from = join(root, "from.json");
    const to = join(root, "to.json");
    const stdout: string[] = [];
    await writeFile(
      from,
      JSON.stringify({
        properties: { invoiceId: { type: "string" } },
        required: ["invoiceId"]
      })
    );
    await writeFile(
      to,
      JSON.stringify({
        properties: {
          invoiceId: { type: "string" },
          memo: { type: "string" }
        },
        required: ["invoiceId"]
      })
    );

    await expect(
      runExtCli(
        ["schema", "diff", "--from", from, "--to", to],
        rollbackOnlyClient,
        captureIo(stdout, [])
      )
    ).resolves.toBe(0);

    expect(parseJson(stdout[0])).toEqual({
      compatible: true,
      breaking: [],
      warnings: ["optional field memo was added"]
    });
  });

  it("fails when new fields are required or existing optional fields become required", async () => {
    const root = await createTempDir();
    const from = join(root, "from.json");
    const to = join(root, "to.json");
    const stdout: string[] = [];
    await writeFile(
      from,
      JSON.stringify({
        properties: {
          invoiceId: { type: "string" },
          memo: { type: "string" }
        },
        required: ["invoiceId"]
      })
    );
    await writeFile(
      to,
      JSON.stringify({
        properties: {
          invoiceId: { type: "string" },
          memo: { type: "string" },
          currency: { type: "string" }
        },
        required: ["invoiceId", "memo", "currency"]
      })
    );

    await expect(
      runExtCli(
        ["schema", "diff", "--from", from, "--to", to],
        rollbackOnlyClient,
        captureIo(stdout, [])
      )
    ).resolves.toBe(1);

    expect(parseJson(stdout[0])).toEqual({
      compatible: false,
      breaking: ["field memo became required", "required field currency was added"],
      warnings: []
    });
  });

  it("rejects missing schema diff paths", async () => {
    const stderr: string[] = [];

    await expect(
      runExtCli(["schema", "diff", "--from", "old.json"], rollbackOnlyClient, captureIo([], stderr))
    ).resolves.toBe(2);

    expect(stderr).toEqual(["missing required schema diff option: --to"]);
  });
});

describe("ext manifest lint", () => {
  it("accepts valid manifests", async () => {
    const root = await createTempDir();
    const manifest = join(root, "manifest.json");
    const stdout: string[] = [];
    await writeFile(
      manifest,
      JSON.stringify({
        name: "large-invoice-notify",
        version: "1.0.0",
        hooks: [{ name: "invoice.created", type: "event", timeoutMs: 250 }],
        capabilities: {},
        configSchema: { properties: {}, required: [] },
        egress: { mode: "deny" },
        limits: { cpuMs: 50, timeoutMs: 500 }
      })
    );

    await expect(
      runExtCli(
        ["manifest", "lint", "--manifest", manifest],
        rollbackOnlyClient,
        captureIo(stdout, [])
      )
    ).resolves.toBe(0);

    expect(parseJson(stdout[0])).toEqual({
      ok: true,
      name: "large-invoice-notify",
      version: "1.0.0",
      hooks: ["invoice.created"]
    });
  });

  it("returns structured manifest validation errors", async () => {
    const root = await createTempDir();
    const manifest = join(root, "manifest.json");
    const stdout: string[] = [];
    await writeFile(
      manifest,
      JSON.stringify({
        name: "bad-manifest",
        version: "v1",
        hooks: [],
        capabilities: {},
        configSchema: { properties: {}, required: [] },
        egress: { mode: "deny" },
        limits: { cpuMs: 50, timeoutMs: 500 }
      })
    );

    await expect(
      runExtCli(
        ["manifest", "lint", "--manifest", manifest],
        rollbackOnlyClient,
        captureIo(stdout, [])
      )
    ).resolves.toBe(1);

    const result = parseJson(stdout[0]) as {
      ok: false;
      errors: readonly { path: string }[];
    };
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.path)).toEqual(
      expect.arrayContaining(["version", "hooks"])
    );
  });

  it("rejects missing manifest lint paths", async () => {
    const stderr: string[] = [];

    await expect(
      runExtCli(["manifest", "lint"], rollbackOnlyClient, captureIo([], stderr))
    ).resolves.toBe(2);

    expect(stderr).toEqual(["missing required manifest lint option: --manifest"]);
  });
});

const rollbackOnlyClient: RollbackClient = {
  rollbackInstallation: () => {
    throw new Error("rollback should not be called");
  }
};

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tenantscript-ext-schema-"));
  tempDirs.push(dir);
  return dir;
}

function parseJson(line: string | undefined): unknown {
  if (line === undefined) {
    throw new Error("missing JSON output");
  }
  return JSON.parse(line) as unknown;
}

function captureIo(stdout: string[], stderr: string[]): CliIo {
  return {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  };
}
