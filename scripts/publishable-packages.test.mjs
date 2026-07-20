import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  buildPublicPackages,
  cleanupPublicPackageArtifacts,
  discoverPublicPackages,
  packAndValidatePublicPackages,
  sanitizePackageManagerEnvironment,
  validatePackedPackage,
  validateRepositoryPackageContracts
} from "./publishable-packages.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test("discovers the eight public packages and their declared entrypoints", async () => {
  const packages = await discoverPublicPackages(repositoryRoot);

  assert.deepEqual(
    packages.map(({ name, exportTargets, binTargets }) => ({ name, exportTargets, binTargets })),
    [
      packageContract("@tenantscript/capabilities"),
      packageContract("@tenantscript/cli", ["dist/bin.js"]),
      packageContract(
        "@tenantscript/control-plane",
        [],
        ["dist/index.d.ts", "dist/index.js", "dist/rbac.d.ts", "dist/rbac.js"]
      ),
      packageContract("@tenantscript/host-sdk"),
      packageContract("@tenantscript/loader"),
      packageContract("@tenantscript/manifest"),
      packageContract("@tenantscript/plugin-sdk"),
      packageContract("@tenantscript/proxy")
    ]
  );
});

test("requires source-only build and a closed publish allowlist", async () => {
  await assert.doesNotReject(validateRepositoryPackageContracts(repositoryRoot));
});

test("publishes discoverable OSS metadata for every package", async () => {
  const packages = await discoverPublicPackages(repositoryRoot);
  for (const packageContract of packages) {
    assert.equal(typeof packageContract.manifest.description, "string", packageContract.name);
    assert.ok(packageContract.manifest.description.length >= 20, packageContract.name);
    assert.ok(Array.isArray(packageContract.manifest.keywords), packageContract.name);
    assert.ok(packageContract.manifest.keywords.includes("tenantscript"), packageContract.name);
    assert.deepEqual(packageContract.manifest.repository, {
      type: "git",
      url: "git+https://github.com/albert-einshutoin/TenantScript.git",
      directory: packageContract.relativeDirectory
    });
    assert.equal(
      packageContract.manifest.homepage,
      "https://github.com/albert-einshutoin/TenantScript#readme"
    );
    assert.deepEqual(packageContract.manifest.bugs, {
      url: "https://github.com/albert-einshutoin/TenantScript/issues"
    });
  }
});

test("ships the repository Apache-2.0 text in every public package", async () => {
  const rootLicense = await readFile(join(repositoryRoot, "LICENSE"));
  const packages = await discoverPublicPackages(repositoryRoot);
  for (const packageContract of packages) {
    assert.deepEqual(
      await readFile(join(packageContract.directory, "LICENSE")),
      rootLicense,
      packageContract.name
    );
  }
});

test("builds every declared export and binary target from source only", async () => {
  const packages = await discoverPublicPackages(repositoryRoot);
  try {
    await buildPublicPackages(repositoryRoot);
    for (const packageContract of packages) {
      for (const target of [...packageContract.exportTargets, ...packageContract.binTargets]) {
        await assert.doesNotReject(
          import("node:fs/promises").then(({ access }) =>
            access(new URL(target, pathToFileURL(`${packageContract.directory}/`)))
          ),
          `${packageContract.name} is missing ${target}`
        );
      }
    }
  } finally {
    await cleanupPublicPackageArtifacts(repositoryRoot);
  }
});

test("rejects source, tests, coverage, and secret-shaped files from a tarball", () => {
  const packageContract = {
    name: "@fixture/sdk",
    exportTargets: ["dist/index.d.ts", "dist/index.js"],
    binTargets: []
  };

  assert.throws(
    () =>
      validatePackedPackage(packageContract, {
        files: [
          { path: "package.json" },
          { path: "LICENSE" },
          { path: "README.md" },
          { path: "dist/index.d.ts" },
          { path: "dist/index.js" },
          { path: "src/index.ts" },
          { path: "test/index.test.ts" },
          { path: "coverage/lcov.info" },
          { path: "dist/private-key.pem" }
        ]
      }),
    /Packed package @fixture\/sdk is invalid:.*coverage\/lcov\.info.*dist\/private-key\.pem.*src\/index\.ts.*test\/index\.test\.ts/su
  );
});

test("rejects a tarball with a missing declared entrypoint", () => {
  assert.throws(
    () =>
      validatePackedPackage(
        {
          name: "@fixture/cli",
          exportTargets: ["dist/index.d.ts", "dist/index.js"],
          binTargets: ["dist/bin.js"]
        },
        {
          files: [
            { path: "package.json" },
            { path: "LICENSE" },
            { path: "README.md" },
            { path: "dist/index.d.ts" },
            { path: "dist/index.js" }
          ]
        }
      ),
    /missing declared target dist\/bin\.js/u
  );
});

test("rejects source maps whose source files are intentionally not published", () => {
  assert.throws(
    () =>
      validatePackedPackage(
        {
          name: "@fixture/sdk",
          exportTargets: ["dist/index.d.ts", "dist/index.js"],
          binTargets: []
        },
        {
          files: [
            { path: "package.json" },
            { path: "LICENSE" },
            { path: "README.md" },
            { path: "dist/index.d.ts" },
            { path: "dist/index.d.ts.map" },
            { path: "dist/index.js" },
            { path: "dist/index.js.map" }
          ]
        }
      ),
    /forbidden file dist\/index\.d\.ts\.map.*forbidden file dist\/index\.js\.map/su
  );
});

test("does not pass package-manager configuration or credentials into the clean install", () => {
  assert.deepEqual(
    sanitizePackageManagerEnvironment({
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
      npm_config_registry: "https://registry.invalid/with-private-routing",
      NPM_CONFIG_TOKEN: "fixture-secret",
      npm_lifecycle_event: "test:packages",
      npm_package_name: "tenantscript",
      PNPM_SCRIPT_SRC_DIR: "/private/workspace"
    }),
    { PATH: "/fixture/bin", HOME: "/fixture/home" }
  );
});

test("packs all public packages into bounded clean archives", async () => {
  const inventory = await packAndValidatePublicPackages(repositoryRoot);

  assert.deepEqual(
    inventory.map(({ name }) => name),
    [
      "@tenantscript/capabilities",
      "@tenantscript/cli",
      "@tenantscript/control-plane",
      "@tenantscript/host-sdk",
      "@tenantscript/loader",
      "@tenantscript/manifest",
      "@tenantscript/plugin-sdk",
      "@tenantscript/proxy"
    ]
  );
  assert.ok(
    inventory.every(
      ({ fileCount, unpackedSize, smokeVerified, typesVerified }) =>
        fileCount > 0 && unpackedSize > 0 && smokeVerified === true && typesVerified === true
    )
  );
  await assert.rejects(access(join(repositoryRoot, ".tmp", "npm-packages")));
});

function packageContract(
  name,
  binTargets = [],
  exportTargets = ["dist/index.d.ts", "dist/index.js"]
) {
  return { name, exportTargets, binTargets };
}
