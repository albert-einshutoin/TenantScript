#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const namespace = "@tenantscript/";
const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// This allowlist makes every production workspace edge reviewable. Loader's control-plane edge is
// intentionally retained while the approval continuation contract lives there; no other runtime
// package may depend upward through that exception.
const allowedRuntimeDependencies = new Map([
  ["@tenantscript/test-config", new Set()],
  ["@tenantscript/manifest", new Set()],
  ["@tenantscript/plugin-sdk", new Set(["@tenantscript/manifest"])],
  ["@tenantscript/host-sdk", new Set()],
  ["@tenantscript/capabilities", new Set()],
  ["@tenantscript/control-plane", new Set(["@tenantscript/host-sdk", "@tenantscript/manifest"])],
  ["@tenantscript/loader", new Set(["@tenantscript/control-plane"])],
  ["@tenantscript/proxy", new Set(["@tenantscript/host-sdk"])],
  [
    "@tenantscript/cli",
    new Set(["@tenantscript/control-plane", "@tenantscript/loader", "@tenantscript/manifest"])
  ],
  [
    "@tenantscript/plugin-authoring-judge-image",
    new Set(["@tenantscript/cli", "@tenantscript/loader", "@tenantscript/manifest"])
  ]
]);

function discoverManifests(repoRoot) {
  const manifests = [];
  // Deployment workspaces are executable composition roots, so their internal edges need the
  // same review gate as published packages instead of bypassing the architecture allowlist.
  for (const workspaceDir of ["packages", "apps", "deploy"]) {
    const root = join(repoRoot, workspaceDir);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root).sort()) {
      const path = join(root, entry, "package.json");
      if (existsSync(path)) manifests.push(path);
    }
  }
  return manifests;
}

function runtimeDependencies(manifest) {
  return Object.keys({
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
    ...(manifest.peerDependencies ?? {})
  }).filter((name) => name.startsWith(namespace));
}

function validateManifest(path, repoRoot, knownPackagePaths) {
  const label = relative(repoRoot, path);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [`${label}: invalid package.json`];
  }

  if (typeof manifest.name !== "string") return [`${label}: missing package name`];
  const dependencies = runtimeDependencies(manifest);
  const errors = [];
  for (const dependency of dependencies) {
    if (!knownPackagePaths.has(dependency)) {
      errors.push(`${label}: unknown internal package ${dependency}`);
      continue;
    }
    if (label.startsWith("apps/")) {
      if (knownPackagePaths.get(dependency)?.startsWith("apps/")) {
        errors.push(`${label}: ${manifest.name} must not depend on app ${dependency}`);
      }
      continue;
    }
    const allowed = allowedRuntimeDependencies.get(manifest.name);
    if (allowed === undefined || !allowed.has(dependency)) {
      errors.push(`${label}: ${manifest.name} must not depend on ${dependency}`);
    }
  }
  return errors;
}

function main() {
  const customRoot = process.argv[2];
  const repoRoot = customRoot ? resolve(customRoot) : defaultRoot;
  const manifests = discoverManifests(repoRoot);
  const knownPackagePaths = new Map(
    manifests.flatMap((path) => {
      try {
        const name = JSON.parse(readFileSync(path, "utf8")).name;
        return typeof name === "string" ? [[name, relative(repoRoot, path)]] : [];
      } catch {
        return [];
      }
    })
  );
  const errors = manifests.flatMap((path) => validateManifest(path, repoRoot, knownPackagePaths));

  if (errors.length > 0) {
    console.error("Package boundary check failed:\n");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Package boundary check passed (${manifests.length} workspaces).`);
}

main();
