import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const [, , bundlePath, encodedRequest] = process.argv;

try {
  const request = JSON.parse(Buffer.from(encodedRequest, "base64url").toString("utf8"));
  const loadedBundle = require(bundlePath);
  const plugin = loadedBundle.plugin ?? loadedBundle.default;
  if (typeof plugin?.dispatch !== "function") throw new Error("bundle must export a plugin");

  let capabilityCallCount = 0;
  const result = await plugin.dispatch({
    hookName: request.hookName,
    payload: request.payload,
    context: {
      capability: async () => {
        capabilityCallCount += 1;
        throw new Error("behavior cases must not invoke capabilities");
      }
    }
  });
  const encodedResult = Buffer.from(
    JSON.stringify({ result, capabilityCallCount }),
    "utf8"
  ).toString("base64url");
  process.stdout.write(`TENANTSCRIPT_BUNDLE_RESULT:${encodedResult}\n`);
} catch {
  // The parent owns stable case-scoped diagnostics; do not reflect submitted exceptions or paths.
  process.exitCode = 1;
}
