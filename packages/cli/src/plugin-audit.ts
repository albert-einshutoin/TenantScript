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

const tokenPairCache = new WeakMap<readonly BundleToken[], ReadonlyMap<number, number>>();

function auditBundle(bundleCode: string, grants: readonly string[]): PluginAuditFinding[] {
  const tokens = tokenizeBundle(bundleCode);
  const capabilityBindings = collectCapabilityBindings(tokens);
  const staticCalls = new Set<string>();
  let hasDynamicCapabilityCall = false;
  let hasDirectEgressCall = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const isMemberCapabilityCall =
      tokens[index]?.value === "capability" &&
      tokens[index - 1]?.value === "." &&
      tokens[index - 2]?.kind === "identifier" &&
      capabilityBindings.receivers.has(tokens[index - 2]?.value ?? "") &&
      tokens[index + 1]?.value === "(";
    const isDirectCapabilityCall =
      tokens[index]?.kind === "identifier" &&
      capabilityBindings.direct.has(tokens[index]?.value ?? "") &&
      tokens[index - 1]?.value !== "." &&
      tokens[index + 1]?.value === "(";
    if (isMemberCapabilityCall || isDirectCapabilityCall) {
      const argument = tokens[index + 2];
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

function collectCapabilityBindings(tokens: readonly BundleToken[]): {
  receivers: Set<string>;
  direct: Set<string>;
} {
  // PluginContext is a structural SDK type, so neither bundlers nor authors must preserve the
  // local name `context`. Deriving bindings from handler parameters avoids classifying unrelated
  // dependency methods named `capability` as exact SDK broker calls.
  const receivers = new Set(["context"]);
  const direct = new Set<string>();
  registerHandlerContextParameters(tokens, receivers, direct);

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value !== "{") continue;
    const close = findMatchingToken(tokens, index, "{", "}");
    if (
      close !== -1 &&
      tokens[close + 1]?.value === "=" &&
      tokens[close + 2]?.kind === "identifier" &&
      receivers.has(tokens[close + 2]?.value ?? "")
    ) {
      registerDestructuredCapability(tokens.slice(index + 1, close), direct);
    }
  }
  return { receivers, direct };
}

function registerHandlerContextParameters(
  tokens: readonly BundleToken[],
  receivers: Set<string>,
  direct: Set<string>
): void {
  const namedFunctions = new Map<string, { open: number; close: number }>();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value !== "function" || tokens[index + 1]?.kind !== "identifier") continue;
    const open = index + 2;
    if (tokens[open]?.value !== "(") continue;
    const close = findMatchingToken(tokens, open, "(", ")");
    if (close !== -1) namedFunctions.set(tokens[index + 1]?.value ?? "", { open, close });
  }

  for (let index = 0; index < tokens.length; index += 1) {
    if (
      tokens[index]?.value !== "handlers" ||
      ![":", "="].includes(tokens[index + 1]?.value ?? "") ||
      tokens[index + 2]?.value !== "{"
    ) {
      continue;
    }
    const handlersClose = findMatchingToken(tokens, index + 2, "{", "}");
    if (handlersClose === -1) continue;
    let depth = 0;
    for (let field = index + 3; field < handlersClose; field += 1) {
      if (depth === 0) {
        // Object-method handlers have no colon, so recognize only a direct property name followed
        // by parameters and a body. Requiring the body avoids treating `event: factory(a, b)` as
        // a handler declaration and accidentally trusting an unrelated second argument.
        let methodOpen = -1;
        const startsObjectField = ["{", ","].includes(tokens[field - 1]?.value ?? "");
        if (
          startsObjectField &&
          tokens[field]?.kind === "identifier" &&
          tokens[field + 1]?.value === "("
        ) {
          methodOpen = field + 1;
        } else if (
          startsObjectField &&
          tokens[field]?.value === "async" &&
          tokens[field + 1]?.kind === "identifier" &&
          tokens[field + 2]?.value === "("
        ) {
          methodOpen = field + 2;
        }
        if (methodOpen !== -1) {
          const methodClose = findMatchingToken(tokens, methodOpen, "(", ")");
          if (methodClose !== -1 && tokens[methodClose + 1]?.value === "{") {
            registerSecondContextParameter(tokens, methodOpen, methodClose, receivers, direct);
          }
        }
      }
      if (tokens[field]?.value === "{") depth += 1;
      else if (tokens[field]?.value === "}") depth = Math.max(0, depth - 1);
      if (depth !== 0 || tokens[field]?.value !== ":") continue;

      let value = field + 1;
      if (tokens[value]?.value === "async") value += 1;
      if (tokens[value]?.value === "function") {
        if (tokens[value + 1]?.kind === "identifier") value += 1;
        const open = value + 1;
        const close = tokens[open]?.value === "(" ? findMatchingToken(tokens, open, "(", ")") : -1;
        if (close !== -1) registerSecondContextParameter(tokens, open, close, receivers, direct);
      } else if (tokens[value]?.value === "(") {
        const close = findMatchingToken(tokens, value, "(", ")");
        if (close !== -1 && tokens[close + 1]?.value === "=" && tokens[close + 2]?.value === ">") {
          registerSecondContextParameter(tokens, value, close, receivers, direct);
        }
      } else if (tokens[value]?.kind === "identifier") {
        const named = namedFunctions.get(tokens[value]?.value ?? "");
        if (named !== undefined) {
          registerSecondContextParameter(tokens, named.open, named.close, receivers, direct);
        }
      }
    }
    index = handlersClose;
  }
}

function registerSecondContextParameter(
  tokens: readonly BundleToken[],
  open: number,
  close: number,
  receivers: Set<string>,
  direct: Set<string>
): void {
  const parameters = splitTopLevel(tokens.slice(open + 1, close), ",");
  const contextParameter = parameters[1];
  if (contextParameter?.[0]?.kind === "identifier") {
    receivers.add(contextParameter[0].value);
  } else if (contextParameter?.[0]?.value === "{") {
    registerDestructuredCapability(contextParameter.slice(1, -1), direct);
  }
}

function registerDestructuredCapability(tokens: readonly BundleToken[], direct: Set<string>): void {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value !== "capability") continue;
    const alias = tokens[index + 1]?.value === ":" ? tokens[index + 2] : undefined;
    direct.add(alias?.kind === "identifier" ? alias.value : "capability");
  }
}

function splitTopLevel(tokens: readonly BundleToken[], delimiter: string): BundleToken[][] {
  const output: BundleToken[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (["(", "{", "["].includes(token.value)) depth += 1;
    else if ([")", "}", "]"].includes(token.value)) depth = Math.max(0, depth - 1);
    if (token.value === delimiter && depth === 0) output.push([]);
    else output.at(-1)?.push(token);
  }
  return output;
}

function findMatchingToken(
  tokens: readonly BundleToken[],
  openIndex: number,
  open: string,
  close: string
): number {
  let pairs = tokenPairCache.get(tokens);
  if (pairs === undefined) {
    pairs = buildTokenPairs(tokens);
    tokenPairCache.set(tokens, pairs);
  }
  const closeIndex = pairs.get(openIndex);
  return tokens[openIndex]?.value === open && tokens[closeIndex ?? -1]?.value === close
    ? (closeIndex ?? -1)
    : -1;
}

function buildTokenPairs(tokens: readonly BundleToken[]): ReadonlyMap<number, number> {
  // Pair delimiters once so malformed input at the 4 MiB limit cannot turn repeated handler and
  // destructuring probes into quadratic scans.
  const pairs = new Map<number, number>();
  const stack: Array<{ index: number; value: string }> = [];
  const expectedOpen: Record<string, string> = { ")": "(", "}": "{", "]": "[" };
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index]?.value ?? "";
    if (["(", "{", "["].includes(value)) {
      stack.push({ index, value });
    } else if (value in expectedOpen && stack.at(-1)?.value === expectedOpen[value]) {
      const opening = stack.pop();
      if (opening !== undefined) pairs.set(opening.index, index);
    }
  }
  return pairs;
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
      if (character !== undefined && ".(),{}:[]=>".includes(character)) {
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
