import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPluginAuthoringBuildAdapter } from "./plugin-authoring-build-adapter.mjs";
import {
  PLUGIN_AUTHORING_BUILD_CONTRACT_VERSION,
  computePluginAuthoringTaskSnapshotDigest,
  verifyPluginAuthoringBuildReceipt
} from "./plugin-authoring-build-contract.mjs";

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "tenantscript-build-receipt-"));
  const baselineRoot = join(root, "baseline");
  const taskWorkspace = join(root, "work", "task-one");
  const taskRoot = join(taskWorkspace, "source");
  mkdirSync(join(taskRoot, "src"), { recursive: true });
  mkdirSync(baselineRoot);
  writeFileSync(
    join(taskRoot, "src", "manifest.ts"),
    'import type { TenantScriptManifest } from "@tenantscript/manifest";\n' +
      "export const manifest = {} satisfies TenantScriptManifest;\n"
  );
  writeFileSync(
    join(taskRoot, "src", "index.ts"),
    'import { definePlugin } from "@tenantscript/plugin-sdk";\n' +
      'import { manifest } from "./manifest.js";\n' +
      "export const plugin = definePlugin({ manifest, handlers: { event: (payload) => payload } });\n" +
      "export default plugin;\n"
  );
  writeFileSync(join(taskRoot, "package.json"), '{"scripts":{"build":"exit 99"}}\n');
  const context = {
    task: { id: "task-one" },
    baselineRoot,
    taskRoot,
    taskWorkspace
  };
  try {
    return run(context);
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}

test("writes and verifies a source-bound bundle receipt after a successful build", () => {
  withFixture((context) => {
    assert.equal(createPluginAuthoringBuildAdapter()(context), true);
    const verified = verifyPluginAuthoringBuildReceipt(context);
    assert.equal(verified.contractVersion, PLUGIN_AUTHORING_BUILD_CONTRACT_VERSION);
    assert.equal(verified.taskId, context.task.id);
    assert.equal(verified.sourceSha256, computePluginAuthoringTaskSnapshotDigest(context.taskRoot));
    assert.match(verified.bundleSha256, /^[0-9a-f]{64}$/u);
    assert.equal(verified.bundlePath, join(context.taskWorkspace, "build", "bundle.cjs"));
    assert.match(readFileSync(verified.bundlePath, "utf8"), /definePlugin/u);
    assert.equal(Object.isFrozen(verified), true);
  });
});

test("rejects stale source, changed bundle, widened receipt, and symlinked artifacts", async (t) => {
  const cases = {
    "stale source": (context) =>
      writeFileSync(join(context.taskRoot, "src", "index.ts"), "export default {};\n"),
    "changed bundle": (context) =>
      writeFileSync(join(context.taskWorkspace, "build", "bundle.cjs"), "exports.plugin = {};\n"),
    "widened receipt": (context) => {
      const path = join(context.taskWorkspace, "build", "receipt.json");
      const receipt = JSON.parse(readFileSync(path, "utf8"));
      receipt.extra = true;
      writeFileSync(path, `${JSON.stringify(receipt)}\n`);
    },
    "bundle symlink": (context) => {
      const path = join(context.taskWorkspace, "build", "bundle.cjs");
      const outside = join(context.taskWorkspace, "outside.cjs");
      writeFileSync(outside, readFileSync(path));
      rmSync(path);
      symlinkSync(outside, path);
    }
  };
  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, () => {
      withFixture((context) => {
        assert.equal(createPluginAuthoringBuildAdapter()(context), true);
        mutate(context);
        assert.throws(() => verifyPluginAuthoringBuildReceipt(context), {
          message: "plugin authoring build receipt is invalid"
        });
      });
    });
  }
});
