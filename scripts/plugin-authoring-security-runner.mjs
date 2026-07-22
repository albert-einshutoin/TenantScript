#!/usr/bin/env node

import { createHmac } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { runScopedPluginDispatch } from "../packages/loader/dist/index.js";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_BUNDLE_BYTES = 1024 * 1024;
const RESULT_PREFIX = "TENANTSCRIPT_SECURITY_RESULT";

try {
  const bundlePath = process.argv[2];
  assert(process.argv.length === 3 && typeof bundlePath === "string");
  assert(isAbsolute(bundlePath) && resolve(bundlePath) === bundlePath);
  const metadata = lstatSync(bundlePath);
  assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1);
  assert(metadata.size >= 1 && metadata.size <= MAX_BUNDLE_BYTES);

  const input = readFileSync(0);
  assert(input.length >= 1 && input.length <= MAX_INPUT_BYTES);
  const envelope = JSON.parse(input.toString("utf8"));
  assertExactKeys(envelope, [
    "schemaVersion",
    "authenticationKey",
    "securityCase",
    "allowedCapabilities"
  ]);
  assert(envelope.schemaVersion === 1);
  const authenticationKey = Buffer.from(envelope.authenticationKey, "base64url");
  assert(
    authenticationKey.length === 32 &&
      authenticationKey.toString("base64url") === envelope.authenticationKey
  );
  assert(Array.isArray(envelope.allowedCapabilities));
  assert(envelope.allowedCapabilities.every((name) => typeof name === "string"));
  assert(new Set(envelope.allowedCapabilities).size === envelope.allowedCapabilities.length);
  assertSecurityCase(envelope.securityCase, envelope.allowedCapabilities);

  const canary = process.env.TENANTSCRIPT_SECURITY_CANARY;
  assert(typeof canary === "string" && /^[0-9a-f]{64}$/u.test(canary));
  const boundaryProbesPassed = await runBoundaryProbes();
  const capabilityCalls = [];
  let pendingCapabilityCalls = 0;
  const runtimeResult = await runScopedPluginDispatch({
    bundleCode: readFileSync(bundlePath, "utf8"),
    hookName: envelope.securityCase.hookName,
    payload: envelope.securityCase.payload,
    context: {
      capability: async (name, capabilityInput) => {
        const planned = envelope.securityCase.capabilityPlan[capabilityCalls.length];
        capabilityCalls.push({ name, input: structuredClone(capabilityInput) });
        pendingCapabilityCalls += 1;
        try {
          await new Promise((complete) => setImmediate(complete));
          assert(planned !== undefined && planned.name === name);
          assert(isDeepStrictEqual(planned.input, capabilityInput));
          if (planned.outcome.status === "reject") throw new Error("planned capability failure");
          return structuredClone(planned.outcome.value);
        } finally {
          pendingCapabilityCalls -= 1;
        }
      }
    },
    limits: {
      timeoutMs: 250,
      maxSubrequests: envelope.securityCase.capabilityPlan.length,
      memoryMb: 128
    }
  });

  const candidateObservation = {
    result: structuredClone(runtimeResult.value),
    capabilityCalls: structuredClone(capabilityCalls),
    runtimeLogs: structuredClone(runtimeResult.logs),
    pendingCapabilityCalls
  };
  const canaryVisible = JSON.stringify(candidateObservation).includes(canary);
  const response = {
    schemaVersion: 1,
    boundaryProbesPassed,
    capabilityCalls: candidateObservation.capabilityCalls,
    runtimeLogs: candidateObservation.runtimeLogs,
    pendingCapabilityCalls,
    canaryVisible
  };
  const encoded = Buffer.from(JSON.stringify(response)).toString("base64url");
  const signature = createHmac("sha256", authenticationKey).update(encoded).digest("hex");
  process.stdout.write(`${RESULT_PREFIX}:${encoded}:${signature}\n`);
  process.exitCode = 0;
} catch {
  // Candidate diagnostics, canaries, and local paths never cross this process boundary.
  process.exitCode = 1;
}

async function runBoundaryProbes() {
  try {
    const isolation = await runScopedPluginDispatch({
      bundleCode: `exports.plugin={dispatch:()=>{const recover=(value)=>{try{return Boolean(value.constructor.constructor("return process")())}catch{return false}};return {ok:true,value:{processVisible:typeof process!=="undefined",requireVisible:typeof require!=="undefined",secretVisible:typeof TENANTSCRIPT_SECURITY_CANARY!=="undefined",urlRecovery:recover(URL),fetchRecovery:recover(fetch),moduleRecovery:recover(module)}}}};`,
      hookName: "security.probe",
      payload: {},
      context: { capability: async () => null },
      limits: { timeoutMs: 100, maxSubrequests: 0, memoryMb: 128 }
    });
    assert(
      isDeepStrictEqual(isolation, {
        value: {
          ok: true,
          value: {
            processVisible: false,
            requireVisible: false,
            secretVisible: false,
            urlRecovery: false,
            fetchRecovery: false,
            moduleRecovery: false
          }
        },
        logs: []
      })
    );

    const egress = await runScopedPluginDispatch({
      bundleCode: `exports.plugin={dispatch:async()=>{try{await fetch("https://security-probe.invalid/leak")}catch{}return {ok:true,value:"blocked"}}};`,
      hookName: "security.probe",
      payload: {},
      context: { capability: async () => null },
      limits: { timeoutMs: 100, maxSubrequests: 1, memoryMb: 128 }
    });
    assert(
      isDeepStrictEqual(egress, {
        value: { ok: true, value: "blocked" },
        logs: [{ reason: "egress_denied", target: "https://security-probe.invalid/leak" }]
      })
    );

    let budgetExceeded = false;
    try {
      await runScopedPluginDispatch({
        bundleCode: `exports.plugin={dispatch:async({context})=>{await context.capability("probe.allowed",{});await context.capability("probe.allowed",{});return {ok:true}}};`,
        hookName: "security.probe",
        payload: {},
        context: { capability: async () => ({ ok: true }) },
        limits: { timeoutMs: 100, maxSubrequests: 1, memoryMb: 128 }
      });
    } catch (error) {
      budgetExceeded =
        error?.executionStatus === "budget_exceeded" &&
        error?.logs?.[0]?.reason === "subrequest_limit_exceeded";
    }
    assert(budgetExceeded);

    let timedOut = false;
    try {
      await runScopedPluginDispatch({
        bundleCode: `exports.plugin={dispatch:()=>{while(true){}}};`,
        hookName: "security.probe",
        payload: {},
        context: { capability: async () => null },
        limits: { timeoutMs: 25, maxSubrequests: 0, memoryMb: 128 }
      });
    } catch (error) {
      timedOut = error?.executionStatus === "timeout";
    }
    assert(timedOut);
    return true;
  } catch {
    return false;
  }
}

function assertSecurityCase(value, allowedCapabilities) {
  assertExactKeys(value, ["name", "hookName", "payload", "capabilityPlan"]);
  assert(typeof value.name === "string" && value.name.length >= 1 && value.name.length <= 64);
  assert(
    typeof value.hookName === "string" && value.hookName.length >= 1 && value.hookName.length <= 96
  );
  assert(isPlainRecord(value.payload));
  for (const key of ["__proto__", "constructor", "prototype"])
    assert(Object.hasOwn(value.payload, key));
  assertBoundedJson(value.payload);
  assert(Array.isArray(value.capabilityPlan) && value.capabilityPlan.length <= 4);
  for (const step of value.capabilityPlan) {
    assertExactKeys(step, ["name", "input", "outcome"]);
    assert(typeof step.name === "string" && step.name.length >= 1 && step.name.length <= 96);
    assert(allowedCapabilities.includes(step.name));
    assertBoundedJson(step.input);
    assertExactKeys(
      step.outcome,
      step.outcome?.status === "resolve" ? ["status", "value"] : ["status"]
    );
    assert(step.outcome.status === "resolve" || step.outcome.status === "reject");
    if (step.outcome.status === "resolve") assertBoundedJson(step.outcome.value);
  }
}

function assertBoundedJson(value) {
  const state = { nodes: 0 };
  const visit = (current, depth) => {
    state.nodes += 1;
    assert(state.nodes <= 256 && depth <= 8);
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "number")
      return assert(Number.isFinite(current) && !Object.is(current, -0));
    if (typeof current === "string")
      return assert(current.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(current));
    if (Array.isArray(current)) {
      assert(current.length <= 32);
      return current.forEach((entry) => visit(entry, depth + 1));
    }
    assert(isPlainRecord(current));
    const keys = Object.keys(current);
    assert(keys.length <= 32);
    for (const key of keys) {
      assert(key.length >= 1 && key.length <= 80);
      visit(current[key], depth + 1);
    }
  };
  visit(value, 0);
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
