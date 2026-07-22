import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const submissionsRoot = join(repoRoot, "templates", "submissions");

test("every template submission builds, tests, and audits packed public packages", async (t) => {
  run(process.execPath, [join(repoRoot, "scripts", "check-template-submissions.mjs")]);
  const entries = await readdir(submissionsRoot, { withFileTypes: true });
  const submissions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(submissions.length > 0);

  for (const submission of submissions) {
    await t.test(submission, async () => exerciseSubmission(submission));
  }
});

test("manifest security metadata must match its submission packet", () => {
  const packet = {
    hook: { name: "ticket.created", type: "transform" },
    capabilities: [],
    configKeys: [],
    egress: { mode: "deny", allowHosts: [] }
  };
  const manifest = {
    hooks: [{ name: "ticket.created", type: "transform" }],
    capabilities: { "network.fetch": { hosts: ["api.example.com"] } },
    configSchema: { properties: {}, required: [] },
    egress: { mode: "allowlist", hosts: ["api.example.com"] }
  };

  assert.throws(() => assertManifestMatchesSubmission(manifest, packet));
});

test("package-manager hooks stay disabled during submission installation", () => {
  const arguments_ = submissionInstallArguments("/tmp/plugin");
  assert.ok(arguments_.includes("--ignore-scripts"));
  assert.ok(arguments_.includes("--ignore-pnpmfile"));
});

async function exerciseSubmission(submission) {
  await mkdir(join(repoRoot, ".tmp"), { recursive: true });
  const tempRoot = await mkdtemp(join(repoRoot, ".tmp", `template-submission-${submission}-`));
  const packetRoot = join(submissionsRoot, submission);
  const metadata = JSON.parse(await readFile(join(packetRoot, "submission.json"), "utf8"));
  const pluginDirectory = join(tempRoot, "plugin");

  try {
    await cp(join(repoRoot, metadata.source.directory), pluginDirectory, { recursive: true });
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

    run("pnpm", submissionInstallArguments(pluginDirectory));
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
    const manifest = JSON.parse(manifestJson);
    assertManifestMatchesSubmission(manifest, metadata);
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
}

function submissionInstallArguments(pluginDirectory) {
  return [
    "--dir",
    pluginDirectory,
    "install",
    "--ignore-workspace",
    "--prefer-offline",
    "--ignore-scripts",
    // --ignore-scripts does not disable pnpmfile hooks, which can mutate the copied source pre-audit.
    "--ignore-pnpmfile"
  ];
}

function assertManifestMatchesSubmission(manifest, submission) {
  const actual = {
    hook: manifest.hooks.map(({ name, type }) => ({ name, type })),
    capabilities: Object.keys(manifest.capabilities).sort(),
    configKeys: Object.keys(manifest.configSchema.properties).sort(),
    egress: {
      mode: manifest.egress.mode,
      allowHosts: manifest.egress.mode === "allowlist" ? [...manifest.egress.hosts].sort() : []
    }
  };
  const expected = {
    hook: [submission.hook],
    capabilities: submission.capabilities,
    configKeys: submission.configKeys,
    egress: submission.egress
  };
  assert.deepEqual(actual, expected, "manifest security metadata must match submission.json");
}

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
