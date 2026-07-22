import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  PLUGIN_AUTHORING_AUDIT_SDK_VERSION,
  createPluginAuthoringAuditAdapter
} from "./plugin-authoring-audit-adapter.mjs";
import { createPluginAuthoringBuildAdapter } from "./plugin-authoring-build-adapter.mjs";
import { parsePluginAuthoringCorpus } from "./plugin-authoring-eval.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const corpus = parsePluginAuthoringCorpus(
  JSON.parse(readFileSync(join(repoRoot, "evals", "plugin-authoring", "corpus.json"), "utf8"))
);
const task = corpus.tasks.find((entry) => entry.id === "webhook-ticket-priority");

function withFixture(
  run,
  { packageJson = validPackageJson(), manifest = manifestSource(), source = pluginSource() } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "tenantscript-audit-adapter-"));
  const taskWorkspace = join(root, "work", task.id);
  const taskRoot = join(taskWorkspace, "source");
  const baselineRoot = join(root, "baseline");
  mkdirSync(join(taskRoot, "src"), { recursive: true });
  mkdirSync(baselineRoot);
  writeFileSync(join(taskRoot, "src", "manifest.ts"), manifest);
  writeFileSync(join(taskRoot, "src", "index.ts"), source);
  writeFileSync(join(taskRoot, "package.json"), packageJson);
  const context = { task, baselineRoot, taskRoot, taskWorkspace };
  try {
    assert.equal(createPluginAuthoringBuildAdapter()(context), true);
    return run(context);
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}

function validPackageJson() {
  return `${JSON.stringify({
    name: "candidate-metadata-must-not-reach-audit",
    scripts: { pretest: "touch candidate-script-ran", test: "node --test" },
    devDependencies: { "@tenantscript/plugin-sdk": "0.0.0" }
  })}\n`;
}

function manifestSource({ capabilities = {}, limits = { cpuMs: 50, timeoutMs: 500 } } = {}) {
  return `import type { TenantScriptManifest } from "@tenantscript/manifest";
export const manifest = ${JSON.stringify({
    name: task.id,
    version: "0.1.0",
    hooks: [
      {
        name: task.hook.name,
        type: task.hook.type,
        timeoutMs: 250,
        schemaVersionRange: "^1.0.0"
      }
    ],
    capabilities,
    configSchema: { properties: {}, required: [] },
    egress: { mode: "deny" },
    limits
  })} satisfies TenantScriptManifest;\n`;
}

function pluginSource(handlerBody = "return { priority: 2 };") {
  return `import { definePlugin } from "@tenantscript/plugin-sdk";
import { manifest } from "./manifest.js";
export default definePlugin({ manifest, handlers: {
  "ticket.created": async (_payload, context) => { ${handlerBody} }
} });\n`;
}

function passingReport() {
  return { version: 1, passed: true, findings: [] };
}

test("pins the judge-owned SDK version to the reviewed plugin SDK package", () => {
  const sdkPackage = JSON.parse(
    readFileSync(join(repoRoot, "packages", "plugin-sdk", "package.json"), "utf8")
  );
  assert.equal(PLUGIN_AUTHORING_AUDIT_SDK_VERSION, sdkPackage.version);
});

test("audits only receipt-bound static inputs and never runs candidate package scripts", () => {
  withFixture((context) => {
    const calls = [];
    const adapter = createPluginAuthoringAuditAdapter({
      auditPluginPackage(request) {
        calls.push(request);
        return passingReport();
      }
    });
    assert.equal(adapter(context), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].manifest.name, task.id);
    assert.equal(calls[0].packageJson.scripts.test, "node --test");
    assert.equal(calls[0].expectedSdkVersion, "0.0.0");
    assert.match(calls[0].bundleCode, /ticket\.created/u);
    assert.equal("pretest" in calls[0].packageJson.scripts, true);
    assert.deepEqual(Object.keys(calls[0].packageJson).sort(), ["devDependencies", "scripts"]);
    assert.equal(readFileSync(join(context.taskRoot, "package.json"), "utf8"), validPackageJson());
    assert.throws(() => readFileSync(join(context.taskRoot, "candidate-script-ran")));
    assert.equal(createPluginAuthoringAuditAdapter()(context), true);
  });
});

test("fails closed for every finding, invalid report, audit exception, and stale receipt", () => {
  withFixture((context) => {
    const reports = [
      {
        version: 1,
        passed: true,
        findings: [
          {
            code: "bundle_direct_egress_detected",
            severity: "warning",
            certainty: "heuristic",
            path: "bundle.egressCalls.*",
            message: "bundle contains a direct fetch call that requires egress bypass review"
          }
        ]
      },
      { version: 1, passed: true, findings: [], extra: true },
      { version: 2, passed: true, findings: [] },
      { version: 1, passed: false, findings: [] },
      {
        version: 1,
        passed: false,
        findings: [
          {
            code: "bundle_direct_egress_detected",
            severity: "warning",
            certainty: "heuristic",
            path: "bundle.egressCalls.*",
            message: "bundle contains a direct fetch call that requires egress bypass review"
          },
          {
            code: "plugin_sdk_missing",
            severity: "error",
            certainty: "exact",
            path: "package.dependencies.@tenantscript/plugin-sdk",
            message: "plugin SDK dependency is required"
          }
        ]
      },
      {
        version: 1,
        passed: false,
        findings: [
          {
            code: "manifest_invalid",
            severity: "error",
            certainty: "exact",
            path: "manifest.candidate-secret-marker",
            message: "manifest does not satisfy the closed TenantScript schema"
          }
        ]
      },
      {
        version: 1,
        passed: false,
        findings: [
          {
            code: "future_rule",
            severity: "error",
            certainty: "exact",
            path: "package",
            message: "unknown"
          }
        ]
      }
    ];
    for (const report of reports) {
      assert.equal(
        createPluginAuthoringAuditAdapter({ auditPluginPackage: () => report })(context),
        false
      );
    }
    assert.equal(
      createPluginAuthoringAuditAdapter({
        auditPluginPackage: () => {
          throw new Error("candidate marker");
        }
      })(context),
      false
    );
    writeFileSync(join(context.taskRoot, "src", "index.ts"), "export default {};\n");
    let calls = 0;
    assert.equal(
      createPluginAuthoringAuditAdapter({
        auditPluginPackage: () => {
          calls += 1;
          return passingReport();
        }
      })(context),
      false
    );
    assert.equal(calls, 0);
  });
});

test("rejects oversized, prototype-sensitive, and structurally unbounded package metadata", () => {
  const invalidPackages = [
    `${" ".repeat(32 * 1024)}{}\n`,
    '{"__proto__":{"polluted":true}}\n',
    `${JSON.stringify({ scripts: { test: "node --test" }, nested: makeNested(9) })}\n`,
    `${JSON.stringify({ scripts: { test: "x".repeat(2_000) } })}\n`
  ];
  for (const packageJson of invalidPackages) {
    withFixture(
      (context) => {
        let calls = 0;
        const adapter = createPluginAuthoringAuditAdapter({
          auditPluginPackage: () => {
            calls += 1;
            return passingReport();
          }
        });
        assert.equal(adapter(context), false);
        assert.equal(calls, 0);
      },
      { packageJson }
    );
  }
});

test("rejects changed, symlinked, and hard-linked package metadata before canonical audit", () => {
  const mutations = [
    (packagePath) => writeFileSync(packagePath, "{\n"),
    (packagePath) => writeFileSync(packagePath, Buffer.from([0xff])),
    (packagePath, externalPath) => {
      unlinkSync(packagePath);
      symlinkSync(externalPath, packagePath);
    },
    (packagePath, externalPath) => {
      unlinkSync(packagePath);
      linkSync(externalPath, packagePath);
    }
  ];
  for (const mutate of mutations) {
    withFixture((context) => {
      const packagePath = join(context.taskRoot, "package.json");
      const externalPath = join(context.taskWorkspace, "external-package.json");
      writeFileSync(externalPath, validPackageJson());
      mutate(packagePath, externalPath);
      let calls = 0;
      assert.equal(
        createPluginAuthoringAuditAdapter({
          auditPluginPackage: () => {
            calls += 1;
            return passingReport();
          }
        })(context),
        false
      );
      assert.equal(calls, 0);
    });
  }
});

test("fails canonical package and runtime audit fixtures closed", () => {
  const invalidPackages = [
    { scripts: { test: "node --test" } },
    {
      scripts: { test: "node --test" },
      dependencies: { "@tenantscript/plugin-sdk": "0.0.0" },
      devDependencies: { "@tenantscript/plugin-sdk": "0.0.0" }
    },
    {
      scripts: { test: "node --test" },
      devDependencies: { "@tenantscript/plugin-sdk": "^0.0.0" }
    },
    {
      scripts: { test: "node --test" },
      devDependencies: { "@tenantscript/plugin-sdk": "0.0.1" }
    },
    { scripts: {}, devDependencies: { "@tenantscript/plugin-sdk": "0.0.0" } }
  ];
  for (const packageJson of invalidPackages) {
    withFixture((context) => assert.equal(createPluginAuthoringAuditAdapter()(context), false), {
      packageJson: `${JSON.stringify(packageJson)}\n`
    });
  }
  for (const limits of [
    { cpuMs: 51, timeoutMs: 500 },
    { cpuMs: 50, timeoutMs: 501 }
  ]) {
    withFixture((context) => assert.equal(createPluginAuthoringAuditAdapter()(context), false), {
      manifest: manifestSource({ limits })
    });
  }
});

test("fails canonical bundle capability and egress audit fixtures closed", () => {
  const fixtures = [
    {
      source: pluginSource('await context.capability("slack.send", {}); return { priority: 2 };')
    },
    {
      source: pluginSource(
        'const name: string = "slack.send"; await context.capability(name, {}); return { priority: 2 };'
      )
    },
    {
      source: pluginSource(
        'await (globalThis as unknown as { fetch: (url: string) => Promise<unknown> }).fetch("https://example.invalid"); return { priority: 2 };'
      )
    },
    {
      manifest: manifestSource({ capabilities: { "slack.send": {} } })
    }
  ];
  for (const fixture of fixtures) {
    withFixture(
      (context) => assert.equal(createPluginAuthoringAuditAdapter()(context), false),
      fixture
    );
  }
});

function makeNested(depth) {
  return depth === 0 ? true : { child: makeNested(depth - 1) };
}
