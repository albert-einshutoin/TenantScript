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

import { loadPluginAuthoringTaskBehaviorCases } from "./plugin-authoring-behavior-cases.mjs";
import { createPluginAuthoringBuildAdapter } from "./plugin-authoring-build-adapter.mjs";
import { parsePluginAuthoringCorpus } from "./plugin-authoring-eval.mjs";
import {
  PLUGIN_AUTHORING_UNIT_LIMITS,
  createPluginAuthoringUnitTestAdapter
} from "./plugin-authoring-unit-adapter.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const corpus = parsePluginAuthoringCorpus(
  JSON.parse(readFileSync(join(repoRoot, "evals", "plugin-authoring", "corpus.json"), "utf8"))
);
const ticketTask = corpus.tasks.find((task) => task.id === "webhook-ticket-priority");

function withFixture(run, source = ticketPrioritySource(), extraSourceFiles = {}) {
  const root = mkdtempSync(join(tmpdir(), "tenantscript-unit-adapter-"));
  const taskWorkspace = join(root, "work", ticketTask.id);
  const taskRoot = join(taskWorkspace, "source");
  const baselineRoot = join(root, "baseline");
  mkdirSync(join(taskRoot, "src"), { recursive: true });
  mkdirSync(baselineRoot);
  writeFileSync(join(taskRoot, "src", "manifest.ts"), manifestSource(ticketTask));
  writeFileSync(join(taskRoot, "src", "index.ts"), source);
  for (const [name, contents] of Object.entries(extraSourceFiles)) {
    writeFileSync(join(taskRoot, "src", name), contents);
  }
  writeFileSync(
    join(taskRoot, "package.json"),
    '{"scripts":{"pretest":"touch candidate-test-ran","test":"exit 99"}}\n'
  );
  const context = {
    task: ticketTask,
    baselineRoot,
    taskRoot,
    taskWorkspace
  };
  try {
    assert.equal(createPluginAuthoringBuildAdapter()(context), true);
    return run(context);
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}

function manifestSource(task) {
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
    capabilities: {},
    configSchema: { properties: {}, required: [] },
    egress: { mode: "deny" },
    limits: { cpuMs: 50, timeoutMs: 500 }
  })} satisfies TenantScriptManifest;
`;
}

function ticketPrioritySource(extraGuard = "") {
  return `import { definePlugin } from "@tenantscript/plugin-sdk";
import { manifest } from "./manifest.js";
const priorities: Record<string, number> = { low: 1, normal: 2, high: 3, urgent: 4 };
export const plugin = definePlugin({
  manifest,
  handlers: {
    "ticket.created": async (payload) => {
      ${extraGuard}
      const priority = typeof payload === "object" && payload !== null && !Array.isArray(payload) &&
        "priority" in payload && typeof payload.priority === "string" ? payload.priority : "normal";
      return { priority: priorities[priority] ?? 2 };
    }
  }
});
export default plugin;
`;
}

function successfulChild(authenticationKey, behaviorCase, overrides = {}) {
  const payload = {
    schemaVersion: 1,
    result: behaviorCase.expected.result,
    capabilityCalls: behaviorCase.expected.capabilityCalls,
    runtimeLogs: [],
    pendingCapabilityCalls: 0,
    ...overrides
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", authenticationKey).update(encoded).digest("hex");
  return {
    error: undefined,
    pid: 1234,
    signal: null,
    status: 0,
    stderr: "",
    stdout: `TENANTSCRIPT_BEHAVIOR_RESULT:${encoded}:${signature}\n`
  };
}

test("runs every judge-owned case through the real loader sandbox", () => {
  withFixture((context) => {
    const cases = loadPluginAuthoringTaskBehaviorCases(repoRoot, context.task);
    assert.equal(cases.length, 6);
    assert.equal(createPluginAuthoringUnitTestAdapter()(context), true);
    assert.equal(existsSync(join(context.taskRoot, "candidate-test-ran")), false);
    assert.equal(existsSync(join(context.taskWorkspace, "candidate-test-ran")), false);
  });
});

test("uses a fixed authenticated bounded process contract", () => {
  withFixture((context) => {
    const behaviorCase = loadPluginAuthoringTaskBehaviorCases(repoRoot, context.task)[0];
    const calls = [];
    const key = Buffer.alloc(32, 7);
    const adapter = createPluginAuthoringUnitTestAdapter({
      loadTaskCases: () => [behaviorCase],
      randomBytesImpl: () => key,
      spawnSyncImpl(command, args, options) {
        calls.push({ command, args, options });
        return successfulChild(key, behaviorCase);
      },
      terminateProcessGroup: () => {}
    });
    assert.equal(adapter(context), true);
    assert.equal(calls.length, 1);
    const [{ command, args, options }] = calls;
    assert.equal(command, process.execPath);
    assert.equal(isAbsolute(command), true);
    assert.equal(args[0], "--no-warnings");
    assert.match(args[1], /plugin-authoring-behavior-runner\.mjs$/u);
    assert.equal(args[2], join(context.taskWorkspace, "build", "bundle.cjs"));
    assert.equal(options.shell, false);
    assert.equal(options.timeout, PLUGIN_AUTHORING_UNIT_LIMITS.timeoutMs);
    assert.equal(options.maxBuffer, PLUGIN_AUTHORING_UNIT_LIMITS.streamOutputBytes);
    assert.equal(options.killSignal, "SIGKILL");
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal("NODE_OPTIONS" in options.env, false);
    assert.equal("GITHUB_TOKEN" in options.env, false);
    const envelope = JSON.parse(options.input);
    assert.deepEqual(Object.keys(envelope).sort(), [
      "authenticationKey",
      "behaviorCase",
      "schemaVersion"
    ]);
    assert.equal(envelope.authenticationKey, key.toString("base64url"));
    assert.deepEqual(envelope.behaviorCase, behaviorCase);
  });
});

test("fails closed for stale build evidence before spawning", () => {
  withFixture((context) => {
    writeFileSync(join(context.taskRoot, "src", "index.ts"), "export default {};\n");
    let calls = 0;
    const adapter = createPluginAuthoringUnitTestAdapter({
      spawnSyncImpl: () => {
        calls += 1;
        return { status: 0 };
      }
    });
    assert.equal(adapter(context), false);
    assert.equal(calls, 0);
  });
});

test("runs later cases after failure and accepts only authenticated closed observations", () => {
  withFixture((context) => {
    const behaviorCase = loadPluginAuthoringTaskBehaviorCases(repoRoot, context.task)[0];
    const cases = [behaviorCase, { ...structuredClone(behaviorCase), name: "second-case" }];
    const key = Buffer.alloc(32, 9);
    const failures = {
      "non-zero": () => ({ ...successfulChild(key, behaviorCase), status: 1 }),
      signal: () => ({ ...successfulChild(key, behaviorCase), signal: "SIGKILL" }),
      timeout: () => ({
        ...successfulChild(key, behaviorCase),
        error: Object.assign(new Error("timeout marker"), { code: "ETIMEDOUT" })
      }),
      "forged signature": () => ({
        ...successfulChild(key, behaviorCase),
        stdout: successfulChild(Buffer.alloc(32, 1), behaviorCase).stdout
      }),
      "extra output": () => ({
        ...successfulChild(key, behaviorCase),
        stdout: `${successfulChild(key, behaviorCase).stdout}extra\n`
      }),
      stderr: () => ({ ...successfulChild(key, behaviorCase), stderr: "candidate marker" }),
      "result mismatch": () => successfulChild(key, behaviorCase, { result: { ok: false } }),
      "call mismatch": () => successfulChild(key, behaviorCase, { capabilityCalls: [{}] }),
      "runtime log": () =>
        successfulChild(key, behaviorCase, {
          runtimeLogs: [{ reason: "egress_denied", target: "redacted" }]
        }),
      "pending capability": () => successfulChild(key, behaviorCase, { pendingCapabilityCalls: 1 })
    };
    for (const [name, createFailure] of Object.entries(failures)) {
      let calls = 0;
      const adapter = createPluginAuthoringUnitTestAdapter({
        loadTaskCases: () => cases,
        randomBytesImpl: () => key,
        spawnSyncImpl() {
          calls += 1;
          return calls === 1 ? createFailure() : successfulChild(key, cases[1]);
        },
        terminateProcessGroup: () => {}
      });
      assert.equal(adapter(context), false, name);
      assert.equal(calls, 2, name);
    }
  });
});

test("rejects candidate attempts to probe process or ambient fetch", () => {
  const guard = `
const ambient = globalThis as unknown as {
  process?: unknown;
  fetch?: (url: string) => Promise<unknown>;
};
if (ambient.process !== undefined) return { priority: 99 };
if (ambient.fetch !== undefined) {
  try { await ambient.fetch("https://example.com/"); return { priority: 99 }; } catch {}
}
`;
  withFixture((context) => {
    const behaviorCase = loadPluginAuthoringTaskBehaviorCases(repoRoot, context.task).find(
      (entry) => entry.name === "maps-normal"
    );
    const adapter = createPluginAuthoringUnitTestAdapter({ loadTaskCases: () => [behaviorCase] });
    assert.equal(adapter(context), false);
  }, ticketPrioritySource(guard));
});

test("binds dispatch before candidate side effects and hides the judge-only binder", () => {
  const source = `import "./poison.js";
import * as sdk from "@tenantscript/plugin-sdk";
import { manifest } from "./manifest.js";
const alternateManifest = {
  ...manifest,
  hooks: [{ name: "ticket.created", type: "event" }],
  capabilities: { "slack.send": {} },
  egress: { mode: "allow", hosts: ["example.com"] }
};
const priorities: Record<string, number> = { low: 1, normal: 2, high: 3, urgent: 4 };
export const plugin = sdk.definePlugin({
  manifest: alternateManifest,
  handlers: {
    "ticket.created": async (payload) => {
      if ("bindReviewedPlugin" in sdk) return { priority: 99 };
      const priority = typeof payload === "object" && payload !== null && !Array.isArray(payload) &&
        "priority" in payload && typeof payload.priority === "string" ? payload.priority : "normal";
      return { priority: priorities[priority] ?? 2 };
    }
  }
});
export default plugin;
`;
  withFixture(
    (context) => {
      assert.equal(createPluginAuthoringUnitTestAdapter()(context), true);
    },
    source,
    {
      "poison.ts": `const prototype = WeakMap.prototype as unknown as { get: (...args: unknown[]) => unknown };
prototype.get = () => () => ({
  manifest: {},
  dispatch: async () => ({ ok: true, value: { priority: 99 } })
});
export {};
`
    }
  );
});
