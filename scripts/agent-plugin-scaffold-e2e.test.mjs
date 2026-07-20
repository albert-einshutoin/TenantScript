import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("ext init output builds and tests against packed public packages", async () => {
  await mkdir(join(repoRoot, ".tmp"), { recursive: true });
  const tempRoot = await mkdtemp(join(repoRoot, ".tmp", "agent-plugin-scaffold-"));
  const pluginDirectory = join(tempRoot, "large-invoice-notify");

  try {
    const manifestTarball = packPublicPackage("packages/manifest", tempRoot);
    const pluginSdkTarball = packPublicPackage("packages/plugin-sdk", tempRoot);
    run(process.execPath, [
      join(repoRoot, "packages/cli/dist/bin.js"),
      "init",
      "--name",
      "large-invoice-notify",
      "--dir",
      pluginDirectory
    ]);

    const packageJsonPath = join(pluginDirectory, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const cliPackageJson = JSON.parse(
      await readFile(join(repoRoot, "packages/cli/package.json"), "utf8")
    );
    assert.deepEqual(packageJson.dependencies, {
      "@tenantscript/manifest": cliPackageJson.version,
      "@tenantscript/plugin-sdk": cliPackageJson.version
    });

    // The checkout is intentionally unpublished. Swap only the install locations to fresh tarballs
    // after proving emitted versions, so this exercises public package contents rather than sources.
    packageJson.dependencies = {
      "@tenantscript/manifest": `file:${manifestTarball}`,
      "@tenantscript/plugin-sdk": `file:${pluginSdkTarball}`
    };
    packageJson.pnpm = {
      overrides: {
        "@tenantscript/manifest": `file:${manifestTarball}`,
        // Reuse the root lock's tested Vite instead of consulting mutable registry metadata.
        vite: JSON.parse(
          await readFile(
            join(repoRoot, "node_modules/.pnpm/node_modules/vite/package.json"),
            "utf8"
          )
        ).version
      }
    };
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

    run("pnpm", [
      "--dir",
      pluginDirectory,
      "install",
      "--ignore-workspace",
      "--prefer-offline",
      "--ignore-scripts"
    ]);
    run("pnpm", ["--dir", pluginDirectory, "build"]);
    run("pnpm", ["--dir", pluginDirectory, "test"]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

function packPublicPackage(packageDirectory, destination) {
  const output = run("pnpm", [
    "--dir",
    join(repoRoot, packageDirectory),
    "pack",
    "--pack-destination",
    destination,
    "--json"
  ]);
  const result = JSON.parse(output);
  assert.equal(typeof result.filename, "string");
  return result.filename;
}

function run(command, args) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
}
