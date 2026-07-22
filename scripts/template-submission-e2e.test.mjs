import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const submissionRoot = join(repoRoot, "templates", "submissions", "ticket-priority-normalizer");

test("simulated community submission builds, tests, and audits packed public packages", async () => {
  run(process.execPath, [join(repoRoot, "scripts", "check-template-submissions.mjs")]);
  await mkdir(join(repoRoot, ".tmp"), { recursive: true });
  const tempRoot = await mkdtemp(join(repoRoot, ".tmp", "template-submission-"));
  const pluginDirectory = join(tempRoot, "plugin");

  try {
    await cp(join(submissionRoot, "plugin"), pluginDirectory, { recursive: true });
    const manifestTarball = packPublicPackage("packages/manifest", tempRoot);
    const pluginSdkTarball = packPublicPackage("packages/plugin-sdk", tempRoot);
    const packageJsonPath = join(pluginDirectory, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const cliPackageJson = JSON.parse(
      await readFile(join(repoRoot, "packages", "cli", "package.json"), "utf8")
    );
    assert.deepEqual(packageJson.dependencies, {
      "@tenantscript/manifest": cliPackageJson.version,
      "@tenantscript/plugin-sdk": cliPackageJson.version
    });

    const auditPackagePath = join(tempRoot, "audit-package.json");
    await writeFile(auditPackagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    packageJson.dependencies = {
      "@tenantscript/manifest": `file:${manifestTarball}`,
      "@tenantscript/plugin-sdk": `file:${pluginSdkTarball}`
    };
    packageJson.pnpm = {
      overrides: {
        "@tenantscript/manifest": `file:${manifestTarball}`,
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
    const manifestJson = run(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        'import { manifest } from "./src/manifest.ts"; process.stdout.write(JSON.stringify(manifest));'
      ],
      { cwd: pluginDirectory }
    );
    const manifestPath = join(tempRoot, "manifest.json");
    await writeFile(manifestPath, `${manifestJson}\n`);
    const bundlePath = join(tempRoot, "plugin.cjs");
    run(process.execPath, [
      join(repoRoot, "packages", "cli", "dist", "bin.js"),
      "build",
      "--entry",
      join(pluginDirectory, "src", "index.ts"),
      "--out",
      bundlePath
    ]);
    const report = JSON.parse(
      run(process.execPath, [
        join(repoRoot, "packages", "cli", "dist", "bin.js"),
        "audit",
        "--manifest",
        manifestPath,
        "--package",
        auditPackagePath,
        "--bundle",
        bundlePath
      ])
    );
    assert.deepEqual(report, { version: 1, passed: true, findings: [] });
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

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
}
