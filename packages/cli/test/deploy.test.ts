import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runExtCli, type CliIo, type DeployClient, type RollbackClient } from "../src/index.js";

const tempDirs: string[] = [];

describe("ext deploy", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("performs a dry-run build and manifest validation without calling the control plane", async () => {
    const { entry, manifest } = await createDeployFiles();
    const stdout: string[] = [];

    await expect(
      runExtCli(
        [
          "deploy",
          "--app",
          "app_1",
          "--plugin",
          "large-invoice-notify",
          "--version",
          "1.0.0",
          "--entry",
          entry,
          "--manifest",
          manifest,
          "--dry-run",
          "true"
        ],
        rollbackOnlyClient,
        captureIo(stdout, [])
      )
    ).resolves.toBe(0);

    expect(parseJson(stdout[0])).toMatchObject({
      dryRun: true,
      appId: "app_1",
      pluginKey: "large-invoice-notify",
      version: "1.0.0",
      manifest: {
        name: "large-invoice-notify",
        version: "1.0.0"
      }
    });
    expect((parseJson(stdout[0]) as { artifactHash: string }).artifactHash).toMatch(
      /^[a-f0-9]{64}$/
    );
  });

  it("registers the plugin and version through the control-plane client", async () => {
    const { entry, manifest } = await createDeployFiles();
    const calls: unknown[] = [];
    const stdout: string[] = [];
    const client: RollbackClient & DeployClient = {
      rollbackInstallation: rollbackOnlyClient.rollbackInstallation,
      registerPlugin: (request) => {
        calls.push({ method: "registerPlugin", request });
        return Promise.resolve({ id: "plugin_1", appId: request.appId, key: request.key });
      },
      registerPluginVersion: (request) => {
        calls.push({ method: "registerPluginVersion", request });
        return Promise.resolve({
          id: "version_1",
          pluginId: "plugin_1",
          version: request.version,
          artifactHash: request.artifactHash,
          manifest: request.manifest
        });
      }
    };

    await expect(
      runExtCli(
        [
          "deploy",
          "--app",
          "app_1",
          "--plugin",
          "large-invoice-notify",
          "--version",
          "1.0.0",
          "--entry",
          entry,
          "--manifest",
          manifest
        ],
        client,
        captureIo(stdout, [])
      )
    ).resolves.toBe(0);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      method: "registerPlugin",
      request: { appId: "app_1", key: "large-invoice-notify" }
    });
    expect(calls[1]).toMatchObject({
      method: "registerPluginVersion",
      request: {
        appId: "app_1",
        pluginKey: "large-invoice-notify",
        version: "1.0.0"
      }
    });
    expect(parseJson(stdout[0])).toMatchObject({
      dryRun: false,
      pluginId: "plugin_1",
      pluginVersionId: "version_1",
      version: "1.0.0"
    });
  });

  it("fails actual deploys when the control-plane client is not configured", async () => {
    const { entry, manifest } = await createDeployFiles();
    const stderr: string[] = [];

    await expect(
      runExtCli(
        [
          "deploy",
          "--app",
          "app_1",
          "--plugin",
          "large-invoice-notify",
          "--version",
          "1.0.0",
          "--entry",
          entry,
          "--manifest",
          manifest
        ],
        rollbackOnlyClient,
        captureIo([], stderr)
      )
    ).resolves.toBe(1);

    expect(stderr).toEqual(["deploy client is not configured"]);
  });

  it.each([
    ["app", []],
    ["plugin", ["--app", "app_1"]],
    ["version", ["--app", "app_1", "--plugin", "large-invoice-notify"]],
    ["entry", ["--app", "app_1", "--plugin", "large-invoice-notify", "--version", "1.0.0"]],
    [
      "manifest",
      [
        "--app",
        "app_1",
        "--plugin",
        "large-invoice-notify",
        "--version",
        "1.0.0",
        "--entry",
        "plugin.ts"
      ]
    ]
  ])("rejects missing --%s deploy options", async (missing, args) => {
    const stderr: string[] = [];

    await expect(
      runExtCli(["deploy", ...args], rollbackOnlyClient, captureIo([], stderr))
    ).resolves.toBe(2);

    expect(stderr).toEqual([`missing required deploy option: --${missing}`]);
  });

  it("rejects manifests whose version does not match the deploy version", async () => {
    const { entry, manifest } = await createDeployFiles();
    const stderr: string[] = [];

    await expect(
      runExtCli(
        [
          "deploy",
          "--app",
          "app_1",
          "--plugin",
          "large-invoice-notify",
          "--version",
          "2.0.0",
          "--entry",
          entry,
          "--manifest",
          manifest,
          "--dry-run",
          "true"
        ],
        rollbackOnlyClient,
        captureIo([], stderr)
      )
    ).resolves.toBe(2);

    expect(stderr).toEqual(["manifest version 1.0.0 does not match 2.0.0"]);
  });

  it("returns structured errors for invalid deploy manifests", async () => {
    const root = await createTempDir();
    const entry = join(root, "plugin.ts");
    const manifest = join(root, "manifest.json");
    const stdout: string[] = [];
    await writeFile(entry, "export const handlers = { 'invoice.created': () => undefined };");
    await writeFile(
      manifest,
      JSON.stringify({
        name: "large-invoice-notify",
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
        [
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
        ],
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
});

const rollbackOnlyClient: RollbackClient = {
  rollbackInstallation: () => {
    throw new Error("rollback should not be called");
  }
};

async function createDeployFiles(): Promise<{ entry: string; manifest: string }> {
  const root = await createTempDir();
  const entry = join(root, "plugin.ts");
  const manifest = join(root, "manifest.json");
  await writeFile(entry, "export const handlers = { 'invoice.created': () => ({ ok: true }) };");
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
  return { entry, manifest };
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tenantscript-ext-deploy-"));
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
