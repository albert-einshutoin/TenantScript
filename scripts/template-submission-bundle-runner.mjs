import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { serialize } from "node:v8";
import { runScopedPluginDispatch } from "../packages/loader/dist/index.js";

const [, , bundlePath] = process.argv;
const write = process.stdout.write.bind(process.stdout);
const clone = structuredClone;
const bufferToString = Function.prototype.call.bind(Buffer.prototype.toString);

try {
  const envelope = JSON.parse(readFileSync(0, "utf8"));
  const authenticationKey = Buffer.from(envelope.authenticationKey, "base64url");
  const authenticator = createHmac("sha256", authenticationKey);
  const authenticateUpdate = authenticator.update.bind(authenticator);
  const authenticateDigest = authenticator.digest.bind(authenticator);
  const request = envelope.request;
  const capabilityCalls = [];
  const runtimeResult = await runScopedPluginDispatch({
    bundleCode: readFileSync(bundlePath, "utf8"),
    hookName: request.hookName,
    payload: request.payload,
    context: {
      capability: async (name, input) => {
        const plannedCall = request.capabilityCalls[capabilityCalls.length];
        // Snapshot untrusted input at the call boundary so later plugin mutation cannot rewrite the
        // evidence compared by the parent process.
        capabilityCalls.push({ name, input: clone(input) });
        return clone(plannedCall?.result);
      }
    },
    limits: {
      timeoutMs: 250,
      maxSubrequests: request.capabilityCalls?.length ?? 0,
      memoryMb: 128
    }
  });
  const result = runtimeResult.value;
  const encodedResult = bufferToString(
    serialize({
      result: clone(result),
      capabilityCalls: clone(capabilityCalls),
      runtimeLogs: clone(runtimeResult.logs)
    }),
    "base64url"
  );
  authenticateUpdate(encodedResult);
  const signature = authenticateDigest("hex");
  write(`TENANTSCRIPT_BUNDLE_RESULT:${encodedResult}:${signature}\n`);
  // The loader owns Worker termination; allow it to settle instead of aborting the process while
  // Node is still closing the sandbox thread.
  process.exitCode = 0;
} catch {
  // The parent owns stable case-scoped diagnostics; do not reflect submitted exceptions or paths.
  process.exitCode = 1;
}
