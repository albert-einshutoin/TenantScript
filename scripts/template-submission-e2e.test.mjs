import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const submissionsRoot = join(repoRoot, "templates", "submissions");
const require = createRequire(import.meta.url);

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

test("submission installation disables hooks and registry access", () => {
  const arguments_ = submissionInstallArguments("/tmp/plugin");
  assert.ok(arguments_.includes("--ignore-scripts"));
  assert.ok(arguments_.includes("--ignore-pnpmfile"));
  assert.ok(arguments_.includes("--offline"));
  assert.ok(!arguments_.includes("--prefer-offline"));
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
    const submittedPackageJson = await readFile(packageJsonPath, "utf8");
    const packageJson = JSON.parse(submittedPackageJson);
    const cliPackageJson = JSON.parse(
      await readFile(join(repoRoot, "packages", "cli", "package.json"), "utf8")
    );
    assert.equal(metadata.sdk.lastTestedVersion, cliPackageJson.version);
    assert.deepEqual(packageJson.dependencies, {
      "@tenantscript/manifest": metadata.sdk.lastTestedVersion,
      "@tenantscript/plugin-sdk": metadata.sdk.lastTestedVersion
    });

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
    // Restore the digest-bound metadata before build and audit; install-only tarball overrides must
    // never become a sanitized substitute for the package consumers receive.
    await writeFile(packageJsonPath, submittedPackageJson);
    const cliBinDirectory = await createCliShim(tempRoot);
    const commandEnvironment = {
      PATH: `${cliBinDirectory}${delimiter}${process.env.PATH ?? ""}`
    };
    // The build is the authority for audited outputs; prove the copied submission and offline
    // install did not pre-populate artifacts that a no-op build could silently reuse.
    await assert.rejects(readFile(join(pluginDirectory, "manifest.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(pluginDirectory, "dist", "plugin.cjs")), { code: "ENOENT" });
    run("pnpm", ["--dir", pluginDirectory, "exec", "tsc", "--noEmit"]);
    run("pnpm", ["--dir", pluginDirectory, "build"], { env: commandEnvironment });
    const manifestJson = await readFile(join(pluginDirectory, "manifest.json"), "utf8");
    const bundlePath = join(pluginDirectory, "dist", "plugin.cjs");
    await readFile(bundlePath, "utf8");
    const manifest = JSON.parse(manifestJson);
    assertManifestMatchesSubmission(manifest, metadata);
    const report = JSON.parse(
      run(
        "ext",
        [
          "audit",
          "--manifest",
          "./manifest.json",
          "--package",
          "./package.json",
          "--bundle",
          "./dist/plugin.cjs"
        ],
        { cwd: pluginDirectory, env: commandEnvironment }
      )
    );
    assert.deepEqual(report, { version: 1, passed: true, findings: [] });
    // Audit the generated bytes before loading them, then prove those same bytes implement the
    // packet-owned contract rather than relying only on source-level Vitest behavior.
    const loadedBundle = require(bundlePath);
    const bundledPlugin = loadedBundle.plugin ?? loadedBundle.default;
    assert.equal(typeof bundledPlugin?.dispatch, "function", "bundle must export a plugin");
    for (const behaviorCase of metadata.verification.behaviorCases) {
      const capabilityCalls = [];
      const result = await dispatchWithTimeout(
        bundledPlugin,
        {
          hookName: metadata.hook.name,
          payload: behaviorCase.payload,
          context: {
            capability: async (...args) => {
              capabilityCalls.push(args);
              throw new Error("behavior cases must not invoke capabilities");
            }
          }
        },
        behaviorCase.name
      );
      assert.deepEqual(result, behaviorCase.expected, behaviorCase.name);
      assert.equal(capabilityCalls.length, 0, `${behaviorCase.name} invoked a capability`);
    }
    // Run the required behavior-test file explicitly so a future package-script drift cannot turn
    // the evidence command into a no-op while leaving an unexecuted test in the digest map.
    run("pnpm", ["--dir", pluginDirectory, "exec", "vitest", "run", "test/plugin.test.ts"]);
    run("pnpm", ["--dir", pluginDirectory, "test"]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function dispatchWithTimeout(plugin, request, caseName) {
  let timeout;
  try {
    // A bounded case count and payload size are insufficient if submitted code never settles.
    // Fail each generated-bundle probe independently so one plugin cannot occupy the CI lane forever.
    return await Promise.race([
      plugin.dispatch(request),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${caseName} exceeded the 2 second dispatch limit`)),
          2_000
        );
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function createCliShim(tempRoot) {
  const binDirectory = join(tempRoot, "bin");
  const shimPath = join(binDirectory, "ext");
  const cliPath = join(repoRoot, "packages", "cli", "dist", "bin.js");
  await mkdir(binDirectory, { recursive: true });
  await writeFile(
    shimPath,
    `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nconst result = spawnSync(process.execPath, [${JSON.stringify(
      cliPath
    )}, ...process.argv.slice(2)], { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`
  );
  await chmod(shimPath, 0o755);
  return binDirectory;
}

function submissionInstallArguments(pluginDirectory) {
  return [
    "--dir",
    pluginDirectory,
    "install",
    "--ignore-workspace",
    // Missing cache entries must fail closed instead of letting unreviewed package metadata reach npm.
    "--offline",
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
    env: { ...process.env, ...options.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
}
