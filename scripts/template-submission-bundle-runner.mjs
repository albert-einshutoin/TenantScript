import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const [, , bundlePath, encodedRequest] = process.argv;

try {
  const request = JSON.parse(Buffer.from(encodedRequest, "base64url").toString("utf8"));
  const loadedBundle = require(bundlePath);
  const plugin = loadedBundle.plugin ?? loadedBundle.default;
  if (typeof plugin?.dispatch !== "function") throw new Error("bundle must export a plugin");

  const capabilityCalls = [];
  const result = await plugin.dispatch({
    hookName: request.hookName,
    payload: request.payload,
    context: {
      capability: async (name, input) => {
        const plannedCall = request.capabilityCalls[capabilityCalls.length];
        // Snapshot untrusted input at the call boundary so later plugin mutation cannot rewrite the
        // evidence compared by the parent process.
        capabilityCalls.push({ name, input: structuredClone(input) });
        return structuredClone(plannedCall?.result);
      }
    }
  });
  const encodedResult = Buffer.from(JSON.stringify({ result, capabilityCalls }), "utf8").toString(
    "base64url"
  );
  process.stdout.write(`TENANTSCRIPT_BUNDLE_RESULT:${encodedResult}\n`);
} catch {
  // The parent owns stable case-scoped diagnostics; do not reflect submitted exceptions or paths.
  process.exitCode = 1;
}
