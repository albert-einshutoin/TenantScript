import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const submissionsRoot = join(repoRoot, "templates", "submissions");
const bundleRunnerPath = join(repoRoot, "scripts", "template-submission-bundle-runner.mjs");
const pnpmStoreDirectory = execFileSync("pnpm", ["store", "path"], {
  cwd: repoRoot,
  encoding: "utf8"
}).trim();

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
  const arguments_ = submissionInstallArguments("/tmp/plugin", "/tmp/pnpm-store");
  assert.ok(arguments_.includes("--ignore-scripts"));
  assert.ok(arguments_.includes("--ignore-pnpmfile"));
  assert.ok(arguments_.includes("--offline"));
  assert.ok(!arguments_.includes("--prefer-offline"));
});

test("generated bundle dispatch terminates a synchronous loop", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "template-submission-loop-"));
  try {
    const bundlePath = join(tempRoot, "plugin.cjs");
    await writeFile(bundlePath, "module.exports.plugin = { dispatch() { while (true) {} } };\n");

    assert.throws(
      () =>
        dispatchBundleInChild(
          bundlePath,
          { hookName: "ticket.created", payload: {} },
          "synchronous-loop"
        ),
      /exceeded the 2 second dispatch limit/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

async function exerciseSubmission(submission) {
  // Keep submitted build scripts outside the checkout. Even a reviewed relative path must not be
  // able to reach mutable repository files that are absent from the source digest map.
  const tempRoot = await mkdtemp(join(tmpdir(), `template-submission-${submission}-`));
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

    run("pnpm", submissionInstallArguments(pluginDirectory, pnpmStoreDirectory));
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
    for (const behaviorCase of metadata.verification.behaviorCases) {
      const outcome = dispatchBundleInChild(
        bundlePath,
        {
          hookName: metadata.hook.name,
          payload: behaviorCase.payload
        },
        behaviorCase.name
      );
      assert.deepEqual(outcome.result, behaviorCase.expected, behaviorCase.name);
      assert.equal(outcome.capabilityCallCount, 0, `${behaviorCase.name} invoked a capability`);
    }
    // Run the required behavior-test file explicitly so a future package-script drift cannot turn
    // the evidence command into a no-op while leaving an unexecuted test in the digest map.
    run("pnpm", ["--dir", pluginDirectory, "exec", "vitest", "run", "test/plugin.test.ts"]);
    run("pnpm", ["--dir", pluginDirectory, "test"]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function dispatchBundleInChild(bundlePath, request, caseName) {
  const encodedRequest = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
  // spawnSync enforces its timeout outside the submitted JavaScript event loop. SIGKILL cannot be
  // intercepted by a synchronous loop, so the per-case limit remains real for hostile CPU behavior.
  const child = spawnSync(process.execPath, [bundleRunnerPath, bundlePath, encodedRequest], {
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    timeout: 2_000
  });
  if (child.error?.code === "ETIMEDOUT") {
    assert.fail(`${caseName} exceeded the 2 second dispatch limit`);
  }
  assert.equal(child.signal, null, `${caseName} bundle runner exited by signal`);
  assert.equal(child.status, 0, `${caseName} bundle runner failed`);
  const marker = "TENANTSCRIPT_BUNDLE_RESULT:";
  const markerIndex = child.stdout.lastIndexOf(marker);
  assert.notEqual(markerIndex, -1, `${caseName} bundle runner returned no result`);
  const encodedResult = child.stdout
    .slice(markerIndex + marker.length)
    .trim()
    .split(/\s/u)[0];
  return JSON.parse(Buffer.from(encodedResult, "base64url").toString("utf8"));
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

function submissionInstallArguments(pluginDirectory, storeDirectory) {
  return [
    "--dir",
    pluginDirectory,
    "install",
    "--ignore-workspace",
    // A temp directory can live on another volume, but offline resolution must use the store that
    // the repository's frozen install populated rather than a path-derived empty default store.
    "--store-dir",
    storeDirectory,
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
