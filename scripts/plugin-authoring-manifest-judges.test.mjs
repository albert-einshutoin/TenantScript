import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { evaluatePluginAuthoringManifestJudges } from "./plugin-authoring-manifest-judges.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(
  await readFile(join(repoRoot, "evals", "plugin-authoring", "corpus.json"), "utf8")
);

test("manifest and least-privilege policies accept all canonical task contracts", () => {
  for (const task of corpus.tasks) {
    assert.deepEqual(
      evaluatePluginAuthoringManifestJudges({
        task,
        manifest: manifestForTask(task),
        parseManifest: acceptingParser
      }),
      { manifest: true, "least-privilege": true }
    );
  }
});

test("manifest policy fails closed when the canonical parser rejects, throws, or widens output", () => {
  const task = corpus.tasks[0];
  const manifest = manifestForTask(task);
  const parsers = [
    () => ({ ok: false, errors: [{ message: "candidate-secret" }] }),
    () => {
      throw new Error("candidate-secret");
    },
    () => ({ ok: true }),
    () => true,
    () => ({ ok: true, value: new Proxy({}, {}) })
  ];

  for (const parseManifest of parsers) {
    const result = evaluatePluginAuthoringManifestJudges({ task, manifest, parseManifest });
    assert.deepEqual(result, { manifest: false, "least-privilege": false });
    assert.equal(JSON.stringify(result).includes("candidate-secret"), false);
  }
});

test("least-privilege rejects extra or missing hooks and hook contract drift", () => {
  const task = corpus.tasks[0];
  const canonical = manifestForTask(task);
  const cases = [
    { ...canonical, hooks: [] },
    { ...canonical, hooks: [...canonical.hooks, { ...canonical.hooks[0], name: "extra.hook" }] },
    { ...canonical, hooks: [{ ...canonical.hooks[0], name: "other.hook" }] },
    { ...canonical, hooks: [{ ...canonical.hooks[0], type: "event" }] }
  ];

  for (const manifest of cases) {
    assert.deepEqual(
      evaluatePluginAuthoringManifestJudges({ task, manifest, parseManifest: acceptingParser }),
      { manifest: true, "least-privilege": false }
    );
  }
});

test("least-privilege compares capability names as an exact set", () => {
  const task = corpus.tasks.find((entry) => entry.id === "capability-slack-alert");
  assert.ok(task);
  const canonical = manifestForTask(task);
  const cases = [
    { ...canonical, capabilities: {} },
    { ...canonical, capabilities: { ...canonical.capabilities, "github.issue.create": {} } },
    { ...canonical, capabilities: { "github.issue.create": {} } }
  ];

  for (const manifest of cases) {
    assert.equal(
      evaluatePluginAuthoringManifestJudges({
        task,
        manifest,
        parseManifest: acceptingParser
      })["least-privilege"],
      false
    );
  }
});

test("least-privilege rejects any egress mode other than the task contract", () => {
  const task = corpus.tasks[0];
  const canonical = manifestForTask(task);

  assert.deepEqual(
    evaluatePluginAuthoringManifestJudges({
      task,
      manifest: { ...canonical, egress: { mode: "allowlist", hosts: ["example.com"] } },
      parseManifest: acceptingParser
    }),
    { manifest: true, "least-privilege": false }
  );
});

test("parser mutation cannot change the caller-owned manifest or task", () => {
  const task = structuredClone(corpus.tasks[0]);
  const manifest = manifestForTask(task);
  const originalTask = structuredClone(task);
  const originalManifest = structuredClone(manifest);

  evaluatePluginAuthoringManifestJudges({
    task,
    manifest,
    parseManifest: (input) => {
      input.hooks[0].name = "mutated.hook";
      return { ok: true, value: input };
    }
  });

  assert.deepEqual(task, originalTask);
  assert.deepEqual(manifest, originalManifest);
});

function manifestForTask(task) {
  return {
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
    capabilities: Object.fromEntries(task.capabilities.map((name) => [name, {}])),
    configSchema: { properties: {}, required: [] },
    egress: { mode: task.egress.mode },
    limits: { cpuMs: 50, timeoutMs: 500 }
  };
}

function acceptingParser(input) {
  return { ok: true, value: input };
}
