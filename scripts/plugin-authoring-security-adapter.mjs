import { spawnSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { verifyPluginAuthoringBuildReceipt } from "./plugin-authoring-build-contract.mjs";
import { loadPluginAuthoringTaskSecurityCases } from "./plugin-authoring-security-cases.mjs";

const runnerPath = resolve(import.meta.dirname, "plugin-authoring-security-runner.mjs");
const judgeRoot = resolve(import.meta.dirname, "..");
const RESULT_PATTERN = /^TENANTSCRIPT_SECURITY_RESULT:([A-Za-z0-9_-]+):([0-9a-f]{64})\n$/u;

export const PLUGIN_AUTHORING_SECURITY_LIMITS = Object.freeze({
  timeoutMs: 4_000,
  streamOutputBytes: 32 * 1024,
  totalOutputBytes: 64 * 1024
});

export function createPluginAuthoringSecurityTestAdapter({
  loadTaskCases = loadPluginAuthoringTaskSecurityCases,
  spawnSyncImpl = spawnSync,
  randomBytesImpl = randomBytes,
  terminateProcessGroup = terminateSecurityProcessGroup,
  detached = process.platform !== "darwin"
} = {}) {
  return (context) => {
    let cases;
    let receipt;
    try {
      validateContext(context);
      receipt = verifyPluginAuthoringBuildReceipt(context);
      cases = loadTaskCases(judgeRoot, context.task);
      assert(Array.isArray(cases) && cases.length >= 1 && cases.length <= 2);
    } catch {
      return false;
    }

    let passed = true;
    const securityRoot = join(context.taskWorkspace, "security");
    try {
      mkdirSync(securityRoot, { recursive: false, mode: 0o700 });
    } catch {
      return false;
    }
    for (const securityCase of cases) {
      let child;
      try {
        const authenticationKey = randomBytesImpl(32);
        const canaryBytes = randomBytesImpl(32);
        const markerBytes = randomBytesImpl(16);
        assert(Buffer.isBuffer(authenticationKey) && authenticationKey.length === 32);
        assert(Buffer.isBuffer(canaryBytes) && canaryBytes.length === 32);
        assert(Buffer.isBuffer(markerBytes) && markerBytes.length === 16);
        const canary = canaryBytes.toString("hex");
        const escapeMarkerPath = join(securityRoot, `escape-${markerBytes.toString("hex")}`);
        assert(!existsSync(escapeMarkerPath));
        child = spawnSyncImpl(process.execPath, ["--no-warnings", runnerPath, receipt.bundlePath], {
          cwd: securityRoot,
          detached,
          encoding: "utf8",
          env: securityEnvironment(securityRoot, canary, escapeMarkerPath),
          input: JSON.stringify({
            schemaVersion: 1,
            authenticationKey: authenticationKey.toString("base64url"),
            securityCase,
            allowedCapabilities: context.task.capabilities
          }),
          killSignal: "SIGKILL",
          maxBuffer: PLUGIN_AUTHORING_SECURITY_LIMITS.streamOutputBytes,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: PLUGIN_AUTHORING_SECURITY_LIMITS.timeoutMs
        });
        if (detached) terminateProcessGroup(child?.pid);
        assertValidChild(child);
        assert(!existsSync(escapeMarkerPath));
        const observation = parseAuthenticatedObservation(child.stdout, authenticationKey);
        assert(observation.boundaryProbesPassed === true);
        assert(observation.canaryVisible === false);
        assert(Array.isArray(observation.capabilityCalls));
        assert(observation.capabilityCalls.length === securityCase.capabilityPlan.length);
        for (const [index, call] of observation.capabilityCalls.entries()) {
          const planned = securityCase.capabilityPlan[index];
          assert(isAllowedCapabilityCall(call, context.task.capabilities));
          assert(call.name === planned.name && isDeepStrictEqual(call.input, planned.input));
        }
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
  const supplied = Buffer.from(match[2], "hex");
  const expected = createHmac("sha256", authenticationKey).update(match[1]).digest();
  assert(supplied.length === expected.length && timingSafeEqual(supplied, expected));
  const encoded = Buffer.from(match[1], "base64url");
  assert(
    encoded.length >= 1 && encoded.length <= PLUGIN_AUTHORING_SECURITY_LIMITS.streamOutputBytes
  );
  const observation = JSON.parse(encoded.toString("utf8"));
  assertExactKeys(observation, [
    "schemaVersion",
    "boundaryProbesPassed",
    "capabilityCalls",
    "runtimeLogs",
    "pendingCapabilityCalls",
    "canaryVisible"
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
      PLUGIN_AUTHORING_SECURITY_LIMITS.totalOutputBytes
  );
  assert(child.stderr === "");
}

function isAllowedCapabilityCall(call, allowedCapabilities) {
  return (
    isPlainRecord(call) &&
    typeof call.name === "string" &&
    allowedCapabilities.includes(call.name) &&
    Object.hasOwn(call, "input") &&
    Object.keys(call).length === 2
  );
}

function validateContext(context) {
  assert(isPlainRecord(context));
  assertExactKeys(context, ["task", "baselineRoot", "taskRoot", "taskWorkspace"]);
  assert(isPlainRecord(context.task) && Array.isArray(context.task.capabilities));
  for (const path of [context.baselineRoot, context.taskRoot, context.taskWorkspace]) {
    assert(typeof path === "string" && isAbsolute(path) && resolve(path) === path);
    const metadata = lstatSync(path);
    assert(metadata.isDirectory() && !metadata.isSymbolicLink());
  }
  assert(context.taskRoot === join(context.taskWorkspace, "source"));
}

function securityEnvironment(root, canary, escapeMarkerPath) {
  return {
    HOME: root,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NODE_ENV: "production",
    NO_COLOR: "1",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: root,
    TZ: "UTC",
    TENANTSCRIPT_SECURITY_CANARY: canary,
    TENANTSCRIPT_SECURITY_ESCAPE_PATH: escapeMarkerPath
  };
}

function terminateSecurityProcessGroup(pid) {
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
