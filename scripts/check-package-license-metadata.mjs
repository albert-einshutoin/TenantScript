#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_LICENSE = "Apache-2.0";
const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function discoverPackageManifests(repoRoot) {
  const manifests = [join(repoRoot, "package.json")];

  for (const workspaceDir of ["packages", "apps"]) {
    const dirPath = join(repoRoot, workspaceDir);
    if (!existsSync(dirPath)) {
      continue;
    }

    for (const entry of readdirSync(dirPath).sort()) {
      const manifestPath = join(dirPath, entry, "package.json");
      if (existsSync(manifestPath)) {
        manifests.push(manifestPath);
      }
    }
  }

  return manifests;
}

function validatePackageLicense(manifestPath, repoRoot) {
  const relativePath = manifestPath.startsWith(`${repoRoot}/`)
    ? manifestPath.slice(repoRoot.length + 1)
    : manifestPath;
  const errors = [];

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    errors.push(`${relativePath}: invalid package.json`);
    return errors;
  }

  if (!manifest.license) {
    errors.push(`${relativePath}: missing license field`);
  } else if (manifest.license !== EXPECTED_LICENSE) {
    errors.push(
      `${relativePath}: incorrect license field "${manifest.license}" (expected "${EXPECTED_LICENSE}")`
    );
  }

  return errors;
}

function main() {
  const customRoot = process.argv[2];
  const repoRoot = customRoot ? resolve(customRoot) : defaultRoot;

  const manifestPaths = discoverPackageManifests(repoRoot);
  const errors = [];

  for (const manifestPath of manifestPaths) {
    errors.push(...validatePackageLicense(manifestPath, repoRoot));
  }

  if (errors.length > 0) {
    console.error("Package license metadata check failed:\n");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  const label = customRoot ? repoRoot : "workspace";
  console.log(
    `Package license metadata check passed (${manifestPaths.length} packages in ${label}).`
  );
}

main();
