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

  it.each([
    ["missing manifest", ["audit", "--package", "package.json"]],
    [
      "unknown flag",
      ["audit", "--manifest", "manifest.json", "--package", "package.json", "--token", "secret"]
    ],
    [
      "duplicate flag",
      ["audit", "--manifest", "a.json", "--manifest", "b.json", "--package", "package.json"]
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

function finding(code: string, severity: "error" | "warning", path: string) {
  const messages: Record<string, string> = {
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
  return { code, severity, certainty: "exact", path, message };
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
