import assert from "node:assert/strict";
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
import { isAbsolute, join } from "node:path";
import test from "node:test";

import {
  PLUGIN_AUTHORING_BUILD_LIMITS,
  createPluginAuthoringBuildAdapter
} from "./plugin-authoring-build-adapter.mjs";

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "tenantscript-build-adapter-"));
  const baselineRoot = join(root, "baseline");
  const taskWorkspace = join(root, "work", "task-one");
  const taskRoot = join(taskWorkspace, "source");
  mkdirSync(join(taskRoot, "src"), { recursive: true });
  mkdirSync(baselineRoot);
  writeFileSync(
    join(taskRoot, "src", "index.ts"),
    'import { definePlugin } from "@tenantscript/plugin-sdk";\n' +
      'import { manifest } from "./manifest.js";\n' +
      "export const plugin = definePlugin({ manifest, handlers: { event: (payload) => payload } });\n"
  );
  writeFileSync(
    join(taskRoot, "src", "manifest.ts"),
    'import type { TenantScriptManifest } from "@tenantscript/manifest";\n' +
      "export const manifest = {} satisfies TenantScriptManifest;\n"
  );
  writeFileSync(
    join(taskRoot, "package.json"),
    `${JSON.stringify({ scripts: { prebuild: "touch should-not-exist", build: "exit 99" } })}\n`
  );

  try {
    return run({
      task: { id: "task-one" },
      baselineRoot,
      taskRoot,
      taskWorkspace
    });
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}

function successfulChild(overrides = {}) {
  return {
    error: undefined,
    pid: 1234,
    signal: null,
    status: 0,
    stderr: "",
    stdout: '{"ok":true}\n',
    ...overrides
  };
}

test("uses one fixed worker with a bounded shell-free and sanitized process contract", () => {
  withFixture((context) => {
    const calls = [];
    const adapter = createPluginAuthoringBuildAdapter({
      spawnSyncImpl(command, args, options) {
        calls.push({ command, args, options });
        return successfulChild();
      },
      terminateProcessGroup: () => {}
    });

    assert.equal(adapter(context), true);
    assert.equal(calls.length, 1);
    const [{ command, args, options }] = calls;
    assert.equal(command, process.execPath);
    assert.equal(isAbsolute(command), true);
    assert.equal(args.length, 2);
    assert.match(args[0], /plugin-authoring-build-worker\.mjs$/u);
    assert.match(args[1], /\/build\/request\.json$/u);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, PLUGIN_AUTHORING_BUILD_LIMITS.timeoutMs);
    assert.equal(options.maxBuffer, PLUGIN_AUTHORING_BUILD_LIMITS.streamOutputBytes);
    assert.equal(options.killSignal, "SIGKILL");
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.deepEqual(Object.keys(options.env).sort(), [
      "HOME",
      "LANG",
      "LC_ALL",
      "NODE_ENV",
      "NO_COLOR",
      "PATH",
      "TMPDIR",
      "TZ"
    ]);
    assert.equal(options.env.PATH, "/usr/local/bin:/usr/bin:/bin");
    assert.equal("NODE_OPTIONS" in options.env, false);
    assert.equal("GITHUB_TOKEN" in options.env, false);

    const request = JSON.parse(readFileSync(args[1], "utf8"));
    assert.deepEqual(Object.keys(request).sort(), ["buildRoot", "schemaVersion", "taskRoot"]);
    assert.equal(request.schemaVersion, 1);
    assert.equal(request.taskRoot, context.taskRoot);
    assert.equal(request.buildRoot, join(context.taskWorkspace, "build"));
  });
});

test("accepts only the exact closed success output", async (t) => {
  const failures = [
    successfulChild({ status: 1 }),
    successfulChild({ signal: "SIGKILL" }),
    successfulChild({ error: Object.assign(new Error("timeout marker"), { code: "ETIMEDOUT" }) }),
    successfulChild({ stdout: '{"ok":false}\n' }),
    successfulChild({ stdout: '{"ok":true}\nextra\n' }),
    successfulChild({ stderr: "candidate diagnostic" }),
    successfulChild({ status: null })
  ];
  for (const [index, child] of failures.entries()) {
    await t.test(String(index), () => {
      withFixture((context) => {
        const adapter = createPluginAuthoringBuildAdapter({
          spawnSyncImpl: () => child,
          terminateProcessGroup: () => {}
        });
        assert.equal(adapter(context), false);
      });
    });
  }
});

test("fails closed before spawning when the task workspace relationship is invalid", () => {
  withFixture((context) => {
    let calls = 0;
    const adapter = createPluginAuthoringBuildAdapter({
      spawnSyncImpl: () => {
        calls += 1;
        return successfulChild();
      },
      terminateProcessGroup: () => {}
    });
    assert.equal(adapter({ ...context, taskRoot: join(context.taskWorkspace, "other") }), false);
    assert.equal(calls, 0);
  });
});

test("compile-checks safe TypeScript without executing package lifecycle scripts", () => {
  withFixture((context) => {
    const adapter = createPluginAuthoringBuildAdapter();
    assert.equal(adapter(context), true);
    assert.equal(
      readFileSync(join(context.taskRoot, "package.json"), "utf8").includes("prebuild"),
      true
    );
    assert.equal(existsSync(join(context.taskWorkspace, "should-not-exist")), false);
    assert.equal(existsSync(join(context.taskWorkspace, "build", "should-not-exist")), false);
    assert.equal(existsSync(join(context.taskRoot, "should-not-exist")), false);
  });
});

test("rejects type failures and unapproved package imports", async (t) => {
  const cases = {
    "type error": 'export const value: number = "wrong";\n',
    "unapproved dependency": 'import value from "left-pad";\nexport default value;\n',
    "deep TenantScript import":
      'import value from "@tenantscript/plugin-sdk/internal";\nexport default value;\n',
    "absolute import": 'import value from "/baseline/private.ts";\nexport default value;\n',
    "compiler suppression": '// @ts-ignore\nexport const value: number = "wrong";\n',
    "dynamic dependency": 'export const value = import("left-pad");\n',
    "relative escape": 'import value from "../outside.js";\nexport default value;\n',
    "reference directive": '/// <reference path="../outside.d.ts" />\nexport const value = 1;\n',
    "ambient SDK augmentation":
      'import "@tenantscript/plugin-sdk";\n' +
      'declare module "@tenantscript/plugin-sdk" { export function definePlugin(input: any): any; }\n' +
      "export const value = 1;\n",
    "ambient global": "declare global { interface Object { injected: true } }\nexport {};\n",
    "ambient script": "interface Object { injected: true }\n"
  };
  for (const [name, source] of Object.entries(cases)) {
    await t.test(name, () => {
      withFixture((context) => {
        writeFileSync(join(context.taskRoot, "src", "index.ts"), source);
        assert.equal(createPluginAuthoringBuildAdapter()(context), false);
      });
    });
  }
});

test("rejects declaration, non-TypeScript, and invalid UTF-8 files inside source", async (t) => {
  const cases = {
    declaration: ["extra.d.ts", "export declare const injected: unknown;\n"],
    JavaScript: ["extra.js", "export const injected = true;\n"],
    "invalid UTF-8": ["extra.ts", Buffer.from([0xc3, 0x28])]
  };
  for (const [name, [filename, contents]] of Object.entries(cases)) {
    await t.test(name, () => {
      withFixture((context) => {
        writeFileSync(join(context.taskRoot, "src", filename), contents);
        assert.equal(createPluginAuthoringBuildAdapter()(context), false);
      });
    });
  }
});

test("ignores candidate tsconfig and environment injection", () => {
  withFixture((context) => {
    writeFileSync(
      join(context.taskRoot, "tsconfig.json"),
      `${JSON.stringify({ extends: "/tmp/attacker", compilerOptions: { plugins: [{}] } })}\n`
    );
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--require=/tmp/attacker.cjs";
    try {
      assert.equal(createPluginAuthoringBuildAdapter()(context), true);
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }
  });
});

test("terminates the returned process group without exposing child diagnostics", () => {
  withFixture((context) => {
    const terminated = [];
    const marker = ["API", "_TOKEN", "=worker-marker"].join("");
    const adapter = createPluginAuthoringBuildAdapter({
      spawnSyncImpl: () => successfulChild({ status: 1, stderr: marker }),
      terminateProcessGroup: (pid) => terminated.push(pid),
      detached: true
    });
    assert.equal(adapter(context), false);
    assert.deepEqual(terminated, [1234]);
  });
});
