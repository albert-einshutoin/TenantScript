import assert from "node:assert/strict";
import test from "node:test";

import {
  MANIFEST_SOURCE_MAX_BYTES,
  evaluatePluginAuthoringManifestSourceJudges,
  extractPluginAuthoringManifest
} from "./plugin-authoring-manifest-extractor.mjs";

const scaffoldSource = `import type { TenantScriptManifest } from "@tenantscript/manifest";

export const manifest = {
  name: "approval-invoice-threshold",
  version: "0.1.0",
  hooks: [{ name: "invoice.approve", type: "policy", timeoutMs: 250, schemaVersionRange: "^1.0.0" }],
  capabilities: { "invoice.read": { tenantBound: true, retries: 0, note: null } },
  configSchema: { properties: {}, required: [] },
  egress: { mode: "deny" },
  limits: { cpuMs: 50, timeoutMs: 500, ratio: -1.5 }
} satisfies TenantScriptManifest;
`;

test("extracts the scaffold manifest as JSON-compatible data without executing it", () => {
  delete globalThis.__tenantScriptManifestExecuted;
  const result = extractPluginAuthoringManifest(scaffoldSource);

  assert.equal(result.ok, true);
  assert.deepEqual(structuredClone(result.value), {
    name: "approval-invoice-threshold",
    version: "0.1.0",
    hooks: [
      {
        name: "invoice.approve",
        type: "policy",
        timeoutMs: 250,
        schemaVersionRange: "^1.0.0"
      }
    ],
    capabilities: { "invoice.read": { tenantBound: true, retries: 0, note: null } },
    configSchema: { properties: {}, required: [] },
    egress: { mode: "deny" },
    limits: { cpuMs: 50, timeoutMs: 500, ratio: -1.5 }
  });
  assert.equal(globalThis.__tenantScriptManifestExecuted, undefined);
});

test("rejects executable and reference-based initializers without side effects", () => {
  delete globalThis.__tenantScriptManifestExecuted;
  const initializers = [
    `(() => { globalThis.__tenantScriptManifestExecuted = true; return {}; })()`,
    `sharedManifest`,
    `new Proxy({}, {})`,
    "{ ...sharedManifest }",
    "{ get name() { return 'secret'; } }",
    "{ [sharedManifest]: true }",
    "{ name }",
    "{ value: `template` }"
  ];

  for (const initializer of initializers) {
    const source = `import type { TenantScriptManifest } from "@tenantscript/manifest";
export const manifest = ${initializer} satisfies TenantScriptManifest;`;
    assert.deepEqual(extractPluginAuthoringManifest(source), { ok: false });
  }
  assert.equal(globalThis.__tenantScriptManifestExecuted, undefined);
});

test("rejects ambiguous, prototype-sensitive, and non-finite data", () => {
  for (const initializer of [
    "{ name: 'first', name: 'second' }",
    "{ '__proto__': {} }",
    "{ prototype: {} }",
    "{ constructor: {} }",
    "{ value: Infinity }",
    "{ value: NaN }",
    "{ value: 1n }"
  ]) {
    const source = `import type { TenantScriptManifest } from "@tenantscript/manifest";
export const manifest = ${initializer} satisfies TenantScriptManifest;`;
    assert.deepEqual(extractPluginAuthoringManifest(source), { ok: false });
  }
});

test("requires the exact scaffold top-level declaration contract", () => {
  const invalidSources = [
    scaffoldSource.replace("import type", "import"),
    scaffoldSource.replace("@tenantscript/manifest", "malicious-package"),
    scaffoldSource.replace("satisfies TenantScriptManifest;", "satisfies OtherManifest;"),
    scaffoldSource.replace("export const manifest", "export let manifest"),
    `${scaffoldSource}\nsideEffect();`,
    `${scaffoldSource}\nexport const manifest = {} satisfies TenantScriptManifest;`,
    "export const manifest = {} satisfies TenantScriptManifest;",
    "import type { TenantScriptManifest } from '@tenantscript/manifest'; export const manifest = {"
  ];

  for (const source of invalidSources) {
    assert.deepEqual(extractPluginAuthoringManifest(source), { ok: false });
  }
});

test("enforces source, node, and nesting bounds", () => {
  assert.deepEqual(extractPluginAuthoringManifest(" ".repeat(MANIFEST_SOURCE_MAX_BYTES + 1)), {
    ok: false
  });

  const tooManyNodes = `import type { TenantScriptManifest } from "@tenantscript/manifest";
export const manifest = [${Array.from({ length: 2_100 }, () => "null").join(",")}] satisfies TenantScriptManifest;`;
  assert.deepEqual(extractPluginAuthoringManifest(tooManyNodes), { ok: false });

  const tooDeep = `import type { TenantScriptManifest } from "@tenantscript/manifest";
export const manifest = ${"[".repeat(40)}null${"]".repeat(40)} satisfies TenantScriptManifest;`;
  assert.deepEqual(extractPluginAuthoringManifest(tooDeep), { ok: false });
});

test("returns one fixed failure shape without reflecting candidate source", () => {
  const marker = ["API", "_TOKEN", "=fixture-marker"].join("");
  const result = extractPluginAuthoringManifest(`${marker}\nsideEffect()`);

  assert.deepEqual(result, { ok: false });
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.deepEqual(extractPluginAuthoringManifest(null), { ok: false });
});

test("feeds extracted data into the manifest policies and closes extraction failure", () => {
  const task = {
    hook: { name: "invoice.approve", type: "policy" },
    capabilities: ["invoice.read"],
    egress: { mode: "deny" }
  };
  const parseManifest = (value) => ({ ok: true, value });

  assert.deepEqual(
    evaluatePluginAuthoringManifestSourceJudges({ task, source: scaffoldSource, parseManifest }),
    { manifest: true, "least-privilege": true }
  );
  assert.deepEqual(
    evaluatePluginAuthoringManifestSourceJudges({
      task,
      source: `${scaffoldSource}\nsideEffect();`,
      parseManifest
    }),
    { manifest: false, "least-privilege": false }
  );
});
