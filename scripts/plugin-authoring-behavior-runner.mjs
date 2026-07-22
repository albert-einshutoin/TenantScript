#!/usr/bin/env node

import { createHmac } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { runScopedPluginDispatch } from "../packages/loader/dist/index.js";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_BUNDLE_BYTES = 1024 * 1024;

try {
  const bundlePath = process.argv[2];
  assert(process.argv.length === 3 && typeof bundlePath === "string");
  assert(isAbsolute(bundlePath) && resolve(bundlePath) === bundlePath);
  const bundleMetadata = lstatSync(bundlePath);
  assert(
    bundleMetadata.isFile() &&
      !bundleMetadata.isSymbolicLink() &&
      bundleMetadata.nlink === 1 &&
      bundleMetadata.size >= 1 &&
      bundleMetadata.size <= MAX_BUNDLE_BYTES
  );
  const input = readFileSync(0);
  assert(input.length >= 1 && input.length <= MAX_INPUT_BYTES);
  const envelope = JSON.parse(input.toString("utf8"));
  assertExactKeys(envelope, ["schemaVersion", "authenticationKey", "behaviorCase"]);
  assert(envelope.schemaVersion === 1);
  const authenticationKey = Buffer.from(envelope.authenticationKey, "base64url");
  assert(
    authenticationKey.length === 32 &&
      authenticationKey.toString("base64url") === envelope.authenticationKey
  );
  const behaviorCase = envelope.behaviorCase;
  assertBehaviorCase(behaviorCase);

  const capabilityCalls = [];
  let pendingCapabilityCalls = 0;
  const runtimeResult = await runScopedPluginDispatch({
    bundleCode: readFileSync(bundlePath, "utf8"),
    hookName: behaviorCase.hookName,
    payload: behaviorCase.payload,
    context: {
      capability: async (name, capabilityInput) => {
        const planned = behaviorCase.capabilityPlan[capabilityCalls.length];
        capabilityCalls.push({ name, input: structuredClone(capabilityInput) });
        pendingCapabilityCalls += 1;
        try {
          // Keep the result pending for one turn so fire-and-forget authority use remains visible.
          await new Promise((complete) => setImmediate(complete));
          if (planned?.outcome.status === "reject") throw new Error("planned capability failure");
          return structuredClone(planned?.outcome.value);
        } finally {
          pendingCapabilityCalls -= 1;
        }
      }
    },
    limits: {
      timeoutMs: 250,
      maxSubrequests: behaviorCase.capabilityPlan.length,
      memoryMb: 128
    }
  });

  const response = {
    schemaVersion: 1,
    result: structuredClone(runtimeResult.value),
    capabilityCalls: structuredClone(capabilityCalls),
    runtimeLogs: structuredClone(runtimeResult.logs),
    pendingCapabilityCalls
  };
  const encoded = Buffer.from(JSON.stringify(response)).toString("base64url");
  const signature = createHmac("sha256", authenticationKey).update(encoded).digest("hex");
  process.stdout.write(`TENANTSCRIPT_BEHAVIOR_RESULT:${encoded}:${signature}\n`);
  process.exitCode = 0;
} catch {
  // Candidate diagnostics and local paths never cross this process boundary.
  process.exitCode = 1;
}

function assertBehaviorCase(value) {
  assertExactKeys(value, ["name", "hookName", "payload", "capabilityPlan", "expected"]);
  assert(typeof value.name === "string" && value.name.length >= 1 && value.name.length <= 64);
  assert(
    typeof value.hookName === "string" && value.hookName.length >= 1 && value.hookName.length <= 96
  );
  assert(Array.isArray(value.capabilityPlan) && value.capabilityPlan.length <= 4);
  for (const step of value.capabilityPlan) {
    assertExactKeys(step, ["name", "input", "outcome"]);
    assert(typeof step.name === "string" && step.name.length >= 1 && step.name.length <= 96);
    assertExactKeys(
      step.outcome,
      step.outcome?.status === "resolve" ? ["status", "value"] : ["status"]
    );
    assert(step.outcome.status === "resolve" || step.outcome.status === "reject");
  }
  assertExactKeys(value.expected, ["result", "capabilityCalls"]);
  assert(Array.isArray(value.expected.capabilityCalls));
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
