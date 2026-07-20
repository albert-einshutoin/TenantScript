import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WranglerWorkerDeployProcessError,
  createNodeWranglerWorkerDeployProcess
} from "../src/index.js";

const configPath = "wrangler.jsonc";
const workerName = "tenantscript-control-plane-0123456789abcdef01234567";
const ownershipTag = "tenantscript-setup-0123456789abcdef0123456789abcdef";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("Node Wrangler Worker deploy process", () => {
  it("executes pinned Wrangler once with exact strict arguments and closed environment", async () => {
    const fixture = await processFixture(`
      import { writeFile } from "node:fs/promises";
      await writeFile(
        ${JSON.stringify("RECEIPT")},
        JSON.stringify({
          argv: process.argv.slice(2),
          ci: process.env.CI,
          metrics: process.env.WRANGLER_SEND_METRICS
        })
      );
    `);
    const receiptPath = join(fixture.directory, "receipt.json");
    await replaceFixtureMarker(fixture.scriptPath, receiptPath);
    const deployProcess = createProcess(fixture.directory);

    await deployProcess.deploy({ configPath, workerName, ownershipTag });

    await expect(readJson(receiptPath)).resolves.toEqual({
      argv: [
        "deploy",
        "--config",
        configPath,
        "--name",
        workerName,
        "--tag",
        ownershipTag,
        "--strict",
        "--experimental-autoconfig=false",
        "--install-skills=false"
      ],
      ci: "true",
      metrics: "false"
    });
  });

  it.each([
    { configPath: "../outside.jsonc", workerName, ownershipTag },
    { configPath: "/tmp/outside.jsonc", workerName, ownershipTag },
    { configPath: "nested/wrangler.jsonc", workerName, ownershipTag },
    { configPath: "wrangler.toml", workerName, ownershipTag },
    { configPath: "wrangler;touch-pwned.jsonc", workerName, ownershipTag },
    { configPath, workerName: "Tenant Script", ownershipTag },
    { configPath, workerName, ownershipTag: "secret-sentinel" },
    { configPath, workerName, ownershipTag, env: "production-secret-sentinel" },
    { configPath }
  ])("rejects unsafe or widened deploy request before execution", async (request) => {
    const fixture = await processFixture(
      `await import("node:fs/promises").then(({ writeFile }) => writeFile(${JSON.stringify(
        "RECEIPT"
      )}, "spawned"));`
    );
    const unexpectedPath = join(fixture.directory, "unexpected.txt");
    await replaceFixtureMarker(fixture.scriptPath, unexpectedPath);
    const deployProcess = createProcess(fixture.directory);

    const error = await captureDeployError(deployProcess.deploy(request as never));

    expect(error.toJSON()).toEqual({ code: "wrangler_worker_deploy_failed" });
    expect(JSON.stringify(error)).not.toContain("secret-sentinel");
    await expect(readFile(unexpectedPath, "utf8")).rejects.toThrow();
  });

  it.each([
    { repositoryRoot: "relative/root" },
    { wranglerBinPath: "../outside.mjs" },
    { timeoutMs: 0 },
    { unexpected: "secret-sentinel" }
  ])("rejects unsafe process configuration before spawn", (override) => {
    expect(() =>
      createNodeWranglerWorkerDeployProcess({
        repositoryRoot: process.cwd(),
        wranglerBinPath: "node_modules/wrangler/bin/wrangler.js",
        timeoutMs: 2_000,
        ...override
      })
    ).toThrow("Wrangler Worker deploy process configuration is invalid");
  });

  it.each(["config", "binary"])("rejects a direct %s symlink", async (target) => {
    const fixture = await processFixture("");
    const externalPath = join(fixture.directory, `external-${target}.mjs`);
    await writeFile(externalPath, "");
    if (target === "config") {
      await rm(join(fixture.directory, configPath));
      await symlink(externalPath, join(fixture.directory, configPath), "file");
    } else {
      await rm(fixture.scriptPath);
      await symlink(externalPath, fixture.scriptPath, "file");
    }
    const deployProcess = createProcess(fixture.directory);

    await expect(
      deployProcess.deploy({ configPath, workerName, ownershipTag })
    ).rejects.toBeInstanceOf(WranglerWorkerDeployProcessError);
  });

  it("rejects a binary that escapes through a symlinked parent directory", async () => {
    const fixture = await processFixture("");
    const externalDirectory = temporaryDirectory("wrangler-worker-external");
    await mkdir(externalDirectory, { recursive: true });
    await writeFile(join(externalDirectory, "fake-wrangler.mjs"), "");
    await symlink(externalDirectory, join(fixture.directory, "linked-bin"), "dir");
    const deployProcess = createNodeWranglerWorkerDeployProcess({
      repositoryRoot: fixture.directory,
      wranglerBinPath: "linked-bin/fake-wrangler.mjs",
      timeoutMs: 2_000
    });

    await expect(
      deployProcess.deploy({ configPath, workerName, ownershipTag })
    ).rejects.toBeInstanceOf(WranglerWorkerDeployProcessError);
  });

  it("does not reflect stdout or stderr when Wrangler exits non-zero", async () => {
    const fixture = await processFixture(`
      console.log("stdout-secret-sentinel");
      console.error("stderr-secret-sentinel");
      process.exit(2);
    `);
    const deployProcess = createProcess(fixture.directory);

    const error = await captureDeployError(
      deployProcess.deploy({ configPath, workerName, ownershipTag })
    );

    expect(JSON.stringify(error)).not.toContain("secret-sentinel");
  });

  it("kills a hung process at timeout without retrying the mutation", async () => {
    const fixture = await processFixture(`
      import { appendFile } from "node:fs/promises";
      await appendFile(${JSON.stringify("RECEIPT")}, "attempt\\n");
      setInterval(() => undefined, 1_000);
    `);
    const receiptPath = join(fixture.directory, "attempts.txt");
    await replaceFixtureMarker(fixture.scriptPath, receiptPath);
    const deployProcess = createNodeWranglerWorkerDeployProcess({
      repositoryRoot: fixture.directory,
      wranglerBinPath: "fake-wrangler.mjs",
      timeoutMs: 500
    });

    const startedAt = Date.now();
    await expect(
      deployProcess.deploy({ configPath, workerName, ownershipTag })
    ).rejects.toBeInstanceOf(WranglerWorkerDeployProcessError);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await expect(readFile(receiptPath, "utf8")).resolves.toBe("attempt\n");
  });
});

function createProcess(repositoryRoot: string) {
  return createNodeWranglerWorkerDeployProcess({
    repositoryRoot,
    wranglerBinPath: "fake-wrangler.mjs",
    timeoutMs: 2_000
  });
}

async function processFixture(source: string): Promise<{
  directory: string;
  scriptPath: string;
}> {
  const directory = temporaryDirectory("wrangler-worker-deploy");
  await mkdir(directory, { recursive: true });
  const scriptPath = join(directory, "fake-wrangler.mjs");
  await writeFile(scriptPath, source);
  await writeFile(join(directory, configPath), "{}\n");
  return { directory, scriptPath };
}

function temporaryDirectory(prefix: string): string {
  const directory = join(process.cwd(), ".tmp", `${prefix}-${crypto.randomUUID()}`);
  temporaryDirectories.push(directory);
  return directory;
}

async function replaceFixtureMarker(path: string, replacement: string): Promise<void> {
  const source = await readFile(path, "utf8");
  await writeFile(path, source.replace('"RECEIPT"', JSON.stringify(replacement)));
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function captureDeployError(value: unknown): Promise<WranglerWorkerDeployProcessError> {
  try {
    await value;
  } catch (error) {
    if (error instanceof WranglerWorkerDeployProcessError) return error;
    throw error;
  }
  throw new Error("expected Worker deploy process failure");
}
