import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import { auditPluginPackage as canonicalAuditPluginPackage } from "../packages/cli/dist/index.js";

import { verifyPluginAuthoringBuildReceipt } from "./plugin-authoring-build-contract.mjs";
import {
  MANIFEST_SOURCE_MAX_BYTES,
  extractPluginAuthoringManifest
} from "./plugin-authoring-manifest-extractor.mjs";

export const PLUGIN_AUTHORING_AUDIT_SDK_VERSION = "0.0.0";
export const PLUGIN_AUTHORING_PACKAGE_JSON_MAX_BYTES = 32 * 1024;

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const FINDING_CONTRACT = Object.freeze({
  bundle_capability_undeclared: [
    "error",
    "exact",
    "bundle contains a static capability call without a matching manifest grant"
  ],
  bundle_capability_usage_dynamic: [
    "warning",
    "heuristic",
    "bundle uses a dynamic capability name that cannot be compared with manifest grants"
  ],
  bundle_direct_egress_detected: [
    "warning",
    "heuristic",
    "bundle contains a direct fetch call that requires egress bypass review"
  ],
  bundle_grant_potentially_unused: [
    "warning",
    "heuristic",
    "manifest grant has no matching static capability call in the bundle"
  ],
  manifest_invalid: ["error", "exact", "manifest does not satisfy the closed TenantScript schema"],
  plugin_sdk_declaration_ambiguous: [
    "error",
    "exact",
    "plugin SDK must be declared in exactly one dependency section"
  ],
  plugin_sdk_missing: ["error", "exact", "plugin SDK dependency is required"],
  plugin_sdk_version_mismatch: [
    "error",
    "exact",
    "plugin SDK version does not match the auditing CLI version"
  ],
  plugin_sdk_version_unpinned: [
    "error",
    "exact",
    "plugin SDK dependency must use an exact version"
  ],
  plugin_tests_missing: ["error", "exact", "package must define a non-empty test script"],
  runtime_cpu_limit_high: ["warning", "exact", "CPU limit exceeds the scaffold review baseline"],
  runtime_timeout_limit_high: [
    "warning",
    "exact",
    "timeout limit exceeds the scaffold review baseline"
  ]
});

export function createPluginAuthoringAuditAdapter({
  auditPluginPackage = canonicalAuditPluginPackage
} = {}) {
  return (context) => {
    try {
      validateContext(context);
      assert(typeof auditPluginPackage === "function");
      const receipt = verifyPluginAuthoringBuildReceipt(context);
      const manifestSource = readStableUtf8File(
        join(context.taskRoot, "src", "manifest.ts"),
        MANIFEST_SOURCE_MAX_BYTES
      );
      const extractedManifest = extractPluginAuthoringManifest(manifestSource);
      assert(extractedManifest.ok === true);
      const packageJson = JSON.parse(
        readStableUtf8File(
          join(context.taskRoot, "package.json"),
          PLUGIN_AUTHORING_PACKAGE_JSON_MAX_BYTES
        )
      );
      validateBoundedJson(packageJson);
      const bundleCode = readStableUtf8File(receipt.bundlePath, receipt.bundleBytes);

      // Rechecking after every static read closes source/bundle replacement races against the
      // judge-owned receipt. Candidate scripts, config, and prebuilt artifacts are never loaded.
      const finalReceipt = verifyPluginAuthoringBuildReceipt(context);
      assert(receiptsEqual(receipt, finalReceipt));
      const report = auditPluginPackage({
        manifest: extractedManifest.value,
        packageJson: projectPackageMetadata(packageJson),
        expectedSdkVersion: PLUGIN_AUTHORING_AUDIT_SDK_VERSION,
        bundleCode
      });
      validateAuditReport(report);

      // The public CLI distinguishes warnings from hard errors. The isolated judge is stricter:
      // heuristic uncertainty is not evidence of safety, so every finding fails this gate.
      return report.passed === true && report.findings.length === 0;
    } catch {
      return false;
    }
  };
}

function validateContext(context) {
  assert(isPlainRecord(context));
  assertExactKeys(context, ["task", "baselineRoot", "taskRoot", "taskWorkspace"]);
  assert(isPlainRecord(context.task));
  assert(typeof context.task.id === "string");
  for (const path of [context.baselineRoot, context.taskRoot, context.taskWorkspace]) {
    assert(typeof path === "string" && isAbsolute(path) && resolve(path) === path);
    const metadata = lstatSync(path);
    assert(metadata.isDirectory() && !metadata.isSymbolicLink());
  }
  assert(context.taskRoot === join(context.taskWorkspace, "source"));
}

function readStableUtf8File(path, maximumBytes) {
  const before = lstatSync(path);
  assert(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1 &&
      before.size >= 1 &&
      before.size <= maximumBytes
  );
  const bytes = readFileSync(path);
  const after = lstatSync(path);
  assert(bytes.length === before.size && sameFileMetadata(before, after));
  return textDecoder.decode(bytes);
}

function sameFileMetadata(left, right) {
  return (
    right.isFile() &&
    !right.isSymbolicLink() &&
    right.nlink === 1 &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function validateBoundedJson(root) {
  let nodes = 0;
  const visit = (value, depth) => {
    nodes += 1;
    assert(nodes <= 512 && depth <= 8);
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number") {
      assert(Number.isFinite(value));
      return;
    }
    if (typeof value === "string") {
      assert(value.length <= 1_024);
      return;
    }
    if (Array.isArray(value)) {
      assert(value.length <= 64);
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    assert(isPlainRecord(value));
    const entries = Object.entries(value);
    assert(entries.length <= 64);
    for (const [key, entry] of entries) {
      assert(key.length >= 1 && key.length <= 128 && !FORBIDDEN_KEYS.has(key));
      visit(entry, depth + 1);
    }
  };
  visit(root, 0);
}

function projectPackageMetadata(packageJson) {
  assert(isPlainRecord(packageJson));
  return Object.fromEntries(
    ["scripts", "dependencies", "devDependencies"]
      .filter((key) => packageJson[key] !== undefined)
      .map((key) => [key, packageJson[key]])
  );
}

function validateAuditReport(report) {
  assertExactKeys(report, ["version", "passed", "findings"]);
  assert(report.version === 1 && typeof report.passed === "boolean");
  assert(Array.isArray(report.findings) && report.findings.length <= 64);
  let previous;
  for (const finding of report.findings) {
    assertExactKeys(finding, ["code", "severity", "certainty", "path", "message"]);
    const contract = FINDING_CONTRACT[finding.code];
    assert(contract !== undefined);
    assert(
      finding.severity === contract[0] &&
        finding.certainty === contract[1] &&
        finding.message === contract[2]
    );
    assert(validateFindingPath(finding.code, finding.path));
    if (previous !== undefined) assert(compareFindings(previous, finding) <= 0);
    previous = finding;
  }
  assert(report.passed === report.findings.every((finding) => finding.severity !== "error"));
}

function validateFindingPath(code, path) {
  if (typeof path !== "string" || path.length < 1 || path.length > 240) return false;
  const fixedPaths = {
    bundle_capability_undeclared: "bundle.capabilityCalls.*",
    bundle_capability_usage_dynamic: "bundle.capabilityCalls.*",
    bundle_direct_egress_detected: "bundle.egressCalls.*",
    bundle_grant_potentially_unused: "manifest.capabilities.*",
    plugin_tests_missing: "package.scripts.test",
    runtime_cpu_limit_high: "manifest.limits.cpuMs",
    runtime_timeout_limit_high: "manifest.limits.timeoutMs"
  };
  if (fixedPaths[code] !== undefined) return path === fixedPaths[code];
  if (code === "manifest_invalid") {
    const allowed = new Set([
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
    const segments = path.split(".");
    return (
      segments.shift() === "manifest" &&
      segments.every((segment) => segment === "*" || /^\d+$/u.test(segment) || allowed.has(segment))
    );
  }
  if (code.startsWith("plugin_sdk_")) {
    return (
      path === "package.dependencies.@tenantscript/plugin-sdk" ||
      path === "package.devDependencies.@tenantscript/plugin-sdk"
    );
  }
  return false;
}

function compareFindings(left, right) {
  return (
    severityRank(left.severity) - severityRank(right.severity) ||
    compareText(left.code, right.code) ||
    compareText(left.path, right.path)
  );
}

function severityRank(severity) {
  return severity === "error" ? 0 : 1;
}

function receiptsEqual(left, right) {
  return [
    "schemaVersion",
    "contractVersion",
    "taskId",
    "sourceSha256",
    "bundleSha256",
    "bundleBytes"
  ].every((key) => left[key] === right[key]);
}

function assertExactKeys(value, keys) {
  assert(isPlainRecord(value));
  assert(
    Object.keys(value).sort(compareText).join("\0") === [...keys].sort(compareText).join("\0")
  );
}

function isPlainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assert(condition) {
  if (!condition) throw new Error("assertion failed");
}
