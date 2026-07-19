#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function markdownFiles(repoRoot) {
  const files = [];
  for (const directory of ["quickstarts", "reference"]) {
    const path = join(repoRoot, "docs", directory);
    if (!existsSync(path)) continue;
    files.push(
      ...readdirSync(path)
        .filter((name) => name.endsWith(".md"))
        .sort()
        .map((name) => join(path, name))
    );
  }
  const rollback = join(repoRoot, "docs", "operations", "rollback-troubleshooting.md");
  if (existsSync(rollback)) files.push(rollback);
  const contributing = join(repoRoot, "CONTRIBUTING.md");
  if (existsSync(contributing)) files.push(contributing);
  return files;
}

function workspaceNames(repoRoot) {
  const names = new Set();
  for (const parent of ["packages", "apps"]) {
    const path = join(repoRoot, parent);
    if (!existsSync(path)) continue;
    for (const entry of readdirSync(path)) {
      const manifest = join(path, entry, "package.json");
      if (!existsSync(manifest)) continue;
      try {
        const name = JSON.parse(readFileSync(manifest, "utf8")).name;
        if (typeof name === "string") names.add(name);
      } catch {
        // Other repository checks report malformed manifests; this checker stays docs-focused.
      }
    }
  }
  return names;
}

function validateFile(path, repoRoot, workspaces) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const label = relative(repoRoot, path);
  const errors = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^```(?:sh|bash)$/.test(lines[index] ?? "")) continue;
    const lineNumber = index + 1;
    const cwdLine = lines[index + 1] ?? "";
    const exitLine = lines[index + 2] ?? "";
    if (!cwdLine.startsWith("# cwd: ")) {
      errors.push(`${label}:${String(lineNumber)}: shell block must start with # cwd:`);
    } else {
      const cwd = cwdLine.slice("# cwd: ".length).trim();
      if (cwd !== "repository root") {
        const resolved = resolve(repoRoot, cwd);
        if (
          cwd === "" ||
          isAbsolute(cwd) ||
          !resolved.startsWith(`${repoRoot}/`) ||
          !existsSync(resolved) ||
          !statSync(resolved).isDirectory()
        ) {
          errors.push(`${label}:${String(lineNumber)}: working directory does not exist: ${cwd}`);
        }
      }
    }
    if (!/^# expected-exit: \d+$/.test(exitLine)) {
      errors.push(`${label}:${String(lineNumber)}: shell block must declare # expected-exit: N`);
    }

    const body = [];
    for (let cursor = index + 1; cursor < lines.length && lines[cursor] !== "```"; cursor += 1) {
      body.push(lines[cursor] ?? "");
      index = cursor;
    }
    for (const match of body.join("\n").matchAll(/pnpm\s+--filter\s+([^\s\\]+)/g)) {
      const filter = match[1];
      if (filter !== undefined && !workspaces.has(filter)) {
        errors.push(`${label}:${String(lineNumber)}: unknown workspace filter ${filter}`);
      }
    }
  }
  return errors;
}

function main() {
  const repoRoot = process.argv[2] === undefined ? defaultRoot : resolve(process.argv[2]);
  const files = markdownFiles(repoRoot);
  const workspaces = workspaceNames(repoRoot);
  const errors = files.flatMap((path) => validateFile(path, repoRoot, workspaces));
  if (errors.length > 0) {
    console.error("Doc command contract check failed:\n");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Doc command contract check passed (${files.length} files).`);
}

main();
