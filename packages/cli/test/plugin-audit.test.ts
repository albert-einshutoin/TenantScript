import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditPluginPackage, runExtCli, type CliIo, type RollbackClient } from "../src/index.js";
import { readCliPackageVersion } from "../src/plugin-scaffold.js";

const tempDirs: string[] = [];

describe("plugin audit", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("accepts a manifest and package pinned to the audited SDK version", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3"
      })
    ).toEqual({ version: 1, passed: true, findings: [] });
  });

  it("accepts a statically declared capability used through the broker", () => {
    const manifest = validManifest();
    manifest.capabilities = { "slack.send": {} };

    expect(
      auditPluginPackage({
        manifest,
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: 'async function run(context) { await context.capability("slack.send", {}); }'
      })
    ).toEqual({ version: 1, passed: true, findings: [] });
  });

  it("reports unused, undeclared, dynamic, and direct egress bundle risks", () => {
    const manifest = validManifest();
    manifest.capabilities = { "slack.send": {}, "email.send": {} };

    expect(
      auditPluginPackage({
        manifest,
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode:
          'context.capability("slack.send", {}); context.capability("github.issue.create", {}); fetch("https://example.invalid");'
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact"),
      finding("bundle_direct_egress_detected", "warning", "bundle.egressCalls.*", "heuristic"),
      finding("bundle_grant_potentially_unused", "warning", "manifest.capabilities.*", "heuristic")
    ]);

    expect(
      auditPluginPackage({
        manifest,
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: "context.capability(capabilityName, {});"
      }).findings
    ).toEqual([
      finding("bundle_capability_usage_dynamic", "warning", "bundle.capabilityCalls.*", "heuristic")
    ]);
  });

  it("keeps bundle finding order stable when call order changes", () => {
    const manifest = validManifest();
    manifest.capabilities = { "email.send": {} };
    const request = {
      manifest,
      packageJson: validPackageJson(),
      expectedSdkVersion: "1.2.3"
    };
    const first = auditPluginPackage({
      ...request,
      bundleCode: 'fetch("https://example.invalid"); context.capability("slack.send", {});'
    });
    const second = auditPluginPackage({
      ...request,
      bundleCode: 'context.capability("slack.send", {}); fetch("https://example.invalid");'
    });

    expect(first).toEqual(second);
  });

  it("ignores call-shaped text in comments and strings without reflecting capability names", () => {
    const manifest = validManifest();
    manifest.capabilities = { "secret.sentinel": {} };
    const bundleCode = [
      '// fetch("https://example.invalid")',
      "const note = 'context.capability(\"secret.sentinel\", {})';",
      'context.capability("secret.sentinel", {});'
    ].join("\n");

    const report = auditPluginPackage({
      manifest,
      packageJson: validPackageJson(),
      expectedSdkVersion: "1.2.3",
      bundleCode
    });

    expect(report.findings).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("secret.sentinel");
  });

  it("detects global fetch while ignoring unrelated fetch methods and block comments", () => {
    const report = auditPluginPackage({
      manifest: validManifest(),
      packageJson: validPackageJson(),
      expectedSdkVersion: "1.2.3",
      bundleCode: [
        '/* globalThis.fetch("https://comment.invalid") */',
        'client.fetch("https://broker.invalid");',
        'globalThis.fetch("https://direct.invalid");'
      ].join("\n")
    });

    expect(report.findings).toEqual([
      finding("bundle_direct_egress_detected", "warning", "bundle.egressCalls.*", "heuristic")
    ]);
  });

  it("reports deterministic exact findings without reflecting input values", () => {
    const secretSentinel = "secret_SENTINEL_do_not_reflect";
    const report = auditPluginPackage({
      manifest: {
        ...validManifest(),
        name: secretSentinel,
        limits: { cpuMs: 51, timeoutMs: 501 }
      },
      packageJson: { scripts: {}, dependencies: {} },
      expectedSdkVersion: "1.2.3"
    });

    expect(report).toEqual({
      version: 1,
      passed: false,
      findings: [
        finding("manifest_invalid", "error", "manifest.name"),
        finding("plugin_sdk_missing", "error", "package.dependencies.@tenantscript/plugin-sdk"),
        finding("plugin_tests_missing", "error", "package.scripts.test")
      ]
    });
    expect(JSON.stringify(report)).not.toContain(secretSentinel);
  });

  it("redacts user-controlled manifest keys from finding paths", () => {
    const secretSentinel = "secret_SENTINEL_capability_key";
    const report = auditPluginPackage({
      manifest: {
        ...validManifest(),
        capabilities: { [secretSentinel]: {} }
      },
      packageJson: validPackageJson(),
      expectedSdkVersion: "1.2.3"
    });

    expect(report.findings).toEqual([
      finding("manifest_invalid", "error", "manifest.capabilities.*")
    ]);
    expect(JSON.stringify(report)).not.toContain(secretSentinel);
  });

  it("redacts user-controlled keys even when they match structural path names", () => {
    const report = auditPluginPackage({
      manifest: {
        ...validManifest(),
        capabilities: { version: {} },
        configSchema: {
          properties: { version: { type: "boolean", default: "invalid" } },
          required: []
        }
      },
      packageJson: validPackageJson(),
      expectedSdkVersion: "1.2.3"
    });

    expect(report.findings).toEqual([
      finding("manifest_invalid", "error", "manifest.capabilities.*"),
      finding("manifest_invalid", "error", "manifest.configSchema.properties.*.default")
    ]);
  });

  it.each(["latest", "^1.2.3", "workspace:*", "1.2.3 || 2.0.0"])(
    "rejects the unpinned SDK declaration %s",
    (version) => {
      const report = auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(version),
        expectedSdkVersion: "1.2.3"
      });

      expect(report.findings).toEqual([
        finding(
          "plugin_sdk_version_unpinned",
          "error",
          "package.dependencies.@tenantscript/plugin-sdk"
        )
      ]);
    }
  );

  it("separates SDK mismatch errors from limit review warnings", () => {
    const report = auditPluginPackage({
      manifest: { ...validManifest(), limits: { cpuMs: 51, timeoutMs: 501 } },
      packageJson: validPackageJson("1.2.4"),
      expectedSdkVersion: "1.2.3"
    });

    expect(report).toEqual({
      version: 1,
      passed: false,
      findings: [
        finding(
          "plugin_sdk_version_mismatch",
          "error",
          "package.dependencies.@tenantscript/plugin-sdk"
        ),
        finding("runtime_cpu_limit_high", "warning", "manifest.limits.cpuMs"),
        finding("runtime_timeout_limit_high", "warning", "manifest.limits.timeoutMs")
      ]
    });
  });

  it("accepts one exact development SDK declaration and rejects duplicate ownership", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: {
          scripts: { test: "vitest run" },
          devDependencies: { "@tenantscript/plugin-sdk": "1.2.3" }
        },
        expectedSdkVersion: "1.2.3"
      }).findings
    ).toEqual([]);

    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: {
          ...validPackageJson(),
          devDependencies: { "@tenantscript/plugin-sdk": "1.2.3" }
        },
        expectedSdkVersion: "1.2.3"
      }).findings
    ).toEqual([
      finding(
        "plugin_sdk_declaration_ambiguous",
        "error",
        "package.dependencies.@tenantscript/plugin-sdk"
      )
    ]);
  });

  it("returns exit zero for warning-only reports and exit one for errors", async () => {
    const root = await createTempDir();
    const manifest = join(root, "manifest.json");
    const packageJson = join(root, "package.json");
    const cliVersion = await readCliPackageVersion();
    await writeFile(
      manifest,
      JSON.stringify({ ...validManifest(), limits: { cpuMs: 51, timeoutMs: 501 } })
    );
    await writeFile(packageJson, JSON.stringify(validPackageJson(cliVersion)));
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(
      runExtCli(
        ["audit", "--manifest", manifest, "--package", packageJson],
        rollbackOnlyClient,
        captureIo(stdout, stderr)
      )
    ).resolves.toBe(0);
    expect(JSON.parse(stdout[0] ?? "null")).toMatchObject({ version: 1, passed: true });
    expect(stderr).toEqual([]);

    await writeFile(packageJson, JSON.stringify({ dependencies: {} }));
    stdout.length = 0;
    await expect(
      runExtCli(
        ["audit", "--manifest", manifest, "--package", packageJson],
        rollbackOnlyClient,
        captureIo(stdout, stderr)
      )
    ).resolves.toBe(1);
    expect(JSON.parse(stdout[0] ?? "null")).toMatchObject({ version: 1, passed: false });
  });

  it("accepts bounded bundle input and rejects undeclared static capability calls", async () => {
    const root = await createTempDir();
    const manifest = join(root, "manifest.json");
    const packageJson = join(root, "package.json");
    const bundle = join(root, "plugin.js");
    const cliVersion = await readCliPackageVersion();
    await writeFile(manifest, JSON.stringify(validManifest()));
    await writeFile(packageJson, JSON.stringify(validPackageJson(cliVersion)));
    await writeFile(bundle, 'context.capability("slack.send", {});');
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(
      runExtCli(
        ["audit", "--manifest", manifest, "--package", packageJson, "--bundle", bundle],
        rollbackOnlyClient,
        captureIo(stdout, stderr)
      )
    ).resolves.toBe(1);
    expect(JSON.parse(stdout[0] ?? "null")).toMatchObject({
      version: 1,
      passed: false,
      findings: [{ code: "bundle_capability_undeclared", certainty: "exact" }]
    });
    expect(stderr).toEqual([]);
  });

  it.each([
    ["oversized", "x".repeat(512 * 1024 + 1)],
    ["binary", Buffer.from([0, 1, 2, 3])]
  ])("rejects %s bundle input without reflecting content", async (_name, bundleContent) => {
    const root = await createTempDir();
    const manifest = join(root, "manifest.json");
    const packageJson = join(root, "package.json");
    const bundle = join(root, "plugin.js");
    await writeFile(manifest, JSON.stringify(validManifest()));
    await writeFile(packageJson, JSON.stringify(validPackageJson("0.0.0")));
    await writeFile(bundle, bundleContent);
    const stderr: string[] = [];

    await expect(
      runExtCli(
        ["audit", "--manifest", manifest, "--package", packageJson, "--bundle", bundle],
        rollbackOnlyClient,
        captureIo([], stderr)
      )
    ).resolves.toBe(2);
    expect(stderr).toEqual(["plugin audit input is invalid"]);
  });

  it.each([
    ["missing manifest", ["audit", "--package", "package.json"]],
    [
      "unknown flag",
      ["audit", "--manifest", "manifest.json", "--package", "package.json", "--token", "secret"]
    ],
    [
      "duplicate flag",
      ["audit", "--manifest", "a.json", "--manifest", "b.json", "--package", "package.json"]
    ],
    [
      "duplicate optional bundle",
      [
        "audit",
        "--manifest",
        "manifest.json",
        "--package",
        "package.json",
        "--bundle",
        "a.js",
        "--bundle",
        "b.js"
      ]
    ]
  ])("rejects %s as usage without reflecting values", async (_name, argv) => {
    const stderr: string[] = [];
    await expect(runExtCli(argv, rollbackOnlyClient, captureIo([], stderr))).resolves.toBe(2);
    expect(stderr).toEqual(["invalid audit options"]);
    expect(stderr.join(" ")).not.toContain("secret");
  });

  it("rejects malformed and oversized input without reflecting file content", async () => {
    const root = await createTempDir();
    const manifest = join(root, "manifest.json");
    const packageJson = join(root, "package.json");
    await writeFile(manifest, "secret-sentinel-malformed");
    await writeFile(packageJson, JSON.stringify(validPackageJson("0.0.0")));
    const stderr: string[] = [];

    await expect(
      runExtCli(
        ["audit", "--manifest", manifest, "--package", packageJson],
        rollbackOnlyClient,
        captureIo([], stderr)
      )
    ).resolves.toBe(2);
    expect(stderr).toEqual(["plugin audit input is invalid"]);

    await writeFile(manifest, JSON.stringify({ padding: "x".repeat(70_000) }));
    stderr.length = 0;
    await expect(
      runExtCli(
        ["audit", "--manifest", manifest, "--package", packageJson],
        rollbackOnlyClient,
        captureIo([], stderr)
      )
    ).resolves.toBe(2);
    expect(stderr).toEqual(["plugin audit input is invalid"]);
  });
});

function validManifest(): Record<string, unknown> {
  return {
    name: "invoice-notify",
    version: "1.0.0",
    hooks: [
      {
        name: "invoice.created",
        type: "event",
        timeoutMs: 500,
        schemaVersionRange: "^1.0.0"
      }
    ],
    capabilities: {},
    configSchema: { properties: {}, required: [] },
    egress: { mode: "deny" },
    limits: { cpuMs: 50, timeoutMs: 500 }
  };
}

function validPackageJson(version = "1.2.3"): Record<string, unknown> {
  return {
    scripts: { test: "vitest run" },
    dependencies: { "@tenantscript/plugin-sdk": version }
  };
}

function finding(
  code: string,
  severity: "error" | "warning",
  path: string,
  certainty: "exact" | "heuristic" = "exact"
) {
  const messages: Record<string, string> = {
    bundle_capability_undeclared:
      "bundle contains a static capability call without a matching manifest grant",
    bundle_capability_usage_dynamic:
      "bundle uses a dynamic capability name that cannot be compared with manifest grants",
    bundle_direct_egress_detected:
      "bundle contains a direct fetch call that requires egress bypass review",
    bundle_grant_potentially_unused:
      "manifest grant has no matching static capability call in the bundle",
    manifest_invalid: "manifest does not satisfy the closed TenantScript schema",
    plugin_sdk_missing: "plugin SDK dependency is required",
    plugin_sdk_declaration_ambiguous:
      "plugin SDK must be declared in exactly one dependency section",
    plugin_sdk_version_mismatch: "plugin SDK version does not match the auditing CLI version",
    plugin_sdk_version_unpinned: "plugin SDK dependency must use an exact version",
    plugin_tests_missing: "package must define a non-empty test script",
    runtime_cpu_limit_high: "CPU limit exceeds the scaffold review baseline",
    runtime_timeout_limit_high: "timeout limit exceeds the scaffold review baseline"
  };
  const message = messages[code];
  if (message === undefined) throw new Error(`missing test message for ${code}`);
  return { code, severity, certainty, path, message };
}

const rollbackOnlyClient: RollbackClient = {
  rollbackInstallation: () => {
    throw new Error("rollback should not be called");
  }
};

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tenantscript-plugin-audit-"));
  tempDirs.push(dir);
  return dir;
}

function captureIo(stdout: string[], stderr: string[]): CliIo {
  return {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  };
}
