#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function markdownFiles(repoRoot) {
  const files = ["docs", "tasks"].flatMap((directory) =>
    collectMarkdown(join(repoRoot, directory))
  );
  const agentOnboarding = join(repoRoot, "llms.txt");
  if (existsSync(agentOnboarding)) files.push(agentOnboarding);
  return files;
}

function collectMarkdown(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectMarkdown(path);
      return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
    });
}

function validateRelativeLinks(path, repoRoot) {
  const errors = [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    for (const match of line.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const rawTarget = match[1]?.trim();
      if (rawTarget === undefined || rawTarget === "") continue;
      const target = markdownTarget(rawTarget);
      if (target === undefined || isExternalOrAnchor(target)) continue;

      let decoded;
      try {
        decoded = decodeURIComponent(target.split(/[?#]/, 1)[0] ?? "");
      } catch {
        errors.push(formatLinkError(path, repoRoot, index, `invalid link encoding ${target}`));
        continue;
      }
      if (decoded === "") continue;

      const resolved = resolve(dirname(path), decoded);
      const insideRepo = resolved === repoRoot || resolved.startsWith(`${repoRoot}${sep}`);
      if (!insideRepo || !existsSync(resolved)) {
        errors.push(formatLinkError(path, repoRoot, index, `broken relative link ${target}`));
      }
    }
  }
  return errors;
}

function markdownTarget(rawTarget) {
  if (rawTarget.startsWith("<")) {
    const closing = rawTarget.indexOf(">");
    return closing === -1 ? rawTarget : rawTarget.slice(1, closing);
  }
  return rawTarget.split(/\s+/, 1)[0];
}

function isExternalOrAnchor(target) {
  return target.startsWith("#") || target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(target);
}

function formatLinkError(path, repoRoot, zeroBasedLine, message) {
  return `${relative(repoRoot, path)}:${String(zeroBasedLine + 1)}: ${message}`;
}

function validateProxySnippetContract(repoRoot) {
  const quickstartPath = join(repoRoot, "docs", "quickstarts", "zero-integration-proxy-mode.md");
  const e2ePath = join(
    repoRoot,
    "apps",
    "example-saas",
    "test",
    "zero-integration-quickstart.e2e.test.ts"
  );
  const errors = [];
  if (!existsSync(quickstartPath)) {
    return ["docs/quickstarts/zero-integration-proxy-mode.md: missing proxy quickstart"];
  }
  if (!existsSync(e2ePath)) {
    return ["apps/example-saas/test/zero-integration-quickstart.e2e.test.ts: missing proxy E2E"];
  }

  const e2e = readFileSync(e2ePath, "utf8");
  const required = [...e2e.matchAll(/extractJsonSnippet\(\s*quickstart\s*,\s*"([^"]+)"\s*\)/g)].map(
    (match) => match[1]
  );
  if (required.length === 0) {
    errors.push(`${relative(repoRoot, e2ePath)}: no proxy quickstart snippet identifiers found`);
  }

  const quickstart = readFileSync(quickstartPath, "utf8");
  const labels = [...quickstart.matchAll(/^```json\s+([^\s]+)\s*$/gm)].map((match) => match[1]);
  const counts = new Map();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  for (const [label, count] of counts) {
    if (count > 1) {
      errors.push(
        `${relative(repoRoot, quickstartPath)}: duplicate proxy quickstart snippet identifier ${label}`
      );
    }
  }
  for (const label of new Set(required)) {
    if (!counts.has(label)) {
      errors.push(
        `${relative(repoRoot, quickstartPath)}: missing proxy quickstart snippet identifier ${label}`
      );
    }
  }
  return errors;
}

function main() {
  const repoRoot = process.argv[2] === undefined ? defaultRoot : resolve(process.argv[2]);
  const files = markdownFiles(repoRoot);
  const errors = [
    ...files.flatMap((path) => validateRelativeLinks(path, repoRoot)),
    ...validateProxySnippetContract(repoRoot)
  ];
  if (errors.length > 0) {
    console.error("Doc integrity check failed:\n");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Doc integrity check passed (${files.length} documentation files).`);
}

main();
