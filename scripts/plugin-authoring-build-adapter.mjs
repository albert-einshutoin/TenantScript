import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

const workerPath = resolve(import.meta.dirname, "plugin-authoring-build-worker.mjs");

export const PLUGIN_AUTHORING_BUILD_LIMITS = Object.freeze({
  timeoutMs: 10_000,
  streamOutputBytes: 32 * 1024,
  totalOutputBytes: 64 * 1024
});

export function createPluginAuthoringBuildAdapter({
  spawnSyncImpl = spawnSync,
  terminateProcessGroup = terminateBuildProcessGroup,
  detached = process.platform !== "darwin"
} = {}) {
  return (context) => {
    let child;
    try {
      const paths = validateContext(context);
      mkdirSync(paths.buildRoot, { mode: 0o700 });
      const requestPath = join(paths.buildRoot, "request.json");
      writeFileSync(
        requestPath,
        `${JSON.stringify({
          schemaVersion: 1,
          taskId: context.task.id,
          taskRoot: paths.taskRoot,
          buildRoot: paths.buildRoot
        })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 }
      );
      // A trusted worker owns compiler configuration. Candidate scripts, loaders, environment,
      // and config files therefore never become executable process configuration.
      child = spawnSyncImpl(process.execPath, [workerPath, requestPath], {
        cwd: paths.buildRoot,
        detached,
        encoding: "utf8",
        env: buildEnvironment(paths.buildRoot),
        killSignal: "SIGKILL",
        maxBuffer: PLUGIN_AUTHORING_BUILD_LIMITS.streamOutputBytes,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: PLUGIN_AUTHORING_BUILD_LIMITS.timeoutMs
      });
      if (detached) terminateProcessGroup(child?.pid);
      return (
        child !== null &&
        typeof child === "object" &&
        child.error === undefined &&
        child.signal === null &&
        child.status === 0 &&
        Buffer.byteLength(child.stdout) + Buffer.byteLength(child.stderr) <=
          PLUGIN_AUTHORING_BUILD_LIMITS.totalOutputBytes &&
        child.stdout === '{"ok":true}\n' &&
        child.stderr === ""
      );
    } catch {
      if (detached) terminateProcessGroup(child?.pid);
      return false;
    }
  };
}

function validateContext(context) {
  assert(isPlainRecord(context));
  assertExactKeys(context, ["task", "baselineRoot", "taskRoot", "taskWorkspace"]);
  assert(isPlainRecord(context.task));
  assert(
    typeof context.task.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(context.task.id)
  );
  for (const path of [context.baselineRoot, context.taskRoot, context.taskWorkspace]) {
    assert(typeof path === "string" && isAbsolute(path) && resolve(path) === path);
    const metadata = lstatSync(path);
    assert(metadata.isDirectory() && !metadata.isSymbolicLink());
  }
  // baselineRoot is deliberately validated but not passed to the compiler. Build inputs stay on
  // the inspected task snapshot and the fixed in-image authoring contract only.
  assert(basename(context.taskWorkspace) === context.task.id);
  assert(context.taskRoot === join(context.taskWorkspace, "source"));
  const buildRoot = join(context.taskWorkspace, "build");
  try {
    lstatSync(buildRoot);
    assert(false);
  } catch (error) {
    assert(error?.code === "ENOENT");
  }
  return {
    baselineRoot: context.baselineRoot,
    taskRoot: context.taskRoot,
    taskWorkspace: context.taskWorkspace,
    buildRoot
  };
}

function buildEnvironment(buildRoot) {
  return {
    HOME: buildRoot,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NODE_ENV: "production",
    NO_COLOR: "1",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: buildRoot,
    TZ: "UTC"
  };
}

function terminateBuildProcessGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === "win32") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function assertExactKeys(value, keys) {
  assert(
    Object.keys(value).sort(compareText).join("\0") === [...keys].sort(compareText).join("\0")
  );
}

function isPlainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assert(condition) {
  if (!condition) throw new Error("assertion failed");
}
