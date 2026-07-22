import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { deserialize } from "node:v8";

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

test("submitted commands cannot inherit secrets and are externally time bounded", () => {
  process.env.TENANTSCRIPT_SUBMISSION_TEST_SECRET = "must-not-reach-submitted-code";
  try {
    const observedSecret = runSubmissionCommand(
      process.execPath,
      ["-e", "process.stdout.write(process.env.TENANTSCRIPT_SUBMISSION_TEST_SECRET ?? 'absent')"],
      { label: "environment probe" }
    );
    assert.equal(observedSecret, "absent");
    assert.throws(
      () =>
        runSubmissionCommand(process.execPath, ["-e", "while (true) {}"], {
          label: "timeout probe",
          timeoutMs: 100
        }),
      /timeout probe exceeded the 100 ms submitted-command limit/
    );
  } finally {
    delete process.env.TENANTSCRIPT_SUBMISSION_TEST_SECRET;
  }
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

test("generated bundle dispatch returns and records a declared capability call", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "template-submission-capability-"));
  try {
    const bundlePath = join(tempRoot, "plugin.cjs");
    await writeFile(
      bundlePath,
      `module.exports.plugin = {
        async dispatch({ context }) {
          const value = await context.capability("kv.state", { key: "ticket-priority" });
          return { ok: true, value };
        }
      };\n`
    );

    const outcome = dispatchBundleInChild(
      bundlePath,
      {
        hookName: "ticket.created",
        payload: {},
        capabilityCalls: [
          {
            name: "kv.state",
            input: { key: "ticket-priority" },
            result: { value: "high" }
          }
        ]
      },
      "declared-capability"
    );

    assert.deepEqual(outcome, {
      result: { ok: true, value: { value: "high" } },
      capabilityCalls: [{ name: "kv.state", input: { key: "ticket-priority" } }]
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generated bundle cannot forge the authenticated result channel", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "template-submission-output-"));
  try {
    const bundlePath = join(tempRoot, "plugin.cjs");
    await writeFile(
      bundlePath,
      `const write = process.stdout.write.bind(process.stdout);
      module.exports.plugin = {
        dispatch() {
          write("TENANTSCRIPT_BUNDLE_RESULT:ZmFrZQ:" + "0".repeat(64) + "\\n");
          process.stdout.write = () => true;
          JSON.stringify = () => "forged";
          Buffer.prototype.toString = () => "Zm9yZ2Vk";
          const hmac = require("node:crypto").createHmac("sha256", "forged");
          Object.getPrototypeOf(hmac).update = function () { return this; };
          Object.getPrototypeOf(hmac).digest = () => "0".repeat(64);
          return { ok: true, value: "actual" };
        }
      };\n`
    );

    const outcome = dispatchBundleInChild(
      bundlePath,
      { hookName: "ticket.created", payload: {}, capabilityCalls: [] },
      "authenticated-output"
    );

    assert.deepEqual(outcome.result, { ok: true, value: "actual" });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generated bundle fails when capability work remains after dispatch", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "template-submission-late-call-"));
  try {
    const bundlePath = join(tempRoot, "plugin.cjs");
    await writeFile(
      bundlePath,
      `module.exports.plugin = {
        dispatch({ context }) {
          setTimeout(() => context.capability("kv.state", { key: "late" }), 1_000).unref();
          return { ok: true, value: "returned" };
        }
      };\n`
    );

    assert.throws(
      () =>
        dispatchBundleInChild(
          bundlePath,
          {
            hookName: "ticket.created",
            payload: {},
            capabilityCalls: [
              { name: "kv.state", input: { key: "late" }, result: { value: "ignored" } }
            ]
          },
          "late-capability"
        ),
      /left asynchronous work pending/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generated bundle fails on a capability call after dispatch returns", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "template-submission-post-return-call-"));
  try {
    const bundlePath = join(tempRoot, "plugin.cjs");
    await writeFile(
      bundlePath,
      `module.exports.plugin = {
        dispatch({ context }) {
          setImmediate(() => context.capability("kv.state", { key: "late" }));
          return { ok: true, value: "returned" };
        }
      };\n`
    );

    assert.throws(
      () =>
        dispatchBundleInChild(
          bundlePath,
          {
            hookName: "ticket.created",
            payload: {},
            capabilityCalls: [
              { name: "kv.state", input: { key: "late" }, result: { value: "ignored" } }
            ]
          },
          "post-return-capability"
        ),
      /invoked a capability after dispatch returned/
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

    runSubmissionCommand("pnpm", submissionInstallArguments(pluginDirectory, pnpmStoreDirectory), {
      label: `${submission} install`
    });
    // Restore the digest-bound metadata before build and audit; install-only tarball overrides must
    // never become a sanitized substitute for the package consumers receive.
    await writeFile(packageJsonPath, submittedPackageJson);
    const cliBinDirectory = await createCliShim(tempRoot);
    // The build is the authority for audited outputs; prove the copied submission and offline
    // install did not pre-populate artifacts that a no-op build could silently reuse.
    await assert.rejects(readFile(join(pluginDirectory, "manifest.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(pluginDirectory, "dist", "plugin.cjs")), { code: "ENOENT" });
    runSubmissionCommand("pnpm", ["--dir", pluginDirectory, "exec", "tsc", "--noEmit"], {
      label: `${submission} typecheck`
    });
    runSubmissionCommand("pnpm", ["--dir", pluginDirectory, "build"], {
      label: `${submission} build`,
      pathPrefix: cliBinDirectory
    });
    const manifestJson = await readFile(join(pluginDirectory, "manifest.json"), "utf8");
    const bundlePath = join(pluginDirectory, "dist", "plugin.cjs");
    await readFile(bundlePath, "utf8");
    const manifest = JSON.parse(manifestJson);
    assertManifestMatchesSubmission(manifest, metadata);
    const report = JSON.parse(
      runSubmissionCommand(
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
        { cwd: pluginDirectory, label: `${submission} audit`, pathPrefix: cliBinDirectory }
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
          payload: behaviorCase.payload,
          capabilityCalls: behaviorCase.capabilityCalls
        },
        behaviorCase.name
      );
      assert.deepEqual(outcome.result, behaviorCase.expected, behaviorCase.name);
      assert.deepEqual(
        outcome.capabilityCalls,
        behaviorCase.capabilityCalls.map(({ name, input }) => ({ name, input })),
        `${behaviorCase.name} capability calls must match the packet`
      );
    }
    // Run the required behavior-test file explicitly so a future package-script drift cannot turn
    // the evidence command into a no-op while leaving an unexecuted test in the digest map.
    runSubmissionCommand(
      "pnpm",
      ["--dir", pluginDirectory, "exec", "vitest", "run", "test/plugin.test.ts"],
      { label: `${submission} required behavior test` }
    );
    runSubmissionCommand("pnpm", ["--dir", pluginDirectory, "test"], {
      label: `${submission} canonical test`
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function dispatchBundleInChild(bundlePath, request, caseName) {
  const authenticationKey = randomBytes(32);
  const input = JSON.stringify({
    authenticationKey: authenticationKey.toString("base64url"),
    request
  });
  // spawnSync enforces its timeout outside the submitted JavaScript event loop. SIGKILL cannot be
  // intercepted by a synchronous loop, so the per-case limit remains real for hostile CPU behavior.
  const child = spawnSync(process.execPath, [bundleRunnerPath, bundlePath], {
    encoding: "utf8",
    env: submissionEnvironment(),
    input,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    timeout: 2_000
  });
  if (child.error?.code === "ETIMEDOUT") {
    assert.fail(`${caseName} exceeded the 2 second dispatch limit`);
  }
  assert.equal(child.signal, null, `${caseName} bundle runner exited by signal`);
  assert.equal(child.status, 0, `${caseName} bundle runner failed`);
  let authenticatedResult;
  for (const match of child.stdout.matchAll(
    /TENANTSCRIPT_BUNDLE_RESULT:([A-Za-z0-9_-]+):([0-9a-f]{64})/gu
  )) {
    const [, encodedResult, signature] = match;
    const expectedSignature = createHmac("sha256", authenticationKey)
      .update(encodedResult)
      .digest();
    if (timingSafeEqual(Buffer.from(signature, "hex"), expectedSignature)) {
      authenticatedResult = deserialize(Buffer.from(encodedResult, "base64url"));
    }
  }
  assert.notEqual(authenticatedResult, undefined, `${caseName} bundle runner returned no result`);
  const { pendingAsyncWork, postReturnCapabilityCall, ...outcome } = authenticatedResult;
  assert.equal(pendingAsyncWork, false, `${caseName} left asynchronous work pending`);
  assert.equal(
    postReturnCapabilityCall,
    false,
    `${caseName} invoked a capability after dispatch returned`
  );
  return outcome;
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

function runSubmissionCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const label = options.label ?? "submitted command";
  // spawnSync owns the deadline outside submitted JavaScript. SIGKILL and a minimal environment
  // keep an infinite loop or inherited maintainer credential from escaping the accountless lane.
  const child = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: submissionEnvironment(options.pathPrefix),
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs
  });
  if (child.error?.code === "ETIMEDOUT") {
    throw new Error(`${label} exceeded the ${timeoutMs} ms submitted-command limit`);
  }
  if (child.error || child.signal !== null || child.status !== 0) {
    // Submitted output can contain attacker-selected repository data, so keep CI diagnostics stable
    // and non-reflective while the trusted label identifies the failing contract stage.
    throw new Error(`${label} failed`);
  }
  return child.stdout;
}

function submissionEnvironment(pathPrefix) {
  const inheritedPath = process.env.PATH ?? "";
  return {
    CI: "1",
    PATH: pathPrefix ? `${pathPrefix}${delimiter}${inheritedPath}` : inheritedPath
  };
}
