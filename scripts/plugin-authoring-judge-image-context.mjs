#!/usr/bin/env node

import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const PLUGIN_AUTHORING_JUDGE_IMAGE_BASE =
  "node@sha256:1a6a7b2e2e2c80a6973f57aa8b0c6ad67a961ddbc5ef326c448e133f93564ff9";

const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const packageNames = ["cli", "control-plane", "host-sdk", "loader", "manifest", "test-config"];
const rootFiles = [
  "LICENSE",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json"
];
const deploymentFiles = [
  "deploy/plugin-authoring-judge/Dockerfile",
  "deploy/plugin-authoring-judge/package.json",
  "deploy/plugin-authoring-judge/plugin-authoring-judge"
];
const evalFiles = [
  "evals/plugin-authoring/behavior-cases.json",
  "evals/plugin-authoring/corpus.json",
  "evals/plugin-authoring/security-cases.json"
];
const scriptFiles = [
  "plugin-authoring-audit-adapter.mjs",
  "plugin-authoring-behavior-cases.mjs",
  "plugin-authoring-behavior-runner.mjs",
  "plugin-authoring-build-adapter.mjs",
  "plugin-authoring-build-contract.mjs",
  "plugin-authoring-build-worker.mjs",
  "plugin-authoring-eval.mjs",
  "plugin-authoring-isolated-runner.mjs",
  "plugin-authoring-judge-contract.mjs",
  "plugin-authoring-judge-core.mjs",
  "plugin-authoring-judge-entrypoint.mjs",
  "plugin-authoring-manifest-extractor.mjs",
  "plugin-authoring-manifest-judges.mjs",
  "plugin-authoring-security-adapter.mjs",
  "plugin-authoring-security-boundary.mjs",
  "plugin-authoring-security-cases.mjs",
  "plugin-authoring-security-runner.mjs",
  "plugin-authoring-unit-adapter.mjs"
].map((name) => `scripts/${name}`);

export function stagePluginAuthoringJudgeImageContext({ repositoryRoot, outputRoot }) {
  try {
    const sourceRoot = canonicalDirectory(repositoryRoot);
    const destinationRoot = resolve(outputRoot);
    assert(isAbsolute(destinationRoot));
    assert(destinationRoot !== sourceRoot);
    assertMissing(destinationRoot);

    const paths = [...rootFiles, ...deploymentFiles, ...evalFiles, ...scriptFiles];
    for (const packageName of packageNames) {
      paths.push(...collectPackageFiles(sourceRoot, packageName));
    }
    paths.sort(compareText);
    assert(new Set(paths).size === paths.length && paths.length <= MAX_FILES);

    const records = [];
    let totalBytes = 0;
    for (const path of paths) {
      assertSafeRelativePath(path);
      const source = join(sourceRoot, path);
      const metadata = lstatSync(source);
      assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1);
      assert(metadata.size >= 1 && metadata.size <= MAX_FILE_BYTES);
      const bytes = readFileSync(source);
      assert(bytes.length === metadata.size);
      totalBytes += bytes.length;
      assert(totalBytes <= MAX_TOTAL_BYTES);
      records.push({ path, bytes });
    }

    mkdirSync(destinationRoot, { mode: 0o700 });
    for (const record of records) {
      const destination = join(destinationRoot, record.path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, record.bytes, {
        flag: "wx",
        mode: record.path.endsWith("/plugin-authoring-judge") ? 0o755 : 0o644
      });
    }
    return Object.freeze({ files: records.length, totalBytes, paths: Object.freeze(paths) });
  } catch {
    throw new Error("plugin authoring judge image context is invalid");
  }
}

function collectPackageFiles(repositoryRoot, packageName) {
  const packageRoot = join(repositoryRoot, "packages", packageName);
  const paths = [];
  const visit = (directory, relativeDirectory = "") => {
    for (const entry of readdirSync(directory).sort(compareText)) {
      if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
      const relativePath = relativeDirectory === "" ? entry : `${relativeDirectory}/${entry}`;
      const source = join(directory, entry);
      const metadata = lstatSync(source);
      assert(!metadata.isSymbolicLink());
      if (metadata.isDirectory()) {
        if (relativePath === "src") visit(source, relativePath);
        continue;
      }
      assert(metadata.isFile() && metadata.nlink === 1);
      if (
        relativePath === "package.json" ||
        relativePath.startsWith("src/") ||
        /^tsconfig(?:\.[a-z-]+)?\.json$/u.test(relativePath)
      ) {
        paths.push(`packages/${packageName}/${relativePath}`);
      }
    }
  };
  visit(packageRoot);
  assert(paths.includes(`packages/${packageName}/package.json`));
  return paths;
}

function canonicalDirectory(path) {
  assert(typeof path === "string" && isAbsolute(path) && resolve(path) === path);
  const metadata = lstatSync(path);
  assert(metadata.isDirectory() && !metadata.isSymbolicLink());
  return path;
}

function assertMissing(path) {
  try {
    lstatSync(path);
    assert(false);
  } catch (error) {
    assert(error?.code === "ENOENT");
  }
}

function assertSafeRelativePath(path) {
  assert(typeof path === "string" && path.length >= 1 && Buffer.byteLength(path) <= 240);
  assert(!isAbsolute(path) && !path.startsWith(".") && !path.split("/").includes(".."));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assert(condition) {
  if (!condition) throw new Error("assertion failed");
}
