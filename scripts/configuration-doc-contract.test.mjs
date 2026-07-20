import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [
  reference,
  workerEntry,
  adminEnv,
  cliBin,
  cliBinaryClient,
  runtimeWrangler,
  proxySource,
  exampleSource,
  rootReadme,
  adminReadme
] = await Promise.all([
  readFile(new URL("../docs/reference/configuration.md", import.meta.url), "utf8"),
  readFile(new URL("../packages/control-plane/src/worker-entry.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/admin-ui/src/vite-env.d.ts", import.meta.url), "utf8"),
  readFile(new URL("../packages/cli/src/bin.ts", import.meta.url), "utf8"),
  readFile(new URL("../packages/cli/src/binary-client.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/runtime-bench/wrangler.jsonc", import.meta.url), "utf8"),
  readFile(new URL("../packages/proxy/src/index.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/example-saas/src/index.ts", import.meta.url), "utf8"),
  readFile(new URL("../README.md", import.meta.url), "utf8"),
  readFile(new URL("../apps/admin-ui/README.md", import.meta.url), "utf8")
]);

test("documents every fixed public Control Plane Worker setting from the runtime interface", () => {
  const envInterface = workerEntry.match(/interface ControlPlaneWorkerEnv \{([\s\S]*?)\n\}/u)?.[1];
  assert.ok(envInterface, "ControlPlaneWorkerEnv interface is missing");
  const names = [...envInterface.matchAll(/^\s+([A-Z][A-Z0-9_]+)\??:/gmu)].map((match) => match[1]);
  assert.ok(names.length > 0, "no Control Plane Worker settings were discovered");
  for (const name of names) assert.ok(reference.includes("`" + name + "`"));
  assert.match(reference, /app database bindings such as\s+`APP_ACME_DB`/u);
});

test("documents Admin UI, CLI, runtime benchmark, Proxy, and example app configuration", () => {
  for (const name of adminEnv.match(/VITE_[A-Z0-9_]+/gu) ?? []) {
    assert.ok(reference.includes("`" + name + "`"));
  }
  for (const [, name] of cliBin.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/gu)) {
    assert.ok(reference.includes("`" + name + "`"));
  }
  for (const [, name] of cliBinaryClient.matchAll(/environment\.([A-Z][A-Z0-9_]+)/gu)) {
    assert.ok(reference.includes("`" + name + "`"));
  }
  const runtimeBindings = [...runtimeWrangler.matchAll(/"binding":\s*"([A-Z][A-Z0-9_]*)"/gu)];
  assert.ok(runtimeBindings.length > 0, "no runtime benchmark bindings were discovered");
  for (const [, name] of runtimeBindings) assert.ok(reference.includes("`" + name + "`"));
  for (const heading of [
    "Control Plane Worker",
    "Admin UI",
    "CLI",
    "Runtime benchmark",
    "Proxy",
    "Example SaaS"
  ]) {
    assert.match(reference, new RegExp(`## ${heading}`, "u"));
  }
  assert.match(reference, /Proxy[^]*no public environment variables/iu);
  assert.match(reference, /Example SaaS[^]*no public environment variables/iu);
  for (const [component, source] of [
    ["Proxy", proxySource],
    ["Example SaaS", exampleSource]
  ]) {
    assert.doesNotMatch(
      source,
      /(?:process\.env|import\.meta\.env|\benv\.[A-Z][A-Z0-9_]*)/u,
      `${component} added runtime configuration; update the public reference and contract`
    );
  }
});

test("publishes defaults, conditional requirements, secret handling, and stable entry links", () => {
  assert.match(reference, /\| Name\s+\| Default\s+\| Required when\s+\| Secret\s+\|/u);
  assert.match(reference, /telemetry is off by default/iu);
  assert.match(reference, /receiver endpoint[^]*never[^]*Admin API/iu);
  assert.match(rootReadme, /docs\/reference\/configuration\.md/u);
  assert.match(adminReadme, /docs\/reference\/configuration\.md/u);
});
