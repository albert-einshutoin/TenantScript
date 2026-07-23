import assert from "node:assert/strict";

import { PLUGIN_AUTHORING_JUDGE_IMAGE_BASE } from "./plugin-authoring-judge-image-context.mjs";

export const PLUGIN_AUTHORING_JUDGE_SBOM_MAX_BYTES = 8 * 1024 * 1024;
export const PLUGIN_AUTHORING_JUDGE_IMAGE_ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
export const PLUGIN_AUTHORING_JUDGE_SBOM_MAX_COMPONENTS = 6_000;
export const PLUGIN_AUTHORING_JUDGE_SBOM_MAX_DEPENDENCIES = 2_000;
export const PLUGIN_AUTHORING_JUDGE_SBOM_SCANNER_IMAGE =
  "anchore/syft@sha256:9a9f85314017f1ea798fb012edfa7fe9259923910f82c8d4bc983ab5c765e60b";
export const PLUGIN_AUTHORING_JUDGE_SBOM_SCANNER_VERSION = "1.49.0";
export const PLUGIN_AUTHORING_JUDGE_DOCKERFILE_FRONTEND =
  "docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e";

const requiredComponents = new Map([
  ["node", "24.2.0"],
  ["typescript", "5.9.3"],
  ["esbuild", "0.28.1"],
  ["@tenantscript/cli", "0.0.0"],
  ["@tenantscript/control-plane", "0.0.0"],
  ["@tenantscript/host-sdk", "0.0.0"],
  ["@tenantscript/loader", "0.0.0"],
  ["@tenantscript/manifest", "0.0.0"]
]);
const forbiddenComponents = new Set([
  "@changesets/cli",
  "@playwright/test",
  "@tenantscript/test-config",
  "eslint",
  "playwright",
  "prettier",
  "vitest",
  "wrangler"
]);
const digestPattern = /^[0-9a-f]{64}$/u;
const imageIdPattern = /^sha256:[0-9a-f]{64}$/u;
const revisionPattern = /^[0-9a-f]{40}$/u;
const forbiddenValuePatterns = [
  /(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/u,
  /sk-[A-Za-z0-9_-]{20,}/u,
  /\/Users\//u,
  /\/Volumes\//u,
  /[A-Za-z]:\\Users\\/u,
  /\/home\/runner(?:\/|$)/u,
  /\/workspace(?:\/|$)/u
];

export function validatePluginAuthoringJudgeImageSbom(sbom) {
  try {
    assert(isRecord(sbom));
    assert(sbom.bomFormat === "CycloneDX" && sbom.specVersion === "1.7");
    assert(typeof sbom.serialNumber === "string" && sbom.serialNumber.startsWith("urn:uuid:"));
    assert(sbom.version === 1);
    assert(isRecord(sbom.metadata));
    assert(isRecord(sbom.metadata.component));
    assert(sbom.metadata.component.type === "container");
    assert(sbom.metadata.component.name === "tenantscript/plugin-authoring-judge");
    assert(imageIdPattern.test(sbom.metadata.component.version));
    assert(typeof sbom.metadata.component["bom-ref"] === "string");
    assert(isRecord(sbom.metadata.tools));
    assert(Array.isArray(sbom.metadata.tools.components));
    assert(
      sbom.metadata.tools.components.some(
        (tool) =>
          isRecord(tool) &&
          tool.name === "syft" &&
          tool.version === PLUGIN_AUTHORING_JUDGE_SBOM_SCANNER_VERSION
      )
    );

    assert(
      Array.isArray(sbom.components) &&
        sbom.components.length >= requiredComponents.size &&
        sbom.components.length <= PLUGIN_AUTHORING_JUDGE_SBOM_MAX_COMPONENTS
    );
    const componentRefs = new Set();
    for (const component of sbom.components) {
      assert(isRecord(component));
      assert(typeof component["bom-ref"] === "string" && component["bom-ref"].length <= 1_024);
      assert(!componentRefs.has(component["bom-ref"]));
      componentRefs.add(component["bom-ref"]);
      assert(typeof component.name === "string" && component.name.length >= 1);
      assert(
        component.type === "file"
          ? component.version === undefined ||
              (typeof component.version === "string" && component.version.length >= 1)
          : typeof component.version === "string" && component.version.length >= 1
      );
      assert(!forbiddenComponents.has(component.name));
    }
    for (const [name, version] of requiredComponents) {
      assert(
        sbom.components.some(
          (component) => component.name === name && component.version === version
        )
      );
    }
    assert(sbom.components.some((component) => component.type === "operating-system"));

    assert(
      Array.isArray(sbom.dependencies) &&
        sbom.dependencies.length <= PLUGIN_AUTHORING_JUDGE_SBOM_MAX_DEPENDENCIES
    );
    const dependencyRefs = new Set();
    for (const dependency of sbom.dependencies) {
      assertExactKeys(dependency, ["dependsOn", "ref"]);
      assert(componentRefs.has(dependency.ref) && !dependencyRefs.has(dependency.ref));
      dependencyRefs.add(dependency.ref);
      assert(Array.isArray(dependency.dependsOn));
      assert(new Set(dependency.dependsOn).size === dependency.dependsOn.length);
      assert(dependency.dependsOn.every((reference) => componentRefs.has(reference)));
    }
    assertSafeValues(sbom);
    return Object.freeze({
      components: sbom.components.length,
      dependencies: sbom.dependencies.length
    });
  } catch {
    throw new Error("judge image SBOM is invalid");
  }
}

export function validatePluginAuthoringJudgeImageEvidence(evidence, sbom, contract) {
  try {
    const summary = validatePluginAuthoringJudgeImageSbom(sbom);
    assert(isRecord(contract));
    assert(revisionPattern.test(contract.sourceRevision));
    assert(imageIdPattern.test(contract.imageId));
    assert(digestPattern.test(contract.sbomSha256));
    assertExactKeys(evidence, [
      "decision",
      "image",
      "inputs",
      "kind",
      "platform",
      "sbom",
      "schemaVersion",
      "sourceRevision"
    ]);
    assert(evidence.schemaVersion === 1);
    assert(evidence.kind === "plugin-authoring-judge-image-candidate");
    assert(evidence.platform === "linux/amd64");
    assert(evidence.sourceRevision === contract.sourceRevision);

    assertExactKeys(evidence.inputs, [
      "baseImage",
      "contextSha256",
      "dockerfileFrontend",
      "dockerfileSha256",
      "lockfileSha256"
    ]);
    assert(evidence.inputs.baseImage === PLUGIN_AUTHORING_JUDGE_IMAGE_BASE);
    assert(evidence.inputs.dockerfileFrontend === PLUGIN_AUTHORING_JUDGE_DOCKERFILE_FRONTEND);
    for (const field of ["contextSha256", "dockerfileSha256", "lockfileSha256"]) {
      assert(digestPattern.test(evidence.inputs[field]));
    }

    assertExactKeys(evidence.image, ["archiveBytes", "archiveSha256", "id", "reference"]);
    assert(evidence.image.reference === "tenantscript/plugin-authoring-judge:evidence");
    assert(evidence.image.id === contract.imageId);
    assert(digestPattern.test(evidence.image.archiveSha256));
    assert(
      Number.isSafeInteger(evidence.image.archiveBytes) &&
        evidence.image.archiveBytes >= 1 &&
        evidence.image.archiveBytes <= PLUGIN_AUTHORING_JUDGE_IMAGE_ARCHIVE_MAX_BYTES
    );

    assertExactKeys(evidence.sbom, [
      "bytes",
      "components",
      "dependencies",
      "format",
      "scanner",
      "sha256",
      "specVersion"
    ]);
    assert(evidence.sbom.format === "CycloneDX" && evidence.sbom.specVersion === "1.7");
    assert(evidence.sbom.sha256 === contract.sbomSha256);
    assert(
      Number.isSafeInteger(evidence.sbom.bytes) &&
        evidence.sbom.bytes >= 1 &&
        evidence.sbom.bytes <= PLUGIN_AUTHORING_JUDGE_SBOM_MAX_BYTES
    );
    assert(evidence.sbom.components === summary.components);
    assert(evidence.sbom.dependencies === summary.dependencies);
    assertExactKeys(evidence.sbom.scanner, ["image", "name", "version"]);
    assert(evidence.sbom.scanner.name === "syft");
    assert(evidence.sbom.scanner.version === PLUGIN_AUTHORING_JUDGE_SBOM_SCANNER_VERSION);
    assert(evidence.sbom.scanner.image === PLUGIN_AUTHORING_JUDGE_SBOM_SCANNER_IMAGE);

    assertExactKeys(evidence.decision, ["blockers", "status"]);
    assert(evidence.decision.status === "candidate");
    assert.deepEqual(evidence.decision.blockers, [
      "attestation",
      "independent-review",
      "registry-digest"
    ]);
    assert(sbom.metadata.component.version === evidence.image.id);
    assertSafeValues(evidence);
    return evidence;
  } catch {
    throw new Error("judge image evidence is invalid");
  }
}

function assertSafeValues(root) {
  const stack = [root];
  let visited = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    visited += 1;
    assert(visited <= 250_000);
    if (typeof value === "string") {
      assert(Buffer.byteLength(value) <= 16_384);
      assert(forbiddenValuePatterns.every((pattern) => !pattern.test(value)));
      continue;
    }
    if (Array.isArray(value)) {
      assert(value.length <= PLUGIN_AUTHORING_JUDGE_SBOM_MAX_COMPONENTS);
      stack.push(...value);
      continue;
    }
    if (isRecord(value)) stack.push(...Object.values(value));
  }
}

function assertExactKeys(value, keys) {
  assert(isRecord(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
