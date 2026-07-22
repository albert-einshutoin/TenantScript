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
  let outstandingCapabilityCalls = 0;
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
        outstandingCapabilityCalls += 1;
        try {
          // Keep the synthetic result pending through the current event-loop turn. Awaited calls
          // still complete quickly, while fire-and-forget calls remain observable when dispatch
          // returns and cannot be misreported as completed side effects.
          await new Promise((resolve) => setImmediate(resolve));
          return clone(plannedCall?.result);
        } finally {
          outstandingCapabilityCalls -= 1;
        }
      }
    },
    limits: {
      timeoutMs: 250,
      maxSubrequests: request.capabilityCalls?.length ?? 0,
      memoryMb: 128
    }
  });
  if (outstandingCapabilityCalls !== 0) {
    throw new Error("dispatch returned with outstanding capability calls");
  }
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
