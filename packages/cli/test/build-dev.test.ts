import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runExtCli, type CliIo, type RollbackClient } from "../src/index.js";

const tempDirs: string[] = [];

describe("ext build and ext dev", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("builds deterministic plugin bundles and prints their content hash", async () => {
    const root = await createTempDir();
    const entry = join(root, "plugin.ts");
    const out = join(root, "dist", "plugin.cjs");
    await writeFile(
      entry,
      [
        "export const handlers = {",
        "  'invoice.created': () => ({ ok: true, source: 'build-test' })",
        "};"
      ].join("\n")
    );

    const firstStdout: string[] = [];
    await expect(
      runExtCli(
        ["build", "--entry", entry, "--out", out],
        rollbackOnlyClient,
        captureIo(firstStdout, [])
      )
    ).resolves.toBe(0);
    const first = parseJson(firstStdout[0]);
    const firstBundle = await readFile(out, "utf8");

    const secondStdout: string[] = [];
    await expect(
      runExtCli(
        ["build", "--entry", entry, "--out", out],
        rollbackOnlyClient,
        captureIo(secondStdout, [])
      )
    ).resolves.toBe(0);

    expect(parseJson(secondStdout[0])).toEqual(first);
    await expect(readFile(out, "utf8")).resolves.toBe(firstBundle);
    expect(first).toMatchObject({
      entry,
      out,
      bytes: firstBundle.length
    });
    expect((first as { sha256: string }).sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("runs a local dev invocation with a mock capability broker", async () => {
    const root = await createTempDir();
    const entry = join(root, "plugin.ts");
    const stdout: string[] = [];
    await writeFile(
      entry,
      [
        "export const handlers = {",
        "  'invoice.created': async (payload, context) => ({",
        "    payload,",
        "    delivered: await context.capability('slack.send', { text: payload.text })",
        "  })",
        "};"
      ].join("\n")
    );

    await expect(
      runExtCli(
        ["dev", "--entry", entry, "--hook", "invoice.created", "--payload", '{"text":"hello"}'],
        rollbackOnlyClient,
        captureIo(stdout, [])
      )
    ).resolves.toBe(0);

    expect(parseJson(stdout[0])).toEqual({
      hookName: "invoice.created",
      value: {
        payload: { text: "hello" },
        delivered: {
          ok: true,
          name: "slack.send",
          input: { text: "hello" }
        }
      },
      logs: []
    });
  });

  it("rejects missing build entrypoints", async () => {
    const stderr: string[] = [];

    await expect(
      runExtCli(["build", "--out", "dist/plugin.cjs"], rollbackOnlyClient, captureIo([], stderr))
    ).resolves.toBe(2);

    expect(stderr).toEqual(["missing required build option: --entry"]);
  });

  it("rejects invalid dev payload JSON before running the bundle", async () => {
    const root = await createTempDir();
    const entry = join(root, "plugin.ts");
    const stderr: string[] = [];
    await writeFile(entry, "export const handlers = { 'invoice.created': () => undefined };");

    await expect(
      runExtCli(
        ["dev", "--entry", entry, "--hook", "invoice.created", "--payload", "not-json"],
        rollbackOnlyClient,
        captureIo([], stderr)
      )
    ).resolves.toBe(2);

    expect(stderr).toEqual(["invalid dev option: --payload must be JSON"]);
  });

  it("rejects unsafe dev hook names before running the bundle", async () => {
    const root = await createTempDir();
    const entry = join(root, "plugin.ts");
    const stderr: string[] = [];
    await writeFile(entry, "export const handlers = { 'invoice.created': () => undefined };");

    await expect(
      runExtCli(
        ["dev", "--entry", entry, "--hook", 'invoice.created";bad()'],
        rollbackOnlyClient,
        captureIo([], stderr)
      )
    ).resolves.toBe(2);

    expect(stderr).toEqual(["invalid dev option: --hook must be dot-separated lowercase segments"]);
  });
});

const rollbackOnlyClient: RollbackClient = {
  rollbackInstallation: () => {
    throw new Error("rollback should not be called");
  }
};

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tenantscript-ext-build-dev-"));
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
