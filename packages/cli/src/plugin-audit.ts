import { parseManifest } from "@tenantscript/manifest";

export type PluginAuditFindingCode =
  | "manifest_invalid"
  | "plugin_sdk_declaration_ambiguous"
  | "plugin_sdk_missing"
  | "plugin_sdk_version_mismatch"
  | "plugin_sdk_version_unpinned"
  | "plugin_tests_missing"
  | "runtime_cpu_limit_high"
  | "runtime_timeout_limit_high";

export interface PluginAuditFinding {
  code: PluginAuditFindingCode;
  severity: "error" | "warning";
  certainty: "exact";
  path: string;
  message: string;
}

export interface PluginAuditReportV1 {
  version: 1;
  passed: boolean;
  findings: readonly PluginAuditFinding[];
}

export interface PluginAuditRequest {
  manifest: unknown;
  packageJson: unknown;
  expectedSdkVersion: string;
}

const exactPackageVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const pluginSdkName = "@tenantscript/plugin-sdk";
const manifestPathSegments = new Set([
  "capabilities",
  "configSchema",
  "cpuMs",
  "default",
  "egress",
  "hooks",
  "hosts",
  "limits",
  "mode",
  "name",
  "priority",
  "properties",
  "required",
  "schemaVersionRange",
  "timeoutMs",
  "type",
  "version"
]);

const messages: Record<PluginAuditFindingCode, string> = {
  manifest_invalid: "manifest does not satisfy the closed TenantScript schema",
  plugin_sdk_declaration_ambiguous: "plugin SDK must be declared in exactly one dependency section",
  plugin_sdk_missing: "plugin SDK dependency is required",
  plugin_sdk_version_mismatch: "plugin SDK version does not match the auditing CLI version",
  plugin_sdk_version_unpinned: "plugin SDK dependency must use an exact version",
  plugin_tests_missing: "package must define a non-empty test script",
  runtime_cpu_limit_high: "CPU limit exceeds the scaffold review baseline",
  runtime_timeout_limit_high: "timeout limit exceeds the scaffold review baseline"
};

export function auditPluginPackage(request: PluginAuditRequest): PluginAuditReportV1 {
  if (!exactPackageVersionPattern.test(request.expectedSdkVersion)) {
    throw new TypeError("plugin audit input is invalid");
  }
  const packageJson = parsePackageJson(request.packageJson);
  const findings: PluginAuditFinding[] = [];
  const manifest = parseManifest(request.manifest);

  if (manifest.ok) {
    if (manifest.value.limits.cpuMs > 50) {
      findings.push(finding("runtime_cpu_limit_high", "warning", "manifest.limits.cpuMs"));
    }
    if (manifest.value.limits.timeoutMs > 500) {
      findings.push(finding("runtime_timeout_limit_high", "warning", "manifest.limits.timeoutMs"));
    }
  } else {
    for (const issue of manifest.errors) {
      findings.push(
        finding(
          "manifest_invalid",
          "error",
          issue.path.length === 0 ? "manifest" : `manifest.${sanitizeManifestPath(issue.path)}`
        )
      );
    }
  }

  if (!isNonEmptyString(packageJson.scripts?.test)) {
    findings.push(finding("plugin_tests_missing", "error", "package.scripts.test"));
  }

  const dependencyVersion = packageJson.dependencies?.[pluginSdkName];
  const developmentVersion = packageJson.devDependencies?.[pluginSdkName];
  const sdkPath =
    dependencyVersion === undefined
      ? `package.devDependencies.${pluginSdkName}`
      : `package.dependencies.${pluginSdkName}`;
  if (dependencyVersion !== undefined && developmentVersion !== undefined) {
    findings.push(finding("plugin_sdk_declaration_ambiguous", "error", sdkPath));
  } else {
    const version = dependencyVersion ?? developmentVersion;
    if (version === undefined) {
      findings.push(
        finding("plugin_sdk_missing", "error", `package.dependencies.${pluginSdkName}`)
      );
    } else if (!exactPackageVersionPattern.test(version)) {
      findings.push(finding("plugin_sdk_version_unpinned", "error", sdkPath));
    } else if (version !== request.expectedSdkVersion) {
      findings.push(finding("plugin_sdk_version_mismatch", "error", sdkPath));
    }
  }

  // Exact metadata findings must be stable before heuristic bundle rules are added. This keeps
  // automation deterministic and prevents a future best-effort rule from masquerading as proof.
  findings.sort(
    (left, right) =>
      severityRank(left.severity) - severityRank(right.severity) ||
      compareText(left.code, right.code) ||
      compareText(left.path, right.path)
  );
  return {
    version: 1,
    passed: findings.every((entry) => entry.severity !== "error"),
    findings
  };
}

interface AuditedPackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function parsePackageJson(value: unknown): AuditedPackageJson {
  if (!isRecord(value)) throw new TypeError("plugin audit input is invalid");
  return {
    ...(value.scripts === undefined ? {} : { scripts: parseStringRecord(value.scripts) }),
    ...(value.dependencies === undefined
      ? {}
      : { dependencies: parseStringRecord(value.dependencies) }),
    ...(value.devDependencies === undefined
      ? {}
      : { devDependencies: parseStringRecord(value.devDependencies) })
  };
}

function parseStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new TypeError("plugin audit input is invalid");
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new TypeError("plugin audit input is invalid");
    output[key] = entry;
  }
  return output;
}

function finding(
  code: PluginAuditFindingCode,
  severity: PluginAuditFinding["severity"],
  path: string
): PluginAuditFinding {
  return { code, severity, certainty: "exact", path, message: messages[code] };
}

function severityRank(value: PluginAuditFinding["severity"]): number {
  return value === "error" ? 0 : 1;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sanitizeManifestPath(path: string): string {
  const segments = path.split(".");
  return segments
    .map((segment, index) => {
      const parentPath = segments.slice(0, index).join(".");
      // Record keys are tenant-controlled, so schema context must win over a segment allowlist.
      // Otherwise a key such as "version" can masquerade as a stable structural path segment.
      if (parentPath === "capabilities" || parentPath === "configSchema.properties") return "*";
      return /^\d+$/u.test(segment) || manifestPathSegments.has(segment) ? segment : "*";
    })
    .join(".");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
