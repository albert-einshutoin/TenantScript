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

interface BindingRange {
  start: number;
  end: number;
}

interface CapabilityScope extends BindingRange {
  receivers: Set<string>;
  direct: Set<string>;
  containers: Set<string>;
}

interface CallableBinding extends BindingRange {
  open: number;
  close: number;
  singleParameter?: BundleToken;
}

const tokenPairCache = new WeakMap<readonly BundleToken[], ReadonlyMap<number, number>>();
const enclosingObjectCache = new WeakMap<readonly BundleToken[], Array<number | undefined>>();
const nonCallablePrefixes = new Set(["if", "for", "while", "switch", "catch", "with"]);

function auditBundle(bundleCode: string, grants: readonly string[]): PluginAuditFinding[] {
  const tokens = tokenizeBundle(bundleCode);
  const capabilityBindings = collectCapabilityBindings(tokens);
  const staticCalls = new Set<string>();
  let hasDynamicCapabilityCall = false;
  let hasDirectEgressCall = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const callOpen = capabilityCallOpen(tokens, index);
    const bracketReceiver = bracketedPropertyReceiverIndex(tokens, index, "capability");
    const contextContainer = contextContainerReceiverIndex(tokens, index);
    const isMemberCapabilityCall =
      tokens[index]?.value === "capability" &&
      ((((tokens[index - 1]?.value === "." && tokens[index - 2]?.kind === "identifier") ||
        bracketReceiver !== -1) &&
        bindingAppliesAt(
          capabilityBindings.receivers,
          tokens[bracketReceiver === -1 ? index - 2 : bracketReceiver]?.value ?? "",
          index
        )) ||
        (contextContainer !== -1 &&
          bindingAppliesAt(
            capabilityBindings.containers,
            tokens[contextContainer]?.value ?? "",
            index
          ))) &&
      callOpen !== -1;
    const isDirectCapabilityCall =
      tokens[index]?.kind === "identifier" &&
      bindingAppliesAt(capabilityBindings.direct, tokens[index]?.value ?? "", index) &&
      tokens[index - 1]?.value !== "." &&
      callOpen !== -1;
    if (isMemberCapabilityCall || isDirectCapabilityCall) {
      const callClose = findMatchingToken(tokens, callOpen, "(", ")");
      const argumentsList =
        callClose === -1 ? [] : splitTopLevel(tokens.slice(callOpen + 1, callClose), ",");
      const usesFunctionCall =
        tokens[callOpen - 1]?.value === "call" && tokens[callOpen - 2]?.value === ".";
      const usesFunctionApply =
        tokens[callOpen - 1]?.value === "apply" && tokens[callOpen - 2]?.value === ".";
      const argument = argumentsList[usesFunctionCall ? 1 : 0] ?? [];
      if (
        !usesFunctionApply &&
        argument.length === 1 &&
        argument[0]?.kind === "string" &&
        argument[0].literalValid
      ) {
        staticCalls.add(argument[0].value);
      } else {
        hasDynamicCapabilityCall = true;
      }
    }
    if (
      (matchesTokenSequence(tokens, index, ["globalThis", ".", "fetch"]) &&
        hasInvocationAfterMember(tokens, index + 2)) ||
      (tokens[bracketedPropertyReceiverIndex(tokens, index, "fetch")]?.value === "globalThis" &&
        hasInvocationAfterMember(tokens, index + 1)) ||
      (tokens[index]?.value === "fetch" &&
        hasInvocationAfterMember(tokens, index) &&
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

function capabilityCallOpen(tokens: readonly BundleToken[], capabilityIndex: number): number {
  const memberEnd = isStaticBracketedProperty(tokens, capabilityIndex, "capability")
    ? capabilityIndex + 1
    : capabilityIndex;
  return callOpenAfterMember(tokens, memberEnd);
}

function callOpenAfterMember(tokens: readonly BundleToken[], memberEnd: number): number {
  if (tokens[memberEnd + 1]?.value === "(") return memberEnd + 1;
  if (tokens[memberEnd + 1]?.value === ")" && tokens[memberEnd + 2]?.value === "(") {
    const groupOpen = pairedTokenIndex(tokens, memberEnd + 1);
    // Bundlers commonly detach a method with `(0, receiver.member)(...)`. Requiring the member to
    // end its balanced group avoids treating a reference elsewhere in the group as the callee.
    if (groupOpen !== undefined && tokens[groupOpen]?.value === "(") return memberEnd + 2;
  }
  if (tokens[memberEnd + 1]?.value !== ".") return -1;
  if (tokens[memberEnd + 2]?.value === "(") return memberEnd + 2;
  return ["apply", "call"].includes(tokens[memberEnd + 2]?.value ?? "") &&
    tokens[memberEnd + 3]?.value === "("
    ? memberEnd + 3
    : -1;
}

function hasInvocationAfterMember(tokens: readonly BundleToken[], memberEnd: number): boolean {
  // A tagged template invokes its tag without parentheses. Template raw text is represented by a
  // string token, so checking the adjacent token closes this egress-review bypass without treating
  // a later standalone template as a fetch call.
  return callOpenAfterMember(tokens, memberEnd) !== -1 || tokens[memberEnd + 1]?.kind === "string";
}

function bracketedPropertyReceiverIndex(
  tokens: readonly BundleToken[],
  propertyIndex: number,
  propertyName: string
): number {
  if (!isStaticBracketedProperty(tokens, propertyIndex, propertyName)) return -1;
  // The tokenizer intentionally drops `?`, so optional bracket access is represented as `x . [`.
  // Accepting both shapes closes the bypass while still requiring a decoded static property name.
  if (tokens[propertyIndex - 2]?.kind === "identifier") return propertyIndex - 2;
  return tokens[propertyIndex - 2]?.value === "." &&
    tokens[propertyIndex - 3]?.kind === "identifier"
    ? propertyIndex - 3
    : -1;
}

function isStaticBracketedProperty(
  tokens: readonly BundleToken[],
  propertyIndex: number,
  propertyName: string
): boolean {
  return (
    tokens[propertyIndex]?.kind === "string" &&
    tokens[propertyIndex].literalValid === true &&
    tokens[propertyIndex].value === propertyName &&
    tokens[propertyIndex - 1]?.value === "[" &&
    tokens[propertyIndex + 1]?.value === "]"
  );
}

function contextContainerReceiverIndex(
  tokens: readonly BundleToken[],
  capabilityIndex: number
): number {
  const capabilityReceiver = capabilityIndex - 2;
  if (
    tokens[capabilityReceiver]?.value === "context" &&
    tokens[capabilityReceiver - 1]?.value === "." &&
    tokens[capabilityReceiver - 2]?.kind === "identifier"
  ) {
    return capabilityReceiver - 2;
  }
  return tokens[capabilityReceiver]?.value === "]"
    ? bracketedPropertyReceiverIndex(tokens, capabilityReceiver - 1, "context")
    : -1;
}

function collectCapabilityBindings(tokens: readonly BundleToken[]): {
  receivers: Map<string, BindingRange[]>;
  direct: Map<string, BindingRange[]>;
  containers: Map<string, BindingRange[]>;
} {
  // PluginContext is a structural SDK type, so neither bundlers nor authors must preserve the
  // local name `context`. Binding names alone are insufficient because helpers can shadow them,
  // so every receiver and destructured alias remains bounded to its handler body.
  const receivers = new Map<string, BindingRange[]>();
  const direct = new Map<string, BindingRange[]>();
  const containers = new Map<string, BindingRange[]>();
  const scopes = collectHandlerCapabilityScopes(tokens);

  for (const scope of scopes) {
    registerBindingRanges(tokens, receivers, scope.receivers, scope);
    registerBindingRanges(tokens, direct, scope.direct, scope);
    registerBindingRanges(tokens, containers, scope.containers, scope);
    for (let index = scope.start; index <= scope.end; index += 1) {
      if (tokens[index]?.value === "{") {
        const close = findMatchingToken(tokens, index, "{", "}");
        const source = tokens[close + 2];
        if (
          close !== -1 &&
          close <= scope.end &&
          tokens[close + 1]?.value === "=" &&
          source?.kind === "identifier"
        ) {
          if (bindingAppliesAt(containers, source.value, close + 2)) {
            const aliases = collectDestructuredContext(tokens.slice(index + 1, close));
            registerDerivedBindings(
              tokens,
              receivers,
              aliases.receivers,
              close + 3,
              close + 2,
              scope
            );
            registerDerivedBindings(tokens, direct, aliases.direct, close + 3, close + 2, scope);
          } else if (bindingAppliesAt(receivers, source.value, close + 2)) {
            const aliases = new Set<string>();
            registerDestructuredCapability(tokens.slice(index + 1, close), aliases);
            registerDerivedBindings(tokens, direct, aliases, close + 3, close + 2, scope);
          }
        }
      }

      if (
        tokens[index]?.kind === "identifier" &&
        ["const", "let"].includes(variableDeclarationKeyword(tokens, index) ?? "") &&
        tokens[index + 1]?.value === "=" &&
        tokens[index + 2]?.kind === "identifier" &&
        tokens[index + 3]?.value === "." &&
        tokens[index + 4]?.value === "context" &&
        bindingAppliesAt(containers, tokens[index + 2]?.value ?? "", index + 2)
      ) {
        registerDerivedBindings(
          tokens,
          receivers,
          new Set([tokens[index]?.value ?? ""]),
          index + 5,
          index,
          scope
        );
      }
    }
  }
  sortBindingRanges(receivers);
  sortBindingRanges(direct);
  sortBindingRanges(containers);
  return { receivers, direct, containers };
}

function registerDerivedBindings(
  tokens: readonly BundleToken[],
  output: Map<string, BindingRange[]>,
  names: ReadonlySet<string>,
  start: number,
  anchor: number,
  scope: BindingRange
): void {
  // A dispatch request can expose its broker through a local alias. Bound that derived trust to
  // the declaration block so an unrelated same-named value elsewhere is never treated as SDK API.
  const enclosing = collectEnclosingObjectOpens(tokens)[anchor];
  const enclosingClose =
    enclosing !== undefined && enclosing >= scope.start
      ? findMatchingToken(tokens, enclosing, "{", "}")
      : -1;
  const range = {
    start,
    end: enclosingClose !== -1 && enclosingClose <= scope.end ? enclosingClose - 1 : scope.end
  };
  if (range.start > range.end) return;
  registerBindingRanges(tokens, output, names, range);
}

function collectHandlerCapabilityScopes(tokens: readonly BundleToken[]): CapabilityScope[] {
  const callableBindings = new Map<string, CallableBinding>();
  const braceDepths = collectBraceDepths(tokens);
  for (let index = 0; index < tokens.length; index += 1) {
    if (braceDepths[index] !== 0) continue;
    if (tokens[index]?.value === "function" && tokens[index + 1]?.kind === "identifier") {
      const open = index + 2;
      if (tokens[open]?.value !== "(") continue;
      const close = findMatchingToken(tokens, open, "(", ")");
      const body = close === -1 ? undefined : blockBodyRange(tokens, close + 1);
      if (body !== undefined) {
        callableBindings.set(tokens[index + 1]?.value ?? "", { open, close, ...body });
      }
      continue;
    }

    // Bundlers commonly hoist a handler into a const-bound callable and reference that binding from
    // the handlers map. Recording only the parameter span keeps resolution lexical and prevents an
    // unrelated call site with the same identifier from being interpreted as a handler.
    if (
      tokens[index]?.kind !== "identifier" ||
      !isTopLevelVariableDeclarator(tokens, index) ||
      tokens[index + 1]?.value !== "="
    ) {
      continue;
    }
    let callable = index + 2;
    if (tokens[callable]?.value === "async") callable += 1;
    if (tokens[callable]?.value === "function") {
      let open = callable + 1;
      if (tokens[open]?.kind === "identifier") open += 1;
      if (tokens[open]?.value !== "(") continue;
      const close = findMatchingToken(tokens, open, "(", ")");
      const body = close === -1 ? undefined : blockBodyRange(tokens, close + 1);
      if (body !== undefined) {
        callableBindings.set(tokens[index]?.value ?? "", { open, close, ...body });
      }
      continue;
    }

    const singleParameter = tokens[callable];
    if (
      singleParameter?.kind === "identifier" &&
      tokens[callable + 1]?.value === "=" &&
      tokens[callable + 2]?.value === ">"
    ) {
      const body = arrowBodyRange(tokens, callable, tokens.length - 1);
      if (body !== undefined) {
        callableBindings.set(tokens[index]?.value ?? "", {
          open: callable,
          close: callable,
          singleParameter,
          ...body
        });
      }
      continue;
    }

    const open = callable;
    if (tokens[open]?.value !== "(") continue;
    const close = findMatchingToken(tokens, open, "(", ")");
    const body = close === -1 ? undefined : arrowBodyRange(tokens, close, tokens.length - 1);
    if (body !== undefined) {
      callableBindings.set(tokens[index]?.value ?? "", { open, close, ...body });
    }
  }

  const scopes = new Map<string, CapabilityScope>();
  const storeScope = (scope: CapabilityScope | undefined): void => {
    if (scope !== undefined) scopes.set(`${String(scope.start)}:${String(scope.end)}`, scope);
  };
  const addScope = (open: number, close: number, body: BindingRange): void => {
    const scope = createCapabilityScope(tokens, open, close, body);
    storeScope(scope);
  };
  const addDispatchScope = (open: number, close: number, body: BindingRange): void => {
    storeScope(createDispatchCapabilityScope(tokens, open, close, body));
  };
  const addSingleParameterDispatchScope = (parameterIndex: number, body: BindingRange): void => {
    const parameter = tokens[parameterIndex];
    if (parameter !== undefined) {
      storeScope(createDispatchCapabilityScopeFromParameter([parameter], body));
    }
  };
  const addNamedDispatchScope = (binding: CallableBinding): void => {
    if (binding.singleParameter !== undefined) {
      storeScope(createDispatchCapabilityScopeFromParameter([binding.singleParameter], binding));
    } else {
      addDispatchScope(binding.open, binding.close, binding);
    }
  };

  const enclosingObjects = collectEnclosingObjectOpens(tokens);
  const exportedPluginBindings = new Set([
    ...collectEsbuildCommonJsPluginBindings(tokens),
    ...collectCommonJsObjectExportBindings(tokens, new Set(["plugin", "default"]), true)
  ]);
  // Production prefers plugin.dispatch over legacy handlers. Restricting discovery to exported
  // plugin objects covers the runtime surface without trusting unrelated application dispatchers.
  for (let index = 0; index < tokens.length; index += 1) {
    const candidate = tokens[index];
    if (candidate?.value !== "dispatch") continue;
    const isComputedDispatch =
      candidate.kind === "string" &&
      candidate.literalValid === true &&
      tokens[index - 1]?.value === "[" &&
      tokens[index + 1]?.value === "]";
    const propertyStart = isComputedDispatch ? index - 1 : index;
    const propertyEnd = isComputedDispatch ? index + 1 : index;
    const fieldStart =
      tokens[propertyStart - 1]?.value === "async" ? propertyStart - 1 : propertyStart;
    const objectOpen = enclosingObjects[index];
    const startsObjectField = ["{", ","].includes(tokens[fieldStart - 1]?.value ?? "");
    const isObjectField =
      startsObjectField &&
      objectOpen !== undefined &&
      isPluginDispatchObject(tokens, objectOpen, exportedPluginBindings, enclosingObjects);
    const isMutation = isExportedPluginDispatchMutation(
      tokens,
      propertyStart,
      propertyEnd,
      exportedPluginBindings
    );
    if (!isObjectField && !isMutation) continue;

    if (isObjectField && tokens[propertyEnd + 1]?.value === "(") {
      const close = findMatchingToken(tokens, propertyEnd + 1, "(", ")");
      const body = close === -1 ? undefined : blockBodyRange(tokens, close + 1);
      if (body !== undefined) addDispatchScope(propertyEnd + 1, close, body);
      continue;
    }
    if (
      isObjectField &&
      !isComputedDispatch &&
      [",", "}"].includes(tokens[propertyEnd + 1]?.value ?? "")
    ) {
      const named = callableBindings.get("dispatch");
      if (named !== undefined) addNamedDispatchScope(named);
      continue;
    }
    if (tokens[propertyEnd + 1]?.value !== (isMutation ? "=" : ":")) continue;
    let value = propertyEnd + 2;
    if (tokens[value]?.value === "async") value += 1;
    if (tokens[value]?.value === "function") {
      if (tokens[value + 1]?.kind === "identifier") value += 1;
      const open = value + 1;
      const close = tokens[open]?.value === "(" ? findMatchingToken(tokens, open, "(", ")") : -1;
      const body = close === -1 ? undefined : blockBodyRange(tokens, close + 1);
      if (body !== undefined) addDispatchScope(open, close, body);
    } else if (tokens[value]?.value === "(") {
      const close = findMatchingToken(tokens, value, "(", ")");
      const body = close === -1 ? undefined : arrowBodyRange(tokens, close, tokens.length - 1);
      if (body !== undefined) addDispatchScope(value, close, body);
    } else if (
      tokens[value]?.kind === "identifier" &&
      tokens[value + 1]?.value === "=" &&
      tokens[value + 2]?.value === ">"
    ) {
      const body = arrowBodyRange(tokens, value, tokens.length - 1);
      if (body !== undefined) addSingleParameterDispatchScope(value, body);
    } else if (tokens[value]?.kind === "identifier") {
      const named = callableBindings.get(tokens[value]?.value ?? "");
      if (named !== undefined) addNamedDispatchScope(named);
    }
  }

  const hasLoweredHandlerExport = hasEsbuildCommonJsHandlerExport(tokens);
  const referencedHandlerBindings = new Set([
    ...collectDefinePluginHandlerBindings(tokens, enclosingObjects),
    ...collectCommonJsObjectExportBindings(tokens, new Set(["handlers"]), false)
  ]);
  for (let index = 0; index < tokens.length; index += 1) {
    const candidate = tokens[index];
    const isBracketedHandlersProperty =
      candidate?.kind === "string" &&
      candidate.literalValid === true &&
      candidate.value === "handlers" &&
      tokens[index - 1]?.value === "[" &&
      tokens[index + 1]?.value === "]";
    const assignmentIndex = index + (isBracketedHandlersProperty ? 2 : 1);
    const handlersOpen = assignmentIndex + 1;
    if (
      ![":", "="].includes(tokens[assignmentIndex]?.value ?? "") ||
      tokens[handlersOpen]?.value !== "{"
    ) {
      continue;
    }
    const isDirectHandlersDeclaration =
      tokens[index]?.value === "handlers" &&
      isPluginHandlersDeclaration(
        tokens,
        index,
        braceDepths[index] ?? 0,
        enclosingObjects[index],
        hasLoweredHandlerExport
      );
    const isReferencedHandlersDeclaration =
      referencedHandlerBindings.has(tokens[index]?.value ?? "") &&
      (braceDepths[index] ?? 0) === 0 &&
      isTopLevelVariableDeclarator(tokens, index);
    if (!isDirectHandlersDeclaration && !isReferencedHandlersDeclaration) continue;
    const handlersClose = findMatchingToken(tokens, handlersOpen, "{", "}");
    if (handlersClose === -1) continue;
    let depth = 0;
    for (let field = handlersOpen + 1; field < handlersClose; field += 1) {
      if (depth === 0) {
        // Object-method handlers have no colon, so recognize only a direct property name followed
        // by parameters and a body. Requiring the body avoids treating `event: factory(a, b)` as
        // a handler declaration and accidentally trusting an unrelated second argument.
        let methodOpen = -1;
        const startsObjectField = ["{", ","].includes(tokens[field - 1]?.value ?? "");
        const computedOpen =
          startsObjectField && tokens[field]?.value === "["
            ? field
            : startsObjectField &&
                tokens[field]?.value === "async" &&
                tokens[field + 1]?.value === "["
              ? field + 1
              : -1;
        const computedClose =
          computedOpen === -1 ? -1 : findMatchingToken(tokens, computedOpen, "[", "]");
        if (computedClose !== -1 && tokens[computedClose + 1]?.value === "(") {
          // Computed methods are ordinary own properties at runtime. Their key expression does not
          // affect whether the body can reach the broker, so scan any well-formed computed method.
          methodOpen = computedClose + 1;
        } else if (
          startsObjectField &&
          ["identifier", "string"].includes(tokens[field]?.kind ?? "") &&
          tokens[field]?.literalValid !== false &&
          tokens[field + 1]?.value === "("
        ) {
          methodOpen = field + 1;
        } else if (
          startsObjectField &&
          tokens[field]?.value === "async" &&
          ["identifier", "string"].includes(tokens[field + 1]?.kind ?? "") &&
          tokens[field + 1]?.literalValid !== false &&
          tokens[field + 2]?.value === "("
        ) {
          methodOpen = field + 2;
        }
        if (methodOpen !== -1) {
          const methodClose = findMatchingToken(tokens, methodOpen, "(", ")");
          const body = methodClose === -1 ? undefined : blockBodyRange(tokens, methodClose + 1);
          if (body !== undefined) {
            addScope(methodOpen, methodClose, body);
          }
        }
        if (
          startsObjectField &&
          tokens[field]?.kind === "identifier" &&
          [",", "}"].includes(tokens[field + 1]?.value ?? "")
        ) {
          const shorthand = callableBindings.get(tokens[field]?.value ?? "");
          if (shorthand !== undefined) addScope(shorthand.open, shorthand.close, shorthand);
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
        const body = close === -1 ? undefined : blockBodyRange(tokens, close + 1);
        if (body !== undefined) addScope(open, close, body);
      } else if (tokens[value]?.value === "(") {
        const close = findMatchingToken(tokens, value, "(", ")");
        const body = close === -1 ? undefined : arrowBodyRange(tokens, close, handlersClose - 1);
        if (body !== undefined) addScope(value, close, body);
      } else if (tokens[value]?.kind === "identifier") {
        const named = callableBindings.get(tokens[value]?.value ?? "");
        if (named !== undefined) {
          addScope(named.open, named.close, named);
        }
      }
    }
    index = handlersClose;
  }
  return [...scopes.values()];
}

function isExportedPluginDispatchMutation(
  tokens: readonly BundleToken[],
  propertyStart: number,
  propertyEnd: number,
  exportedPluginBindings: ReadonlySet<string>
): boolean {
  if (tokens[propertyEnd + 1]?.value !== "=") return false;
  const isComputed = tokens[propertyStart]?.value === "[";
  const receiverEnd =
    tokens[propertyStart - 1]?.value === "." ? propertyStart - 2 : propertyStart - 1;
  if (!isComputed && tokens[propertyStart - 1]?.value !== ".") return false;
  const receiver = tokens[receiverEnd];
  if (receiver?.kind === "identifier") {
    if (exportedPluginBindings.has(receiver.value)) return true;
    if (isCommonJsExportsIdentifier(tokens, receiverEnd)) return true;
    return (
      receiver.value === "plugin" &&
      tokens[receiverEnd - 1]?.value === "." &&
      isCommonJsExportsIdentifier(tokens, receiverEnd - 2)
    );
  }
  if (receiver?.value !== "]") return false;
  const pluginReceiver = bracketedPropertyReceiverIndex(tokens, receiverEnd - 1, "plugin");
  return isCommonJsExportsIdentifier(tokens, pluginReceiver);
}

function isCommonJsExportsIdentifier(tokens: readonly BundleToken[], index: number): boolean {
  return (
    tokens[index]?.value === "exports" &&
    (tokens[index - 1]?.value !== "." || tokens[index - 2]?.value === "module")
  );
}

function collectCommonJsObjectExportBindings(
  tokens: readonly BundleToken[],
  properties: ReadonlySet<string>,
  includeModuleExports: boolean
): Set<string> {
  const bindings = new Set<string>();
  const braceDepths = collectBraceDepths(tokens);
  for (let index = 0; index < tokens.length; index += 1) {
    if (
      braceDepths[index] !== 0 ||
      tokens[index]?.value !== "=" ||
      tokens[index + 1]?.kind !== "identifier"
    ) {
      continue;
    }

    const directDotProperty = matchesTokenSequence(tokens, index - 3, [
      "exports",
      ".",
      tokens[index - 1]?.value ?? "",
      "="
    ])
      ? tokens[index - 1]?.value
      : undefined;
    const moduleDotProperty = matchesTokenSequence(tokens, index - 5, [
      "module",
      ".",
      "exports",
      ".",
      tokens[index - 1]?.value ?? "",
      "="
    ])
      ? tokens[index - 1]?.value
      : undefined;
    const directBracketProperty =
      matchesTokenSequence(tokens, index - 4, [
        "exports",
        "[",
        tokens[index - 2]?.value ?? "",
        "]",
        "="
      ]) &&
      tokens[index - 2]?.kind === "string" &&
      tokens[index - 2]?.literalValid === true
        ? tokens[index - 2]?.value
        : undefined;
    const moduleBracketProperty =
      matchesTokenSequence(tokens, index - 6, [
        "module",
        ".",
        "exports",
        "[",
        tokens[index - 2]?.value ?? "",
        "]",
        "="
      ]) &&
      tokens[index - 2]?.kind === "string" &&
      tokens[index - 2]?.literalValid === true
        ? tokens[index - 2]?.value
        : undefined;
    const property =
      directDotProperty ?? moduleDotProperty ?? directBracketProperty ?? moduleBracketProperty;
    const assignsModule = matchesTokenSequence(tokens, index - 3, ["module", ".", "exports", "="]);
    if (properties.has(property ?? "") || (includeModuleExports && assignsModule)) {
      // Only a top-level identifier can be tied back to a bounded object declaration. Refusing
      // arbitrary expressions avoids treating an unrelated factory result as trusted plugin code.
      bindings.add(tokens[index + 1]?.value ?? "");
    }
  }
  return bindings;
}

function collectBraceDepths(tokens: readonly BundleToken[]): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value === "}") depth = Math.max(0, depth - 1);
    depths.push(depth);
    if (tokens[index]?.value === "{") depth += 1;
  }
  return depths;
}

function isTopLevelVariableDeclarator(
  tokens: readonly BundleToken[],
  identifierIndex: number
): boolean {
  return variableDeclarationKeyword(tokens, identifierIndex) !== undefined;
}

function variableDeclarationKeyword(
  tokens: readonly BundleToken[],
  identifierIndex: number
): "const" | "let" | "var" | undefined {
  const previous = tokens[identifierIndex - 1]?.value;
  if (previous === "const" || previous === "let" || previous === "var") return previous;
  if (previous !== ",") return undefined;

  let delimiterDepth = 0;
  for (let index = identifierIndex - 2; index >= 0; index -= 1) {
    const value = tokens[index]?.value;
    if ([")", "]", "}"].includes(value ?? "")) {
      delimiterDepth += 1;
      continue;
    }
    if (["(", "[", "{"].includes(value ?? "")) {
      if (delimiterDepth === 0) return undefined;
      delimiterDepth -= 1;
      continue;
    }
    if (delimiterDepth !== 0) continue;
    if (value === "const" || value === "let" || value === "var") return value;
    // Only a declaration keyword in the same statement can authorize a later declarator. This
    // boundary prevents an arbitrary comma-separated assignment from becoming a trusted handler.
    if (value === ";") return undefined;
  }
  return undefined;
}

function collectEnclosingObjectOpens(tokens: readonly BundleToken[]): Array<number | undefined> {
  const cached = enclosingObjectCache.get(tokens);
  if (cached !== undefined) return cached;
  const enclosing: Array<number | undefined> = [];
  const stack: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value === "}") stack.pop();
    enclosing.push(stack.at(-1));
    if (tokens[index]?.value === "{") stack.push(index);
  }
  enclosingObjectCache.set(tokens, enclosing);
  return enclosing;
}

function collectDefinePluginHandlerBindings(
  tokens: readonly BundleToken[],
  enclosingObjects: readonly (number | undefined)[]
): Set<string> {
  const bindings = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value !== "handlers") continue;
    const objectOpen = enclosingObjects[index];
    const isDefinePluginInput =
      objectOpen !== undefined &&
      tokens[objectOpen - 1]?.value === "(" &&
      tokens[objectOpen - 2]?.value === "definePlugin";
    const startsObjectField = ["{", ","].includes(tokens[index - 1]?.value ?? "");
    if (!isDefinePluginInput || !startsObjectField) continue;

    if ([",", "}"].includes(tokens[index + 1]?.value ?? "")) {
      bindings.add("handlers");
    } else if (tokens[index + 1]?.value === ":" && tokens[index + 2]?.kind === "identifier") {
      bindings.add(tokens[index + 2]?.value ?? "");
    }
  }
  return bindings;
}

function isPluginHandlersDeclaration(
  tokens: readonly BundleToken[],
  handlersIndex: number,
  handlersDepth: number,
  enclosingObjectOpen: number | undefined,
  hasLoweredHandlerExport: boolean
): boolean {
  if (tokens[handlersIndex]?.kind === "string" && tokens[handlersIndex].literalValid === true) {
    if (tokens[handlersIndex + 2]?.value !== "=") return false;
    const receiverIndex = bracketedPropertyReceiverIndex(tokens, handlersIndex, "handlers");
    const isDirectCommonJsExport =
      tokens[receiverIndex]?.value === "exports" && tokens[receiverIndex - 1]?.value !== ".";
    const isModuleCommonJsExport =
      tokens[receiverIndex]?.value === "exports" &&
      tokens[receiverIndex - 1]?.value === "." &&
      tokens[receiverIndex - 2]?.value === "module";
    return handlersDepth === 0 && (isDirectCommonJsExport || isModuleCommonJsExport);
  }
  if (tokens[handlersIndex + 1]?.value === "=") {
    const isExportedBinding =
      ["const", "let", "var"].includes(tokens[handlersIndex - 1]?.value ?? "") &&
      tokens[handlersIndex - 2]?.value === "export";
    const isCommonJsExport =
      tokens[handlersIndex - 1]?.value === "." && tokens[handlersIndex - 2]?.value === "exports";
    const isLoweredExport =
      hasLoweredHandlerExport &&
      ["const", "let", "var"].includes(tokens[handlersIndex - 1]?.value ?? "");
    return handlersDepth === 0 && (isExportedBinding || isCommonJsExport || isLoweredExport);
  }
  const isDefinePluginInput =
    enclosingObjectOpen !== undefined &&
    tokens[enclosingObjectOpen - 1]?.value === "(" &&
    tokens[enclosingObjectOpen - 2]?.value === "definePlugin";
  const isDirectCommonJsModule =
    enclosingObjectOpen !== undefined &&
    tokens[enclosingObjectOpen - 1]?.value === "=" &&
    tokens[enclosingObjectOpen - 2]?.value === "exports" &&
    tokens[enclosingObjectOpen - 3]?.value === "." &&
    tokens[enclosingObjectOpen - 4]?.value === "module";
  return isDefinePluginInput || isDirectCommonJsModule;
}

function isPluginDispatchObject(
  tokens: readonly BundleToken[],
  objectOpen: number,
  loweredPluginBindings: ReadonlySet<string>,
  enclosingObjects: readonly (number | undefined)[]
): boolean {
  if (
    matchesTokenSequence(tokens, objectOpen - 4, ["module", ".", "exports", "=", "{"]) ||
    matchesTokenSequence(tokens, objectOpen - 2, ["export", "default", "{"])
  ) {
    return true;
  }
  const bracketedProperty =
    tokens[objectOpen - 2]?.value === "]" &&
    tokens[objectOpen - 3]?.kind === "string" &&
    tokens[objectOpen - 3]?.literalValid === true &&
    tokens[objectOpen - 4]?.value === "["
      ? tokens[objectOpen - 3]?.value
      : undefined;
  const exportedProperty = bracketedProperty ?? tokens[objectOpen - 2]?.value;
  const outerObjectOpen = enclosingObjects[objectOpen];
  if (
    ["plugin", "default"].includes(exportedProperty ?? "") &&
    tokens[objectOpen - 1]?.value === ":" &&
    outerObjectOpen !== undefined &&
    matchesTokenSequence(tokens, outerObjectOpen - 4, ["module", ".", "exports", "=", "{"])
  ) {
    return true;
  }
  if (
    loweredPluginBindings.has(exportedProperty ?? "") &&
    tokens[objectOpen - 1]?.value === "=" &&
    isTopLevelVariableDeclarator(tokens, objectOpen - 2)
  ) {
    return true;
  }
  if (!["plugin", "default"].includes(exportedProperty ?? "")) return false;
  if (bracketedProperty !== undefined && tokens[objectOpen - 1]?.value === "=") {
    const receiver = tokens[objectOpen - 5]?.value;
    const isDirectCommonJsExport = receiver === "exports";
    const isModuleCommonJsExport =
      receiver === "exports" &&
      tokens[objectOpen - 6]?.value === "." &&
      tokens[objectOpen - 7]?.value === "module";
    if (isDirectCommonJsExport || isModuleCommonJsExport) return true;
  }
  return (
    matchesTokenSequence(tokens, objectOpen - 4, [
      "exports",
      ".",
      exportedProperty ?? "",
      "=",
      "{"
    ]) ||
    matchesTokenSequence(tokens, objectOpen - 6, [
      "module",
      ".",
      "exports",
      ".",
      exportedProperty ?? "",
      "=",
      "{"
    ]) ||
    (tokens[objectOpen - 1]?.value === "=" &&
      ["const", "let", "var"].includes(tokens[objectOpen - 3]?.value ?? "") &&
      tokens[objectOpen - 4]?.value === "export")
  );
}

function collectEsbuildCommonJsPluginBindings(tokens: readonly BundleToken[]): Set<string> {
  const bindings = new Set<string>();
  let assignsCommonJsModule = false;
  for (let index = 0; index < tokens.length; index += 1) {
    if (
      ["plugin", "default"].includes(tokens[index]?.value ?? "") &&
      matchesTokenSequence(tokens, index + 1, [":", "(", ")", "=", ">"]) &&
      tokens[index + 6]?.kind === "identifier"
    ) {
      bindings.add(tokens[index + 6]?.value ?? "");
    }
    if (matchesTokenSequence(tokens, index, ["module", ".", "exports", "=", "__toCommonJS", "("])) {
      assignsCommonJsModule = true;
    }
  }
  return assignsCommonJsModule ? bindings : new Set<string>();
}

function hasEsbuildCommonJsHandlerExport(tokens: readonly BundleToken[]): boolean {
  let mapsHandlersBinding = false;
  let assignsCommonJsModule = false;
  for (let index = 0; index < tokens.length; index += 1) {
    if (matchesTokenSequence(tokens, index, ["handlers", ":", "(", ")", "=", ">", "handlers"])) {
      mapsHandlersBinding = true;
    }
    if (matchesTokenSequence(tokens, index, ["module", ".", "exports", "=", "__toCommonJS", "("])) {
      assignsCommonJsModule = true;
    }
  }
  return mapsHandlersBinding && assignsCommonJsModule;
}

function createCapabilityScope(
  tokens: readonly BundleToken[],
  open: number,
  close: number,
  body: BindingRange
): CapabilityScope | undefined {
  const receivers = new Set<string>();
  const direct = new Set<string>();
  const containers = new Set<string>();
  const parameters = splitTopLevel(tokens.slice(open + 1, close), ",");
  const contextParameter = parameters[1];
  if (contextParameter?.[0]?.kind === "identifier") {
    receivers.add(contextParameter[0].value);
  } else if (contextParameter?.[0]?.value === "{") {
    registerDestructuredCapability(contextParameter.slice(1, -1), direct);
  }
  return receivers.size === 0 && direct.size === 0
    ? undefined
    : { ...body, receivers, direct, containers };
}

function createDispatchCapabilityScope(
  tokens: readonly BundleToken[],
  open: number,
  close: number,
  body: BindingRange
): CapabilityScope | undefined {
  const requestParameter = splitTopLevel(tokens.slice(open + 1, close), ",")[0] ?? [];
  return createDispatchCapabilityScopeFromParameter(requestParameter, body);
}

function createDispatchCapabilityScopeFromParameter(
  requestParameter: readonly BundleToken[],
  body: BindingRange
): CapabilityScope | undefined {
  const receivers = new Set<string>();
  const direct = new Set<string>();
  const containers = new Set<string>();
  if (requestParameter[0]?.kind === "identifier") {
    containers.add(requestParameter[0].value);
  } else if (requestParameter[0]?.value === "{") {
    registerDestructuredContext(requestParameter.slice(1, -1), receivers, direct);
  }
  return receivers.size === 0 && direct.size === 0 && containers.size === 0
    ? undefined
    : { ...body, receivers, direct, containers };
}

function blockBodyRange(
  tokens: readonly BundleToken[],
  bodyOpen: number
): BindingRange | undefined {
  if (tokens[bodyOpen]?.value !== "{") return undefined;
  const bodyClose = findMatchingToken(tokens, bodyOpen, "{", "}");
  return bodyClose === -1 ? undefined : { start: bodyOpen + 1, end: bodyClose - 1 };
}

function arrowBodyRange(
  tokens: readonly BundleToken[],
  parametersClose: number,
  limit: number
): BindingRange | undefined {
  if (tokens[parametersClose + 1]?.value !== "=" || tokens[parametersClose + 2]?.value !== ">") {
    return undefined;
  }
  const start = parametersClose + 3;
  const block = blockBodyRange(tokens, start);
  if (block !== undefined) return block;

  const end = findExpressionBoundary(tokens, start, limit);
  return start <= end ? { start, end } : undefined;
}

function findExpressionBoundary(
  tokens: readonly BundleToken[],
  start: number,
  limit: number
): number {
  let depth = 0;
  for (let index = start; index <= limit; index += 1) {
    const value = tokens[index]?.value ?? "";
    if (["(", "{", "["].includes(value)) depth += 1;
    else if ([")", "}", "]"].includes(value)) depth = Math.max(0, depth - 1);
    if (depth === 0 && [",", ";"].includes(value)) return index - 1;
  }
  return limit;
}

function registerBindingRanges(
  tokens: readonly BundleToken[],
  output: Map<string, BindingRange[]>,
  names: ReadonlySet<string>,
  range: BindingRange
): void {
  for (const name of names) {
    const ranges = output.get(name) ?? [];
    ranges.push(...subtractBindingRanges(range, collectNestedShadowRanges(tokens, range, name)));
    output.set(name, ranges);
  }
}

function collectNestedShadowRanges(
  tokens: readonly BundleToken[],
  outer: BindingRange,
  name: string
): BindingRange[] {
  const shadows: BindingRange[] = [];
  const enclosingBlocks = collectEnclosingObjectOpens(tokens);
  const registerEnclosingBlock = (index: number): void => {
    const open = enclosingBlocks[index];
    if (open === undefined || open < outer.start) return;
    const close = findMatchingToken(tokens, open, "{", "}");
    if (close !== -1 && close <= outer.end) shadows.push({ start: open + 1, end: close - 1 });
  };
  for (let index = outer.start; index <= outer.end; index += 1) {
    if (tokens[index]?.value === "catch" && tokens[index + 1]?.value === "(") {
      const close = findMatchingToken(tokens, index + 1, "(", ")");
      const body = close === -1 ? undefined : blockBodyRange(tokens, close + 1);
      if (body !== undefined && parameterListDeclares(tokens, index + 1, close, name)) {
        shadows.push(body);
      }
    }

    if (tokens[index]?.value === "function") {
      let open = index + 1;
      if (tokens[open]?.kind === "identifier") open += 1;
      if (tokens[open]?.value !== "(") continue;
      const close = findMatchingToken(tokens, open, "(", ")");
      const body = close === -1 ? undefined : blockBodyRange(tokens, close + 1);
      if (body !== undefined && parameterListDeclares(tokens, open, close, name)) {
        shadows.push(body);
      }
      continue;
    }

    if (tokens[index]?.kind === "identifier" && tokens[index]?.value === name) {
      const declaration = variableDeclarationKeyword(tokens, index);
      if (declaration === "var") {
        const callableBody = enclosingNestedCallableBody(tokens, index, outer);
        if (callableBody !== undefined) shadows.push(callableBody);
      } else if (
        declaration === "const" ||
        declaration === "let" ||
        tokens[index - 1]?.value === "class" ||
        tokens[index - 1]?.value === "function"
      ) {
        // Lexical declarations shadow for the entire containing block, including the temporal dead
        // zone before the declaration. Excluding only the post-declaration range would be unsound.
        registerEnclosingBlock(index);
      }
    }

    if (tokens[index]?.value === "(") {
      const close = findMatchingToken(tokens, index, "(", ")");
      const body = close === -1 ? undefined : arrowBodyRange(tokens, close, outer.end);
      if (body !== undefined && parameterListDeclares(tokens, index, close, name)) {
        shadows.push(body);
      }
      continue;
    }

    if (
      tokens[index]?.kind === "identifier" &&
      tokens[index]?.value === name &&
      tokens[index + 1]?.value === "=" &&
      tokens[index + 2]?.value === ">"
    ) {
      const start = index + 3;
      const block = blockBodyRange(tokens, start);
      if (block !== undefined) shadows.push(block);
      else {
        const end = findExpressionBoundary(tokens, start, outer.end);
        if (start <= end) shadows.push({ start, end });
      }
    }
  }
  return shadows;
}

function enclosingNestedCallableBody(
  tokens: readonly BundleToken[],
  index: number,
  outer: BindingRange
): BindingRange | undefined {
  const enclosing = collectEnclosingObjectOpens(tokens);
  let open = enclosing[index];
  while (open !== undefined && open >= outer.start) {
    const close = findMatchingToken(tokens, open, "{", "}");
    if (close !== -1 && isCallableBodyOpen(tokens, open)) {
      // `var` belongs to the nearest callable, even when declared inside a nested block. Excluding
      // that whole helper prevents its function-scoped local from impersonating the SDK receiver.
      return { start: open + 1, end: close - 1 };
    }
    open = enclosing[open];
  }
  return undefined;
}

function isCallableBodyOpen(tokens: readonly BundleToken[], bodyOpen: number): boolean {
  if (tokens[bodyOpen - 1]?.value === ">" && tokens[bodyOpen - 2]?.value === "=") return true;
  if (tokens[bodyOpen - 1]?.value !== ")") return false;
  const parametersOpen = pairedTokenIndex(tokens, bodyOpen - 1);
  if (parametersOpen === undefined || tokens[parametersOpen]?.value !== "(") return false;
  const prefix = tokens[parametersOpen - 1]?.value ?? "";
  return (
    prefix === "function" ||
    (tokens[parametersOpen - 1]?.kind === "identifier" && !nonCallablePrefixes.has(prefix))
  );
}

function parameterListDeclares(
  tokens: readonly BundleToken[],
  open: number,
  close: number,
  name: string
): boolean {
  return splitTopLevel(tokens.slice(open + 1, close), ",").some((parameter) =>
    bindingPatternDeclares(parameter, name)
  );
}

function bindingPatternDeclares(pattern: readonly BundleToken[], name: string): boolean {
  const first = pattern[0];
  if (first?.kind === "identifier") return first.value === name;
  if (first?.value !== "{" && first?.value !== "[") return false;
  const close = findMatchingToken(pattern, 0, first.value, first.value === "{" ? "}" : "]");
  if (close === -1) return false;

  for (const entry of splitTopLevel(pattern.slice(1, close), ",")) {
    if (entry.length === 0) continue;
    if (first.value === "[") {
      if (bindingPatternDeclares(entry, name)) return true;
      continue;
    }
    const colon = topLevelTokenIndex(entry, ":");
    if (colon !== -1) {
      if (bindingPatternDeclares(entry.slice(colon + 1), name)) return true;
      continue;
    }
    // Without a property/value separator an object binding is shorthand, optionally followed by
    // a default. Only its first identifier is introduced into the callable scope.
    const binding = entry.find((token) => token.kind === "identifier");
    if (binding?.value === name) return true;
  }
  return false;
}

function topLevelTokenIndex(tokens: readonly BundleToken[], value: string): number {
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]?.value;
    if (["(", "[", "{"].includes(token ?? "")) depth += 1;
    else if ([")", "]", "}"].includes(token ?? "")) depth -= 1;
    else if (depth === 0 && token === value) return index;
  }
  return -1;
}

function subtractBindingRanges(
  base: BindingRange,
  exclusions: readonly BindingRange[]
): BindingRange[] {
  const sorted = exclusions
    .filter((range) => range.end >= base.start && range.start <= base.end)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const output: BindingRange[] = [];
  let cursor = base.start;
  for (const exclusion of sorted) {
    const start = Math.max(base.start, exclusion.start);
    const end = Math.min(base.end, exclusion.end);
    if (start > cursor) output.push({ start: cursor, end: start - 1 });
    cursor = Math.max(cursor, end + 1);
  }
  if (cursor <= base.end) output.push({ start: cursor, end: base.end });
  return output;
}

function bindingAppliesAt(
  bindings: ReadonlyMap<string, readonly BindingRange[]>,
  name: string,
  index: number
): boolean {
  const ranges = bindings.get(name);
  if (ranges === undefined) return false;
  // A hostile bundle can repeat the same receiver across many handlers. Binary search keeps each
  // capability probe logarithmic instead of multiplying call count by handler count.
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = ranges[middle];
    if (range === undefined) return false;
    if (index < range.start) high = middle - 1;
    else if (index > range.end) low = middle + 1;
    else return true;
  }
  return false;
}

function sortBindingRanges(bindings: Map<string, BindingRange[]>): void {
  for (const ranges of bindings.values()) {
    ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  }
}

function registerDestructuredCapability(tokens: readonly BundleToken[], direct: Set<string>): void {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value !== "capability") continue;
    const isComputed =
      tokens[index]?.kind === "string" &&
      tokens[index]?.literalValid === true &&
      tokens[index - 1]?.value === "[" &&
      tokens[index + 1]?.value === "]";
    const separator = index + (isComputed ? 2 : 1);
    const alias = tokens[separator]?.value === ":" ? tokens[separator + 1] : undefined;
    if (alias?.kind === "identifier") direct.add(alias.value);
    else if (!isComputed) direct.add("capability");
  }
}

function registerDestructuredContext(
  tokens: readonly BundleToken[],
  receivers: Set<string>,
  direct: Set<string>
): void {
  const aliases = collectDestructuredContext(tokens);
  for (const receiver of aliases.receivers) receivers.add(receiver);
  for (const binding of aliases.direct) direct.add(binding);
}

function collectDestructuredContext(tokens: readonly BundleToken[]): {
  receivers: Set<string>;
  direct: Set<string>;
} {
  const receivers = new Set<string>();
  const direct = new Set<string>();
  for (const property of splitTopLevel(tokens, ",")) {
    const separator = staticDestructuredPropertySeparator(property, "context");
    if (separator === -1) continue;
    if (property[separator]?.value === ":" && property[separator + 1]?.value === "{") {
      registerDestructuredCapability(property.slice(separator + 2, -1), direct);
      continue;
    }
    const alias = property[separator]?.value === ":" ? property[separator + 1] : undefined;
    if (alias?.kind === "identifier") receivers.add(alias.value);
    else if (separator === 1) receivers.add("context");
  }
  return { receivers, direct };
}

function staticDestructuredPropertySeparator(
  property: readonly BundleToken[],
  name: string
): number {
  if (property[0]?.value === name && property[0].literalValid !== false) return 1;
  return property[0]?.value === "[" &&
    property[1]?.kind === "string" &&
    property[1].literalValid === true &&
    property[1].value === name &&
    property[2]?.value === "]"
    ? 3
    : -1;
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
  const closeIndex = pairedTokenIndex(tokens, openIndex);
  return tokens[openIndex]?.value === open && tokens[closeIndex ?? -1]?.value === close
    ? (closeIndex ?? -1)
    : -1;
}

function pairedTokenIndex(tokens: readonly BundleToken[], index: number): number | undefined {
  let pairs = tokenPairCache.get(tokens);
  if (pairs === undefined) {
    pairs = buildTokenPairs(tokens);
    tokenPairCache.set(tokens, pairs);
  }
  return pairs.get(index);
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
      if (opening !== undefined) {
        pairs.set(opening.index, index);
        pairs.set(index, opening.index);
      }
    }
  }
  return pairs;
}

function tokenizeBundle(source: string): BundleToken[] {
  return tokenizeCode(source, 0, false).tokens;
}

function tokenizeCode(
  source: string,
  start: number,
  stopAtTemplateExpressionEnd: boolean
): { tokens: BundleToken[]; nextIndex: number } {
  const tokens: BundleToken[] = [];
  let index = start;
  let braceDepth = 0;
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
      const template = tokenizeTemplateExpressions(source, index);
      tokens.push(...template.tokens);
      index = template.nextIndex;
    } else if (
      (character !== undefined && /[A-Za-z_$]/u.test(character)) ||
      (character === "\\" && next === "u")
    ) {
      const identifier = readIdentifierToken(source, index);
      if (identifier === undefined) index += 1;
      else {
        tokens.push(identifier.token);
        index = identifier.nextIndex;
      }
    } else {
      if (character === "}" && stopAtTemplateExpressionEnd && braceDepth === 0) {
        return { tokens, nextIndex: index + 1 };
      }
      if (character !== undefined && ".(),{}:[]=>;".includes(character)) {
        tokens.push({ kind: "punctuation", value: character });
      }
      if (character === "{") braceDepth += 1;
      else if (character === "}") braceDepth = Math.max(0, braceDepth - 1);
      index += 1;
    }
  }
  return { tokens, nextIndex: source.length };
}

function readIdentifierToken(
  source: string,
  start: number
): { token: BundleToken; nextIndex: number } | undefined {
  let index = start;
  let value = "";
  while (index < source.length) {
    const character = source[index];
    let decoded = character ?? "";
    let nextIndex = index + 1;
    if (character === "\\" && source[index + 1] === "u") {
      const escape = readStringEscape(source, index);
      if (!escape.valid) break;
      decoded = escape.value;
      nextIndex = escape.nextIndex;
    }
    const allowed = value.length === 0 ? /^[A-Za-z_$]$/u : /^[A-Za-z0-9_$]$/u;
    if (!allowed.test(decoded)) break;
    value += decoded;
    index = nextIndex;
  }
  if (value.length === 0) return undefined;
  // Decode identifier escapes before matching security-sensitive names; retaining their source
  // spelling would let valid JavaScript broker calls bypass the token-level audit.
  return { token: { kind: "identifier", value }, nextIndex: index };
}

function tokenizeTemplateExpressions(
  source: string,
  templateStart: number
): { tokens: BundleToken[]; nextIndex: number } {
  // Raw template text is inert, but every `${...}` segment is executable code. Tokenize only those
  // segments recursively so nested templates cannot hide broker or egress calls in static text.
  const tokens: BundleToken[] = [];
  let index = templateStart + 1;
  let value = "";
  let valid = true;
  let hasExpression = false;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      const escape = readStringEscape(source, index);
      value += escape.value;
      valid &&= escape.valid;
      index = escape.nextIndex;
    } else if (character === "`") {
      if (!hasExpression) {
        tokens.push({ kind: "string", value: valid ? value : "", literalValid: valid });
      }
      return { tokens, nextIndex: index + 1 };
    } else if (character === "$" && source[index + 1] === "{") {
      if (!hasExpression) {
        // Keep the template itself visibly dynamic even when its first expression token happens to
        // be a string literal; otherwise static fragments could be mistaken for the runtime value.
        tokens.push({ kind: "string", value: "", literalValid: false });
      }
      hasExpression = true;
      const expression = tokenizeCode(source, index + 2, true);
      tokens.push(...expression.tokens);
      index = expression.nextIndex;
    } else {
      value += character ?? "";
      index += 1;
    }
  }
  if (!hasExpression) tokens.push({ kind: "string", value: "", literalValid: false });
  return { tokens, nextIndex: source.length };
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
      if (end === -1 || codePoint < 0 || codePoint > 0x10ffff) {
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
  if (closesControlFlowCondition(tokens)) return true;
  return ["return", "throw", "case"].includes(tokens.at(-1)?.value ?? "");
}

function closesControlFlowCondition(tokens: readonly BundleToken[]): boolean {
  if (tokens.at(-1)?.value !== ")") return false;
  let depth = 0;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index]?.value === ")") depth += 1;
    else if (tokens[index]?.value === "(") {
      depth -= 1;
      if (depth === 0) {
        return ["if", "while", "for", "with"].includes(tokens[index - 1]?.value ?? "");
      }
    }
  }
  return false;
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
