import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const DEFAULT_WRANGLER_BIN_PATH = "node_modules/wrangler/bin/wrangler.js";
const DEFAULT_TIMEOUT_MS = 120_000;

export type WranglerWorkerDeployProcessErrorCode = "wrangler_worker_deploy_failed";

export class WranglerWorkerDeployProcessError extends Error {
  override readonly name = "WranglerWorkerDeployProcessError";
  readonly code = "wrangler_worker_deploy_failed";

  constructor() {
    super("wrangler_worker_deploy_failed");
  }

  toJSON(): { code: WranglerWorkerDeployProcessErrorCode } {
    return { code: this.code };
  }
}

export interface WranglerWorkerDeployProcess {
  deploy: (request: { configPath: string }) => Promise<void> | void;
}

export function createNodeWranglerWorkerDeployProcess(params: {
  repositoryRoot: string;
  wranglerBinPath?: string;
  timeoutMs?: number;
}): WranglerWorkerDeployProcess {
  validateConfiguration(params);
  const wranglerBinPath = params.wranglerBinPath ?? DEFAULT_WRANGLER_BIN_PATH;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    deploy: async (request): Promise<void> => {
      if (
        !isRecord(request) ||
        !hasExactKeys(request, ["configPath"]) ||
        !isRootWranglerConfigPath(request.configPath)
      ) {
        throw deployFailure();
      }

      const executablePath = resolveInside(params.repositoryRoot, wranglerBinPath);
      const configFilePath = resolveInside(params.repositoryRoot, request.configPath);
      try {
        const repositoryRoot = await assertRepositoryRoot(params.repositoryRoot);
        await Promise.all([
          assertContainedRegularFile(repositoryRoot, executablePath),
          assertContainedRegularFile(repositoryRoot, configFilePath)
        ]);
        await runWranglerDeploy({
          repositoryRoot: params.repositoryRoot,
          executablePath,
          configPath: request.configPath,
          timeoutMs
        });
      } catch (error) {
        if (error instanceof WranglerWorkerDeployProcessError) throw error;
        throw deployFailure();
      }
    }
  };
}

function validateConfiguration(value: unknown): asserts value is {
  repositoryRoot: string;
  wranglerBinPath?: string;
  timeoutMs?: number;
} {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["repositoryRoot", "wranglerBinPath", "timeoutMs"]) ||
    !Object.hasOwn(value, "repositoryRoot") ||
    typeof value.repositoryRoot !== "string" ||
    !isAbsolute(value.repositoryRoot) ||
    (value.wranglerBinPath !== undefined && !isSafeRelativePath(value.wranglerBinPath)) ||
    (value.timeoutMs !== undefined && !isBoundedInteger(value.timeoutMs, 1, 600_000))
  ) {
    throw new TypeError("Wrangler Worker deploy process configuration is invalid");
  }
}

async function assertRepositoryRoot(path: string): Promise<string> {
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) throw deployFailure();
  return realpath(path);
}

async function assertContainedRegularFile(root: string, path: string): Promise<void> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) throw deployFailure();
  const resolved = await realpath(path);
  const relation = relative(root, resolved);
  // Lexical checks cannot see parent-directory symlinks, so canonical containment is verified
  // immediately before the mutation process starts.
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
    throw deployFailure();
  }
}

function runWranglerDeploy(params: {
  repositoryRoot: string;
  executablePath: string;
  configPath: string;
  timeoutMs: number;
}): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const child = spawn(
      process.execPath,
      [
        params.executablePath,
        "deploy",
        "--config",
        params.configPath,
        "--strict",
        "--experimental-autoconfig=false",
        "--install-skills=false"
      ],
      {
        cwd: params.repositoryRoot,
        shell: false,
        stdio: "ignore",
        env: {
          ...process.env,
          CI: "true",
          WRANGLER_SEND_METRICS: "false"
        }
      }
    );

    const settle = (error?: WranglerWorkerDeployProcessError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) resolvePromise();
      else rejectPromise(error);
    };
    const timeout = setTimeout(() => {
      // A timed-out deployment has an ambiguous remote outcome. Kill it once and let the future
      // ownership adapter reconcile deployments instead of replaying the mutation here.
      child.kill("SIGKILL");
      settle(deployFailure());
    }, params.timeoutMs);
    child.once("error", () => {
      settle(deployFailure());
    });
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) settle();
      else settle(deployFailure());
    });
  });
}

function resolveInside(root: string, path: string): string {
  const resolved = resolve(root, path);
  const relation = relative(root, resolved);
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
    throw deployFailure();
  }
  return resolved;
}

function isRootWranglerConfigPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonc?$/u.test(value)
  );
}

function isSafeRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !isAbsolute(value) &&
    !value.includes("\0") &&
    !value.split(/[\\/]+/u).includes("..")
  );
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function deployFailure(): WranglerWorkerDeployProcessError {
  return new WranglerWorkerDeployProcessError();
}
