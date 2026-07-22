import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";

import { createPluginAuthoringBuildAdapter } from "./plugin-authoring-build-adapter.mjs";
import { parsePluginAuthoringCorpus } from "./plugin-authoring-eval.mjs";
import { loadPluginAuthoringTaskSecurityCases } from "./plugin-authoring-security-cases.mjs";
import {
  PLUGIN_AUTHORING_SECURITY_LIMITS,
  createPluginAuthoringSecurityTestAdapter
} from "./plugin-authoring-security-adapter.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const corpus = parsePluginAuthoringCorpus(
  JSON.parse(readFileSync(join(repoRoot, "evals", "plugin-authoring", "corpus.json"), "utf8"))
);
const task = corpus.tasks.find((candidate) => candidate.id === "webhook-ticket-priority");

function withFixture(run, source = pluginSource()) {
  const root = mkdtempSync(join(tmpdir(), "tenantscript-security-adapter-"));
  const taskWorkspace = join(root, "work", task.id);
  const taskRoot = join(taskWorkspace, "source");
  const baselineRoot = join(root, "baseline");
  mkdirSync(join(taskRoot, "src"), { recursive: true });
  mkdirSync(baselineRoot);
  writeFileSync(join(taskRoot, "src", "manifest.ts"), manifestSource());
  writeFileSync(join(taskRoot, "src", "index.ts"), source);
  writeFileSync(
    join(taskRoot, "package.json"),
    '{"scripts":{"test":"touch candidate-test-ran"}}\n'
  );
  const context = { task, baselineRoot, taskRoot, taskWorkspace };
  try {
    assert.equal(createPluginAuthoringBuildAdapter()(context), true);
    return run(context);
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}

function manifestSource() {
  return `import type { TenantScriptManifest } from "@tenantscript/manifest";
export const manifest = ${JSON.stringify({
    name: task.id,
    version: "0.1.0",
    hooks: [
      { name: task.hook.name, type: task.hook.type, timeoutMs: 250, schemaVersionRange: "^1.0.0" }
    ],
    capabilities: {},
    configSchema: { properties: {}, required: [] },
    egress: { mode: "deny" },
    limits: { cpuMs: 50, timeoutMs: 500 }
  })} satisfies TenantScriptManifest;
`;
}

function pluginSource() {
  return `import { definePlugin } from "@tenantscript/plugin-sdk";
import { manifest } from "./manifest.js";
export const plugin = definePlugin({ manifest, handlers: {
  "ticket.created": async (payload) => ({ priority: payload && typeof payload === "object" && "priority" in payload ? 1 : 2 })
} });
export default plugin;
`;
}

function authenticatedChild(key, overrides = {}) {
  const observation = {
    schemaVersion: 1,
    boundaryProbesPassed: true,
    capabilityCalls: [],
    runtimeLogs: [],
    pendingCapabilityCalls: 0,
    canaryVisible: false,
    ...overrides
  };
  const encoded = Buffer.from(JSON.stringify(observation)).toString("base64url");
  const signature = createHmac("sha256", key).update(encoded).digest("hex");
  return {
    error: undefined,
    pid: 1234,
    signal: null,
    status: 0,
    stderr: "",
    stdout: `TENANTSCRIPT_SECURITY_RESULT:${encoded}:${signature}\n`
  };
}

test("runs judge-owned boundary probes and candidate cases without candidate scripts", () => {
  withFixture((context) => {
    assert.equal(createPluginAuthoringSecurityTestAdapter()(context), true);
    assert.equal(existsSync(join(context.taskRoot, "candidate-test-ran")), false);
    assert.equal(existsSync(join(context.taskWorkspace, "candidate-test-ran")), false);
  });
});

test("rejects a candidate raw fetch attempt through the real loader audit log", () => {
  withFixture(
    (context) => {
      assert.equal(createPluginAuthoringSecurityTestAdapter()(context), false);
    },
    `import { definePlugin } from "@tenantscript/plugin-sdk";
import { manifest } from "./manifest.js";
export const plugin = definePlugin({ manifest, handlers: {
  "ticket.created": async () => {
    const ambient = globalThis as unknown as { fetch?: (url: string) => Promise<unknown> };
    try { await ambient.fetch?.("https://security-probe.invalid/leak"); } catch {}
    return { priority: 1 };
  }
} });
export default plugin;
`
  );
});

test("uses a fixed authenticated bounded process contract and sanitized canaries", () => {
  withFixture((context) => {
    const securityCase = loadPluginAuthoringTaskSecurityCases(repoRoot, task)[0];
    const key = Buffer.alloc(32, 3);
    const calls = [];
    const adapter = createPluginAuthoringSecurityTestAdapter({
      loadTaskCases: () => [securityCase],
      randomBytesImpl: (size) => (size === 32 ? key : Buffer.alloc(size, 4)),
      spawnSyncImpl(command, args, options) {
        calls.push({ command, args, options });
        return authenticatedChild(key);
      },
      terminateProcessGroup: () => {}
    });
    assert.equal(adapter(context), true);
    assert.equal(calls.length, 1);
    const [{ command, args, options }] = calls;
    assert.equal(command, process.execPath);
    assert.equal(isAbsolute(args[1]), true);
    assert.match(args[1], /plugin-authoring-security-runner\.mjs$/u);
    assert.equal(args[2], join(context.taskWorkspace, "build", "bundle.cjs"));
    assert.equal(options.timeout, PLUGIN_AUTHORING_SECURITY_LIMITS.timeoutMs);
    assert.equal(options.maxBuffer, PLUGIN_AUTHORING_SECURITY_LIMITS.streamOutputBytes);
    assert.equal(options.shell, false);
    assert.equal("GITHUB_TOKEN" in options.env, false);
    assert.match(options.env.TENANTSCRIPT_SECURITY_CANARY, /^[0-9a-f]{64}$/u);
    assert.equal(isAbsolute(options.env.TENANTSCRIPT_SECURITY_ESCAPE_PATH), true);
    const envelope = JSON.parse(options.input);
    assert.equal(envelope.authenticationKey, key.toString("base64url"));
    assert.deepEqual(envelope.securityCase, securityCase);
    assert.deepEqual(envelope.allowedCapabilities, task.capabilities);
  });
});

test("fails before spawning for stale build evidence", () => {
  withFixture((context) => {
    writeFileSync(join(context.taskRoot, "src", "index.ts"), "export default {};\n");
    let calls = 0;
    const adapter = createPluginAuthoringSecurityTestAdapter({
      spawnSyncImpl: () => {
        calls += 1;
        return { status: 0 };
      }
    });
    assert.equal(adapter(context), false);
    assert.equal(calls, 0);
  });
});

test("continues after failures and rejects forged or unsafe observations", () => {
  withFixture((context) => {
    const securityCase = loadPluginAuthoringTaskSecurityCases(repoRoot, task)[0];
    const cases = [securityCase, { ...structuredClone(securityCase), name: "second-case" }];
    const key = Buffer.alloc(32, 5);
    const failures = {
      "boundary probe": () => authenticatedChild(key, { boundaryProbesPassed: false }),
      "secret canary": () => authenticatedChild(key, { canaryVisible: true }),
      "raw egress": () =>
        authenticatedChild(key, { runtimeLogs: [{ reason: "egress_denied", target: "redacted" }] }),
      "undeclared capability": () =>
        authenticatedChild(key, { capabilityCalls: [{ name: "slack.send", input: {} }] }),
      "pending capability": () => authenticatedChild(key, { pendingCapabilityCalls: 1 }),
      "forged signature": () => ({
        ...authenticatedChild(key),
        stdout: authenticatedChild(Buffer.alloc(32, 8)).stdout
      }),
      "extra output": () => ({
        ...authenticatedChild(key),
        stdout: `${authenticatedChild(key).stdout}extra\n`
      }),
      "non-zero": () => ({ ...authenticatedChild(key), status: 1 }),
      signal: () => ({ ...authenticatedChild(key), signal: "SIGKILL" }),
      stderr: () => ({ ...authenticatedChild(key), stderr: "candidate marker" }),
      timeout: () => ({
        ...authenticatedChild(key),
        error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })
      }),
      "escape marker": (options) => {
        writeFileSync(options.env.TENANTSCRIPT_SECURITY_ESCAPE_PATH, "escaped");
        return authenticatedChild(key);
      }
    };
    for (const [name, failure] of Object.entries(failures)) {
      let calls = 0;
      let markerCounter = 0;
      const adapter = createPluginAuthoringSecurityTestAdapter({
        loadTaskCases: () => cases,
        randomBytesImpl: (size) => (size === 16 ? Buffer.alloc(16, (markerCounter += 1)) : key),
        spawnSyncImpl(_command, _args, options) {
          calls += 1;
          return calls === 1 ? failure(options) : authenticatedChild(key);
        },
        terminateProcessGroup: () => {}
      });
      assert.equal(adapter(context), false, name);
      assert.equal(calls, 2, name);
      rmSync(join(context.taskWorkspace, "security"), { recursive: true, force: true });
    }
  });
});

test("rejects an allowlisted capability call whose input differs from the security plan", () => {
  withFixture((context) => {
    const baseCase = loadPluginAuthoringTaskSecurityCases(repoRoot, task)[0];
    const securityCase = {
      ...structuredClone(baseCase),
      capabilityPlan: [
        {
          name: "slack.send",
          input: { channel: "approved", message: "bounded" },
          outcome: { status: "resolve", value: { messageId: "msg-1" } }
        }
      ]
    };
    const key = Buffer.alloc(32, 7);
    const adapter = createPluginAuthoringSecurityTestAdapter({
      loadTaskCases: () => [securityCase],
      randomBytesImpl: (size) => (size === 16 ? Buffer.alloc(16, 8) : key),
      spawnSyncImpl: () =>
        authenticatedChild(key, {
          capabilityCalls: [
            { name: "slack.send", input: { channel: "attacker", message: "unplanned" } }
          ]
        }),
      terminateProcessGroup: () => {}
    });
    assert.equal(
      adapter({
        ...context,
        task: { ...context.task, capabilities: ["slack.send"] }
      }),
      false
    );
  });
});
