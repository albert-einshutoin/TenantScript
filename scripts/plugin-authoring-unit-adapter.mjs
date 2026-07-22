import { spawnSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute, join, resolve } from "node:path";

import { loadPluginAuthoringTaskBehaviorCases } from "./plugin-authoring-behavior-cases.mjs";
import { verifyPluginAuthoringBuildReceipt } from "./plugin-authoring-build-contract.mjs";

const runnerPath = resolve(import.meta.dirname, "plugin-authoring-behavior-runner.mjs");
const judgeRoot = resolve(import.meta.dirname, "..");
const RESULT_PATTERN = /^TENANTSCRIPT_BEHAVIOR_RESULT:([A-Za-z0-9_-]+):([0-9a-f]{64})\n$/u;

export const PLUGIN_AUTHORING_UNIT_LIMITS = Object.freeze({
  timeoutMs: 3_000,
  streamOutputBytes: 32 * 1024,
  totalOutputBytes: 64 * 1024
});

export function createPluginAuthoringUnitTestAdapter({
  loadTaskCases = loadPluginAuthoringTaskBehaviorCases,
  spawnSyncImpl = spawnSync,
  randomBytesImpl = randomBytes,
  terminateProcessGroup = terminateUnitProcessGroup,
  detached = process.platform !== "darwin"
} = {}) {
  return (context) => {
    let cases;
    let receipt;
    try {
      validateContext(context);
      receipt = verifyPluginAuthoringBuildReceipt(context);
      // Behavior cases are judge code, not repository baseline data. Resolving them beside this
      // adapter binds the matrix to the reviewed image digest and keeps a mounted baseline from
      // replacing or omitting the tests used to score candidate behavior.
      cases = loadTaskCases(judgeRoot, context.task);
      assert(Array.isArray(cases) && cases.length >= 1 && cases.length <= 8);
    } catch {
      return false;
    }

    let passed = true;
    for (const behaviorCase of cases) {
      let child;
      try {
        const authenticationKey = randomBytesImpl(32);
        assert(Buffer.isBuffer(authenticationKey) && authenticationKey.length === 32);
        child = spawnSyncImpl(process.execPath, ["--no-warnings", runnerPath, receipt.bundlePath], {
          cwd: join(context.taskWorkspace, "build"),
          detached,
          encoding: "utf8",
          env: unitEnvironment(join(context.taskWorkspace, "build")),
          input: JSON.stringify({
            schemaVersion: 1,
            authenticationKey: authenticationKey.toString("base64url"),
            behaviorCase
          }),
          killSignal: "SIGKILL",
          maxBuffer: PLUGIN_AUTHORING_UNIT_LIMITS.streamOutputBytes,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: PLUGIN_AUTHORING_UNIT_LIMITS.timeoutMs
        });
        if (detached) terminateProcessGroup(child?.pid);
        assertValidChild(child);
        const observation = parseAuthenticatedObservation(child.stdout, authenticationKey);
        assert(isDeepStrictEqual(observation.result, behaviorCase.expected.result));
        assert(
          isDeepStrictEqual(observation.capabilityCalls, behaviorCase.expected.capabilityCalls)
        );
        assert(Array.isArray(observation.runtimeLogs) && observation.runtimeLogs.length === 0);
        assert(observation.pendingCapabilityCalls === 0);
      } catch {
        if (detached) terminateProcessGroup(child?.pid);
        passed = false;
      }
    }
    return passed;
  };
}

function parseAuthenticatedObservation(stdout, authenticationKey) {
  const match = RESULT_PATTERN.exec(stdout);
  assert(match !== null);
  const suppliedSignature = Buffer.from(match[2], "hex");
  const expectedSignature = createHmac("sha256", authenticationKey).update(match[1]).digest();
  assert(
    suppliedSignature.length === expectedSignature.length &&
      timingSafeEqual(suppliedSignature, expectedSignature)
  );
  const encoded = Buffer.from(match[1], "base64url");
  assert(encoded.length >= 1 && encoded.length <= PLUGIN_AUTHORING_UNIT_LIMITS.streamOutputBytes);
  const observation = JSON.parse(encoded.toString("utf8"));
  assertExactKeys(observation, [
    "schemaVersion",
    "result",
    "capabilityCalls",
    "runtimeLogs",
    "pendingCapabilityCalls"
  ]);
  assert(observation.schemaVersion === 1);
  return observation;
}

function assertValidChild(child) {
  assert(child !== null && typeof child === "object");
  assert(child.error === undefined && child.signal === null && child.status === 0);
  assert(typeof child.stdout === "string" && typeof child.stderr === "string");
  assert(
    Buffer.byteLength(child.stdout) + Buffer.byteLength(child.stderr) <=
      PLUGIN_AUTHORING_UNIT_LIMITS.totalOutputBytes
  );
  assert(child.stderr === "");
}

function validateContext(context) {
  assert(isPlainRecord(context));
  assertExactKeys(context, ["task", "baselineRoot", "taskRoot", "taskWorkspace"]);
  assert(isPlainRecord(context.task));
  assert(typeof context.task.id === "string");
  for (const path of [context.baselineRoot, context.taskRoot, context.taskWorkspace]) {
    assert(typeof path === "string" && isAbsolute(path) && resolve(path) === path);
    const metadata = lstatSync(path);
    assert(metadata.isDirectory() && !metadata.isSymbolicLink());
  }
  assert(context.taskRoot === join(context.taskWorkspace, "source"));
}

function unitEnvironment(buildRoot) {
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

function terminateUnitProcessGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === "win32") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function assertExactKeys(value, keys) {
  assert(isPlainRecord(value));
  assert(Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"));
}

function isPlainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assert(condition) {
  if (!condition) throw new Error("assertion failed");
}
