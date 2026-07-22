import { createHook } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { closeSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setImmediate as safeSetImmediate } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { serialize } from "node:v8";

const require = createRequire(import.meta.url);
const [, , bundlePath] = process.argv;
const write = process.stdout.write.bind(process.stdout);
const exit = process.exit.bind(process);
const getActiveResourcesInfo = process.getActiveResourcesInfo.bind(process);
const SafePromise = Promise;
const clone = structuredClone;
const bufferToString = Function.prototype.call.bind(Buffer.prototype.toString);
const arrayForEach = Function.prototype.call.bind(Array.prototype.forEach);
const objectCreate = Object.create;
const objectEntries = Object.entries;
const scheduledResources = objectCreate(null);
let runnerScheduling = false;
let dispatchSettled = false;
let postReturnCapabilityCall = false;
const resourceHook = createHook({
  init(asyncId, type) {
    // Track submitted timers independently of process resource reporting because unref() removes
    // them from that view without removing the deferred work or its capability side effects.
    if (!runnerScheduling && (type === "Timeout" || type === "Immediate")) {
      scheduledResources[asyncId] = type;
    }
  },
  destroy(asyncId) {
    delete scheduledResources[asyncId];
  }
});
const enableResourceHook = resourceHook.enable.bind(resourceHook);
const disableResourceHook = resourceHook.disable.bind(resourceHook);

try {
  const envelope = JSON.parse(readFileSync(0, "utf8"));
  closeSync(0);
  const authenticationKey = Buffer.from(envelope.authenticationKey, "base64url");
  const authenticator = createHmac("sha256", authenticationKey);
  const authenticateUpdate = authenticator.update.bind(authenticator);
  const authenticateDigest = authenticator.digest.bind(authenticator);
  const request = envelope.request;
  const baselineResources = countResources(getActiveResourcesInfo());
  enableResourceHook();
  const loadedBundle = require(bundlePath);
  const plugin = loadedBundle.plugin ?? loadedBundle.default;
  if (typeof plugin?.dispatch !== "function") throw new Error("bundle must export a plugin");

  const capabilityCalls = [];
  const result = await plugin.dispatch({
    hookName: request.hookName,
    payload: request.payload,
    context: {
      capability: async (name, input) => {
        if (dispatchSettled) postReturnCapabilityCall = true;
        const plannedCall = request.capabilityCalls[capabilityCalls.length];
        // Snapshot untrusted input at the call boundary so later plugin mutation cannot rewrite the
        // evidence compared by the parent process.
        capabilityCalls.push({ name, input: clone(input) });
        return clone(plannedCall?.result);
      }
    }
  });
  dispatchSettled = true;
  // Flush immediate/microtask work and one timer turn. Longer scheduled work remains visible in the
  // active-resource delta, while calls queued for the next turn enter the exact call list.
  await runnerImmediate();
  await runnerDelay();
  await runnerImmediate();
  disableResourceHook();
  const pendingAsyncWork =
    objectEntries(scheduledResources).length > 0 ||
    hasAdditionalResources(baselineResources, countResources(getActiveResourcesInfo()));
  const encodedResult = bufferToString(
    serialize({
      result: clone(result),
      capabilityCalls: clone(capabilityCalls),
      pendingAsyncWork,
      postReturnCapabilityCall
    }),
    "base64url"
  );
  authenticateUpdate(encodedResult);
  const signature = authenticateDigest("hex");
  write(`TENANTSCRIPT_BUNDLE_RESULT:${encodedResult}:${signature}\n`);
  // Do not let submitted timers run after the authenticated observation has completed.
  exit(0);
} catch {
  // The parent owns stable case-scoped diagnostics; do not reflect submitted exceptions or paths.
  process.exitCode = 1;
}

function runnerImmediate() {
  runnerScheduling = true;
  const promise = new SafePromise((resolve) => safeSetImmediate(resolve));
  runnerScheduling = false;
  return promise;
}

function runnerDelay() {
  runnerScheduling = true;
  const promise = delay(0);
  runnerScheduling = false;
  return promise;
}

function countResources(resources) {
  const counts = objectCreate(null);
  arrayForEach(resources, (resource) => {
    counts[resource] = (counts[resource] ?? 0) + 1;
  });
  return counts;
}

function hasAdditionalResources(baseline, current) {
  let additional = false;
  arrayForEach(objectEntries(current), (entry) => {
    const resource = entry[0];
    const count = entry[1];
    if (count > (baseline[resource] ?? 0)) additional = true;
  });
  return additional;
}
