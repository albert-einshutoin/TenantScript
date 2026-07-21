import { parseManifest } from "@tenantscript/manifest";

export type PluginAuditFindingCode =
  | "bundle_capability_undeclared"
  | "bundle_capability_usage_dynamic"
  | "bundle_direct_egress_detected"
  | "bundle_grant_potentially_unused"
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
  certainty: "exact" | "heuristic";
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
  bundleCode?: string;
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
  bundle_capability_undeclared:
    "bundle contains a static capability call without a matching manifest grant",
  bundle_capability_usage_dynamic:
    "bundle uses a dynamic capability name that cannot be compared with manifest grants",
  bundle_direct_egress_detected:
    "bundle contains a direct fetch call that requires egress bypass review",
  bundle_grant_potentially_unused:
    "manifest grant has no matching static capability call in the bundle",
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
  if (request.bundleCode !== undefined && typeof request.bundleCode !== "string") {
    throw new TypeError("plugin audit input is invalid");
  }

  if (manifest.ok) {
    if (manifest.value.limits.cpuMs > 50) {
      findings.push(finding("runtime_cpu_limit_high", "warning", "manifest.limits.cpuMs"));
    }
    if (manifest.value.limits.timeoutMs > 500) {
      findings.push(finding("runtime_timeout_limit_high", "warning", "manifest.limits.timeoutMs"));
    }
    if (request.bundleCode !== undefined) {
      findings.push(...auditBundle(request.bundleCode, Object.keys(manifest.value.capabilities)));
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
  path: string,
  certainty: PluginAuditFinding["certainty"] = "exact"
): PluginAuditFinding {
  return { code, severity, certainty, path, message: messages[code] };
}

interface BundleToken {
  kind: "identifier" | "punctuation" | "string";
  value: string;
  literalValid?: boolean;
}

function auditBundle(bundleCode: string, grants: readonly string[]): PluginAuditFinding[] {
  const tokens = tokenizeBundle(bundleCode);
  const staticCalls = new Set<string>();
  let hasDynamicCapabilityCall = false;
  let hasDirectEgressCall = false;

  for (let index = 0; index < tokens.length; index += 1) {
    if (matchesTokenSequence(tokens, index, ["context", ".", "capability", "("])) {
      const argument = tokens[index + 4];
      if (argument?.kind === "string" && argument.literalValid === true) {
        staticCalls.add(argument.value);
      } else {
        hasDynamicCapabilityCall = true;
      }
    }
    if (
      matchesTokenSequence(tokens, index, ["globalThis", ".", "fetch", "("]) ||
      (tokens[index]?.value === "fetch" &&
        tokens[index + 1]?.value === "(" &&
        tokens[index - 1]?.value !== ".")
    ) {
      hasDirectEgressCall = true;
    }
  }

  const grantSet = new Set(grants);
  const findings: PluginAuditFinding[] = [];
  if ([...staticCalls].some((name) => !grantSet.has(name))) {
    findings.push(
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
    );
  }
  if (hasDynamicCapabilityCall) {
    findings.push(
      finding("bundle_capability_usage_dynamic", "warning", "bundle.capabilityCalls.*", "heuristic")
    );
  } else if (grants.some((name) => !staticCalls.has(name))) {
    findings.push(
      finding("bundle_grant_potentially_unused", "warning", "manifest.capabilities.*", "heuristic")
    );
  }
  if (hasDirectEgressCall) {
    findings.push(
      finding("bundle_direct_egress_detected", "warning", "bundle.egressCalls.*", "heuristic")
    );
  }
  return findings;
}

function tokenizeBundle(source: string): BundleToken[] {
  const tokens: BundleToken[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === "/" && next === "/") {
      index = skipLineComment(source, index + 2);
    } else if (character === "/" && next === "*") {
      index = skipBlockComment(source, index + 2);
    } else if (character === "/" && isRegexLiteralStart(source, index, tokens)) {
      index = skipRegexLiteral(source, index + 1);
    } else if (character === '"' || character === "'") {
      const stringToken = readStringToken(source, index, character);
      tokens.push(stringToken.token);
      index = stringToken.nextIndex;
    } else if (character === "`") {
      // Template expressions can execute arbitrary code, so omitting their internals is why
      // absence-based bundle findings remain explicitly heuristic rather than a safety proof.
      index = skipQuoted(source, index + 1, "`");
    } else if (character !== undefined && /[A-Za-z_$]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/u.test(source[index] ?? "")) index += 1;
      tokens.push({ kind: "identifier", value: source.slice(start, index) });
    } else {
      if (character !== undefined && ".(),".includes(character)) {
        tokens.push({ kind: "punctuation", value: character });
      }
      index += 1;
    }
  }
  return tokens;
}

function readStringToken(
  source: string,
  start: number,
  quote: '"' | "'"
): { token: BundleToken; nextIndex: number } {
  let index = start + 1;
  let value = "";
  let valid = true;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      const escape = readStringEscape(source, index);
      value += escape.value;
      valid &&= escape.valid;
      index = escape.nextIndex;
    } else if (character === quote) {
      return {
        token: { kind: "string", value: valid ? value : "", literalValid: valid },
        nextIndex: index + 1
      };
    } else {
      value += character ?? "";
      index += 1;
    }
  }
  return {
    token: { kind: "string", value: "", literalValid: false },
    nextIndex: source.length
  };
}

function readStringEscape(
  source: string,
  slashIndex: number
): { value: string; nextIndex: number; valid: boolean } {
  // Decode only JavaScript's deterministic literal escapes here. Treat malformed and legacy
  // octal forms as dynamic so the audit never upgrades uncertain source into an exact finding.
  const escaped = source[slashIndex + 1];
  if (escaped === undefined) return { value: "", nextIndex: source.length, valid: false };

  const simpleEscapes: Record<string, string> = {
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v"
  };
  if (escaped in simpleEscapes) {
    return { value: simpleEscapes[escaped] ?? "", nextIndex: slashIndex + 2, valid: true };
  }
  if (escaped === "\n") return { value: "", nextIndex: slashIndex + 2, valid: true };
  if (escaped === "\r") {
    return {
      value: "",
      nextIndex: source[slashIndex + 2] === "\n" ? slashIndex + 3 : slashIndex + 2,
      valid: true
    };
  }
  if (escaped === "x") {
    return readHexEscape(source, 2, slashIndex + 2);
  }
  if (escaped === "u") {
    if (source[slashIndex + 2] === "{") {
      const end = source.indexOf("}", slashIndex + 3);
      const digits = end === -1 ? "" : source.slice(slashIndex + 3, end);
      const codePoint = /^[0-9a-fA-F]{1,6}$/u.test(digits) ? Number.parseInt(digits, 16) : -1;
      if (end === -1 || codePoint > 0x10ffff) {
        return { value: "", nextIndex: end === -1 ? source.length : end + 1, valid: false };
      }
      return { value: String.fromCodePoint(codePoint), nextIndex: end + 1, valid: true };
    }
    return readHexEscape(source, 4, slashIndex + 2);
  }
  if (escaped === "0" && /[0-9]/u.test(source[slashIndex + 2] ?? "")) {
    return { value: "", nextIndex: slashIndex + 2, valid: false };
  }
  if (/[1-9]/u.test(escaped)) {
    return { value: "", nextIndex: slashIndex + 2, valid: false };
  }
  return { value: escaped === "0" ? "\0" : escaped, nextIndex: slashIndex + 2, valid: true };
}

function readHexEscape(
  source: string,
  length: number,
  digitsStart: number
): { value: string; nextIndex: number; valid: boolean } {
  const digits = source.slice(digitsStart, digitsStart + length);
  if (digits.length !== length || !/^[0-9a-fA-F]+$/u.test(digits)) {
    return { value: "", nextIndex: digitsStart + digits.length, valid: false };
  }
  return {
    value: String.fromCodePoint(Number.parseInt(digits, 16)),
    nextIndex: digitsStart + length,
    valid: true
  };
}

function skipLineComment(source: string, start: number): number {
  const newline = source.indexOf("\n", start);
  return newline === -1 ? source.length : newline + 1;
}

function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf("*/", start);
  return end === -1 ? source.length : end + 2;
}

function isRegexLiteralStart(
  source: string,
  slashIndex: number,
  tokens: readonly BundleToken[]
): boolean {
  let index = slashIndex - 1;
  while (index >= 0 && /\s/u.test(source[index] ?? "")) index -= 1;
  if (index < 0 || "=(:,[!&|?;{}>".includes(source[index] ?? "")) return true;
  return ["return", "throw", "case"].includes(tokens.at(-1)?.value ?? "");
}

function skipRegexLiteral(source: string, start: number): number {
  let index = start;
  let insideCharacterClass = false;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") index += 2;
    else if (character === "[") {
      insideCharacterClass = true;
      index += 1;
    } else if (character === "]") {
      insideCharacterClass = false;
      index += 1;
    } else if (character === "/" && !insideCharacterClass) {
      index += 1;
      while (index < source.length && /[A-Za-z]/u.test(source[index] ?? "")) index += 1;
      return index;
    } else index += 1;
  }
  return source.length;
}

function skipQuoted(source: string, start: number, quote: string): number {
  let index = start;
  while (index < source.length) {
    if (source[index] === "\\") index += 2;
    else if (source[index] === quote) return index + 1;
    else index += 1;
  }
  return source.length;
}

function matchesTokenSequence(
  tokens: readonly BundleToken[],
  start: number,
  values: readonly string[]
): boolean {
  return values.every((value, offset) => tokens[start + offset]?.value === value);
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
