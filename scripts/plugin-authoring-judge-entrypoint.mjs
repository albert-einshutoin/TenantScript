#!/usr/bin/env node

import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import {
  PLUGIN_AUTHORING_JUDGE_ARGV,
  PLUGIN_AUTHORING_JUDGE_PATHS
} from "./plugin-authoring-judge-contract.mjs";
import { createPluginAuthoringAuditAdapter } from "./plugin-authoring-audit-adapter.mjs";
import { createPluginAuthoringBuildAdapter } from "./plugin-authoring-build-adapter.mjs";
import { createPluginAuthoringSecurityTestAdapter } from "./plugin-authoring-security-adapter.mjs";
import { createPluginAuthoringUnitTestAdapter } from "./plugin-authoring-unit-adapter.mjs";
import { runPluginAuthoringJudgeCore } from "./plugin-authoring-judge-core.mjs";
import { parsePluginAuthoringCorpus } from "./plugin-authoring-eval.mjs";
import {
  inspectIsolatedCandidateBundle,
  parseIsolatedRunnerRequest
} from "./plugin-authoring-isolated-runner.mjs";
import {
  MANIFEST_SOURCE_MAX_BYTES,
  evaluatePluginAuthoringManifestSourceJudges
} from "./plugin-authoring-manifest-extractor.mjs";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_CORPUS_BYTES = 1024 * 1024;
const COMMAND_JUDGES = Object.freeze(["build", "unit-test", "security-test", "audit"]);
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export async function executePluginAuthoringJudge({
  requestPath,
  baselineRoot,
  candidateRoot,
  workspaceRoot,
  adapters = {},
  inspectCandidate = inspectIsolatedCandidateBundle,
  parseManifest,
  now
}) {
  let prepared;
  try {
    assert(typeof parseManifest === "function");
    assert(typeof inspectCandidate === "function");
    assertAdapterContract(adapters);
    const roots = {
      requestPath: resolve(requestPath),
      baselineRoot: resolve(baselineRoot),
      candidateRoot: resolve(candidateRoot),
      workspaceRoot: resolve(workspaceRoot)
    };
    assertDirectory(roots.baselineRoot);
    assertDirectory(roots.candidateRoot);
    assertDirectory(roots.workspaceRoot);
    assert(readdirSync(roots.workspaceRoot).length === 0);

    const corpus = parsePluginAuthoringCorpus(
      JSON.parse(
        readBoundedUtf8File(
          join(roots.baselineRoot, "evals", "plugin-authoring", "corpus.json"),
          MAX_CORPUS_BYTES
        )
      )
    );
    parseIsolatedRunnerRequest(
      JSON.parse(readBoundedUtf8File(roots.requestPath, MAX_REQUEST_BYTES)),
      corpus
    );
    // The host runner validates before materialization, and the entrypoint validates again before
    // trusted build adapters receive paths. This prevents direct image invocation or mount drift
    // from smuggling symlinks, hard links, hidden controls, or oversized trees into later judges.
    const candidate = inspectCandidate(roots.candidateRoot, corpus);
    assertCandidateSnapshot(candidate, corpus);
    const manifestSources = readManifestSourcesFromSnapshot(candidate.records, corpus);
    const manifestResults = new Map(
      corpus.tasks.map((task) => [
        task.id,
        evaluatePluginAuthoringManifestSourceJudges({
          task,
          source: manifestSources.get(task.id),
          parseManifest
        })
      ])
    );
    const taskWorkspaces = materializeCandidateSnapshot(
      candidate.records,
      corpus,
      roots.workspaceRoot
    );
    prepared = { corpus, manifestResults, taskWorkspaces, roots };
  } catch {
    throw new Error("plugin authoring judge input is invalid");
  }

  const { corpus, manifestResults, taskWorkspaces, roots } = prepared;
  return runPluginAuthoringJudgeCore({
    corpus,
    ...(now === undefined ? {} : { now }),
    runJudge: ({ task, judge }) => {
      if (judge === "manifest" || judge === "least-privilege") {
        return manifestResults.get(task.id)?.[judge] === true;
      }
      const adapter = adapters[judge];
      if (typeof adapter !== "function") return false;
      // Production adapters are trusted image code, but each receives only the current task and
      // its isolated paths. Candidate mounts remain read-only; writable state is task-scoped.
      return adapter({
        task,
        baselineRoot: roots.baselineRoot,
        taskRoot: taskWorkspaces.get(task.id).taskRoot,
        taskWorkspace: taskWorkspaces.get(task.id).taskWorkspace
      });
    }
  });
}

export function parsePluginAuthoringJudgeArgs(argv) {
  try {
    assert(Array.isArray(argv));
    assert(argv.length === PLUGIN_AUTHORING_JUDGE_ARGV.length);
    assert(argv.every((argument, index) => argument === PLUGIN_AUTHORING_JUDGE_ARGV[index]));
    return PLUGIN_AUTHORING_JUDGE_PATHS;
  } catch {
    throw new Error("plugin authoring judge arguments are invalid");
  }
}

export async function runPluginAuthoringJudgeCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  loadParseManifest = loadCanonicalManifestParser,
  execute = executePluginAuthoringJudge,
  adapters = {
    build: createPluginAuthoringBuildAdapter(),
    "unit-test": createPluginAuthoringUnitTestAdapter(),
    "security-test": createPluginAuthoringSecurityTestAdapter(),
    audit: createPluginAuthoringAuditAdapter()
  }
} = {}) {
  try {
    const paths = parsePluginAuthoringJudgeArgs(argv);
    const parseManifest = await loadParseManifest();
    assert(typeof parseManifest === "function");
    const output = await execute({ ...paths, adapters, parseManifest });
    stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  } catch {
    // Candidate source, parser diagnostics, local paths, and adapter errors never cross the CLI
    // failure boundary. The runner treats this fixed signal as an execution failure.
    stderr.write("plugin authoring judge failed\n");
    return 1;
  }
}

async function loadCanonicalManifestParser() {
  const manifestModule = await import("@tenantscript/manifest");
  if (typeof manifestModule.parseManifest !== "function") {
    throw new Error("canonical manifest parser is unavailable");
  }
  return manifestModule.parseManifest;
}

function readManifestSourcesFromSnapshot(records, corpus) {
  const sources = new Map();
  for (const task of corpus.tasks) {
    const expectedPath = `${task.id}/src/manifest.ts`;
    const matches = records.filter((record) => record.path === expectedPath);
    assert(matches.length === 1);
    assert(matches[0].bytes.length <= MANIFEST_SOURCE_MAX_BYTES);
    sources.set(task.id, textDecoder.decode(matches[0].bytes));
  }
  return sources;
}

function materializeCandidateSnapshot(records, corpus, workspaceRoot) {
  const taskWorkspaces = new Map();
  for (const task of corpus.tasks) {
    const taskWorkspace = join(workspaceRoot, task.id);
    const taskRoot = join(taskWorkspace, "source");
    mkdirSync(taskRoot, { recursive: true, mode: 0o700 });
    const prefix = `${task.id}/`;
    const taskRecords = records.filter((record) => record.taskId === task.id);
    assert(taskRecords.length >= 1);
    for (const record of taskRecords) {
      assert(record.path.startsWith(prefix));
      const relativePath = record.path.slice(prefix.length);
      assert(relativePath.length >= 1);
      const destination = resolve(taskRoot, ...relativePath.split("/"));
      const relativeDestination = relative(taskRoot, destination);
      assert(
        relativeDestination.length >= 1 &&
          !isAbsolute(relativeDestination) &&
          relativeDestination !== ".." &&
          !relativeDestination.startsWith(`..${sep}`)
      );
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, record.bytes, { mode: 0o600, flag: "wx" });
    }
    chmodTree(taskRoot, 0o500, 0o400);
    taskWorkspaces.set(task.id, { taskWorkspace, taskRoot });
  }
  return taskWorkspaces;
}

function assertCandidateSnapshot(candidate, corpus) {
  assert(isPlainRecord(candidate));
  assert(Array.isArray(candidate.records));
  assert(candidate.tasks === corpus.tasks.length);
  assert(candidate.records.length === candidate.files);
  assert(candidate.records.every((record) => isCandidateRecord(record)));
  const taskIds = new Set(corpus.tasks.map((task) => task.id));
  assert(candidate.records.every((record) => taskIds.has(record.taskId)));
  assert(new Set(candidate.records.map((record) => record.path)).size === candidate.records.length);
  assert(
    candidate.records.reduce((total, record) => total + record.bytes.length, 0) ===
      candidate.totalBytes
  );
}

function isCandidateRecord(record) {
  return (
    isPlainRecord(record) &&
    typeof record.taskId === "string" &&
    typeof record.path === "string" &&
    Buffer.isBuffer(record.bytes)
  );
}

function chmodTree(root, directoryMode, fileMode) {
  const metadata = lstatSync(root);
  assert(!metadata.isSymbolicLink());
  if (!metadata.isDirectory()) {
    chmodSync(root, fileMode);
    return;
  }
  for (const entry of readdirSync(root)) {
    chmodTree(join(root, entry), directoryMode, fileMode);
  }
  chmodSync(root, directoryMode);
}

function readBoundedUtf8File(path, maxBytes) {
  const before = lstatSync(path);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
  assert(before.size <= maxBytes);
  const bytes = readFileSync(path);
  assert(bytes.length <= maxBytes);
  const after = lstatSync(path);
  assert(
    after.isFile() &&
      !after.isSymbolicLink() &&
      after.nlink === 1 &&
      after.dev === before.dev &&
      after.ino === before.ino &&
      after.size === before.size &&
      after.mtimeMs === before.mtimeMs
  );
  return textDecoder.decode(bytes);
}

function assertDirectory(path) {
  const metadata = lstatSync(path);
  assert(metadata.isDirectory() && !metadata.isSymbolicLink());
}

function assertAdapterContract(adapters) {
  assert(isPlainRecord(adapters));
  assert(Object.keys(adapters).every((name) => COMMAND_JUDGES.includes(name)));
}

function isPlainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assert(condition) {
  if (!condition) throw new Error("assertion failed");
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  runPluginAuthoringJudgeCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
