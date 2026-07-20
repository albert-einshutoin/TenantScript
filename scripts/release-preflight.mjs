import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverPublicPackages } from "./publishable-packages.mjs";

const expectedPublicPackages = [
  "@tenantscript/capabilities",
  "@tenantscript/cli",
  "@tenantscript/control-plane",
  "@tenantscript/host-sdk",
  "@tenantscript/loader",
  "@tenantscript/manifest",
  "@tenantscript/plugin-sdk",
  "@tenantscript/proxy"
];
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function validateReleaseCandidate({ tag, packages, changesetFiles }) {
  const actualNames = packages.map(({ name }) => name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedPublicPackages)) {
    throw new Error("public package set does not match the release contract");
  }
  const versions = new Set(packages.map(({ version }) => version));
  if (versions.size !== 1) {
    throw new Error("public package versions must match before release");
  }
  const [version] = versions;
  if (typeof version !== "string" || !stableVersion.test(version)) {
    throw new Error("public packages must use one stable semantic version");
  }
  if (version === "0.0.0") {
    throw new Error("0.0.0 cannot be published");
  }
  if (!stableVersion.test(tag.slice(1)) || !tag.startsWith("v")) {
    throw new Error("release candidate requires a stable release tag");
  }
  if (tag !== `v${version}`) {
    throw new Error(`tag ${tag} does not match package version ${version}`);
  }
  const pendingChangesets = changesetFiles.filter(
    (file) => file.endsWith(".md") && file !== "README.md"
  );
  if (pendingChangesets.length > 0) {
    throw new Error("release candidate contains unconsumed Changesets");
  }
  return { tag, version, packages: actualNames };
}

export async function inspectReleaseCandidate(rootDirectory, tag) {
  const root = resolve(rootDirectory);
  const [packages, changesetFiles] = await Promise.all([
    discoverPublicPackages(root),
    readdir(resolve(root, ".changeset"))
  ]);
  return validateReleaseCandidate({
    tag,
    packages: packages.map(({ name, manifest }) => ({ name, version: manifest.version })),
    changesetFiles
  });
}

async function main() {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
  if (tag === undefined || tag === "") throw new Error("release tag is required");
  console.log(JSON.stringify(await inspectReleaseCandidate(process.cwd(), tag), null, 2));
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Release preflight failed");
    process.exitCode = 1;
  });
}
