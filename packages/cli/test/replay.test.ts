import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runExtCli, type CliIo, type RollbackClient } from "../src/index.js";

const tempDirs: string[] = [];

describe("ext replay", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("replays an execution sample with a new bundle and reports result diffs", async () => {
    const root = await createTempDir();
    const entry = join(root, "plugin.ts");
    const sample = join(root, "sample.json");
    const stdout: string[] = [];
    await writeFile(
      entry,
      [
        "export const handlers = {",
        "  'invoice.created': async (payload, context) => {",
        "    await context.capability('slack.send', { text: payload.text });",
        "    return { text: payload.text, version: 'new' };",
        "  }",
        "};"
      ].join("\n")
    );
    await writeFile(
      sample,
      JSON.stringify({
        execution: {
          id: "exec_1",
          tenantId: "tenant_1",
          pluginId: "large-invoice-notify",
          hookName: "invoice.created",
          version: "1.0.0",
          status: "success",
          capabilityCalls: [{ name: "slack.send", status: "success" }]
        },
        payload: { text: "hello" },
        value: { text: "hello", version: "old" },
        capabilityResponses: {
          "slack.send": { ok: true }
        }
      })
    );

    await expect(
      runExtCli(
        ["replay", "--entry", entry, "--sample", sample],
        rollbackOnlyClient,
        captureIo(stdout, [])
      )
    ).resolves.toBe(0);

    expect(parseJson(stdout[0])).toEqual({
      executionId: "exec_1",
      hookName: "invoice.created",
      previous: {
        value: { text: "hello", version: "old" },
        capabilityCalls: [{ name: "slack.send", status: "success" }]
      },
      replay: {
        value: { text: "hello", version: "new" },
        capabilityCalls: [{ name: "slack.send", status: "success" }]
      },
      diff: {
        valueChanged: true,
        capabilityCallsChanged: false
      }
    });
  });

  it("rejects malformed replay samples before running the bundle", async () => {
    const root = await createTempDir();
    const entry = join(root, "plugin.ts");
    const sample = join(root, "sample.json");
    const stderr: string[] = [];
    await writeFile(entry, "export const handlers = { 'invoice.created': () => undefined };");
    await writeFile(sample, JSON.stringify({ payload: {} }));

    await expect(
      runExtCli(
        ["replay", "--entry", entry, "--sample", sample],
        rollbackOnlyClient,
        captureIo([], stderr)
      )
    ).resolves.toBe(2);

    expect(stderr).toEqual(["invalid replay sample: execution.hookName is required"]);
  });

  it("rejects replay samples without execution ids", async () => {
    const root = await createTempDir();
    const entry = join(root, "plugin.ts");
    const sample = join(root, "sample.json");
    const stderr: string[] = [];
    await writeFile(entry, "export const handlers = { 'invoice.created': () => undefined };");
    await writeFile(
      sample,
      JSON.stringify({
        execution: { hookName: "invoice.created", capabilityCalls: [] },
        payload: {}
      })
    );

    await expect(
      runExtCli(
        ["replay", "--entry", entry, "--sample", sample],
        rollbackOnlyClient,
        captureIo([], stderr)
      )
    ).resolves.toBe(2);

    expect(stderr).toEqual(["invalid replay sample: execution.id is required"]);
  });

  it("reports capability diffs when replay calls differ from the sample", async () => {
    const root = await createTempDir();
    const entry = join(root, "plugin.ts");
    const sample = join(root, "sample.json");
    const stdout: string[] = [];
    await writeFile(
      entry,
      [
        "export const handlers = {",
        "  'invoice.created': async (_payload, context) => {",
        "    await context.capability('email.send', { subject: 'changed' });",
        "    return null;",
        "  }",
        "};"
      ].join("\n")
    );
    await writeFile(
      sample,
      JSON.stringify({
        execution: {
          id: "exec_2",
          hookName: "invoice.created",
          capabilityCalls: [
            { name: "slack.send", status: "success" },
            { name: "ignored.bad", status: "unknown" }
          ]
        },
        payload: {},
        value: null
      })
    );

    await expect(
      runExtCli(
        ["replay", "--entry", entry, "--sample", sample],
        rollbackOnlyClient,
        captureIo(stdout, [])
      )
    ).resolves.toBe(0);

    expect(parseJson(stdout[0])).toEqual({
      executionId: "exec_2",
      hookName: "invoice.created",
      previous: {
        value: null,
        capabilityCalls: [{ name: "slack.send", status: "success" }]
      },
      replay: {
        value: null,
        capabilityCalls: [{ name: "email.send", status: "success" }]
      },
      diff: {
        valueChanged: false,
        capabilityCallsChanged: true
      }
    });
  });

  it("rejects missing replay sample paths", async () => {
    const stderr: string[] = [];

    await expect(
      runExtCli(["replay", "--entry", "plugin.ts"], rollbackOnlyClient, captureIo([], stderr))
    ).resolves.toBe(2);

    expect(stderr).toEqual(["missing required replay option: --sample"]);
  });
});

const rollbackOnlyClient: RollbackClient = {
  rollbackInstallation: () => {
    throw new Error("rollback should not be called");
  }
};

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tenantscript-ext-replay-"));
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
