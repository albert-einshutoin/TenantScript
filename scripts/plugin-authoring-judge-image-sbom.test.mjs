import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { buildPluginAuthoringJudgeImage } from "./plugin-authoring-judge-image-build.mjs";
import {
  assertPluginAuthoringJudgeEvidenceSource,
  buildPluginAuthoringJudgeSbomInvocation,
  generatePluginAuthoringJudgeImageEvidence,
  preparePluginAuthoringJudgeEvidenceCliOutput
} from "./plugin-authoring-judge-image-evidence.mjs";
import {
  PLUGIN_AUTHORING_JUDGE_IMAGE_ARCHIVE_MAX_BYTES,
  PLUGIN_AUTHORING_JUDGE_SBOM_MAX_COMPONENTS,
  validatePluginAuthoringJudgeImageEvidence,
  validatePluginAuthoringJudgeImageSbom
} from "./plugin-authoring-judge-image-sbom.mjs";

const revision = "a".repeat(40);
const imageId = `sha256:${"b".repeat(64)}`;

test("builds from the reviewed context with one fixed linux amd64 Docker contract", () => {
  const calls = [];
  const temporaryRoot = mkdtempSync(join(tmpdir(), "judge-image-build-contract-"));
  const result = buildPluginAuthoringJudgeImage({
    repositoryRoot: resolve(import.meta.dirname, ".."),
    image: "tenantscript/plugin-authoring-judge:contract",
    sourceRevision: revision,
    temporaryRootFactory: () => temporaryRoot,
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      if (args[0] === "image" && args[1] === "inspect") {
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify([
            {
              Architecture: "amd64",
              Os: "linux",
              Id: imageId,
              // Docker engines report this storage field differently. The portable byte budget is
              // enforced against the saved archive that the scanner actually consumes.
              Size: 900_000_000,
              Config: {
                User: "node",
                Entrypoint: ["/opt/tenantscript/bin/plugin-authoring-judge"],
                Labels: { "org.opencontainers.image.revision": revision }
              }
            }
          ]),
          stderr: ""
        };
      }
      return { status: 0, signal: null, stdout: "", stderr: "" };
    }
  });

  assert.equal(result.id, imageId);
  assert.match(result.contextSha256, /^[0-9a-f]{64}$/u);
  assert.equal(existsSync(temporaryRoot), false);
  assert.deepEqual(calls[0].args, [
    "build",
    "--platform=linux/amd64",
    `--build-arg=SOURCE_REVISION=${revision}`,
    "--file=deploy/plugin-authoring-judge/Dockerfile",
    "--tag=tenantscript/plugin-authoring-judge:contract",
    "."
  ]);
});

test("does not delete a factory-provided directory before establishing ownership", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "judge-image-unowned-"));
  const marker = join(temporaryRoot, "owner-file");
  writeFileSync(marker, "preserve");
  try {
    assert.throws(
      () =>
        buildPluginAuthoringJudgeImage({
          repositoryRoot: resolve(import.meta.dirname, ".."),
          image: "tenantscript/plugin-authoring-judge:contract",
          sourceRevision: revision,
          temporaryRootFactory: () => temporaryRoot,
          spawnSyncImpl() {
            assert.fail("Docker must not run for an unowned temporary root");
          }
        }),
      /plugin authoring judge image preflight failed/u
    );
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("preserves an unowned SBOM temporary directory before scanner execution", async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "judge-sbom-unowned-"));
  const marker = join(temporaryRoot, "owner-file");
  const output = mkdtempSync(join(tmpdir(), "judge-sbom-output-"));
  rmSync(output, { recursive: true });
  writeFileSync(marker, "preserve");
  try {
    await assert.rejects(
      generatePluginAuthoringJudgeImageEvidence({
        repositoryRoot: resolve(import.meta.dirname, ".."),
        outputDirectory: output,
        build: {
          image: "tenantscript/plugin-authoring-judge:contract",
          id: imageId,
          sourceRevision: revision,
          contextSha256: "4".repeat(64),
          platform: "linux/amd64"
        },
        temporaryRootFactory: () => temporaryRoot,
        spawnSyncImpl() {
          assert.fail("Docker must not run for an unowned temporary root");
        }
      }),
      /plugin authoring judge image evidence preflight failed/u
    );
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test("binds CLI evidence to a clean revision while excluding user-owned runtime state", () => {
  const calls = [];
  assertPluginAuthoringJudgeEvidenceSource({
    repositoryRoot: resolve(import.meta.dirname, ".."),
    spawnSyncImpl(command, args) {
      calls.push({ command, args });
      return { status: 0, signal: null, stdout: "", stderr: "" };
    }
  });
  assert.equal(calls.length, 3);
  assert.ok(calls[0].args.includes(":(exclude).devloop/**"));
  assert.ok(calls[0].args.includes(":(exclude).tmp/**"));
  assert.ok(calls[2].args.includes(":(exclude).devloop/**"));
  assert.ok(calls[2].args.includes(":(exclude).tmp/**"));

  assert.throws(
    () =>
      assertPluginAuthoringJudgeEvidenceSource({
        repositoryRoot: resolve(import.meta.dirname, ".."),
        spawnSyncImpl(command, args) {
          return {
            status: args[0] === "diff" ? 1 : 0,
            signal: null,
            stdout: "",
            stderr: ""
          };
        }
      }),
    { name: "AssertionError" }
  );
});

test("creates a missing safe CLI evidence root on a fresh checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "judge-evidence-fresh-checkout-"));
  try {
    const output = join(root, ".tmp", "plugin-authoring-judge-image-evidence");
    preparePluginAuthoringJudgeEvidenceCliOutput({
      repositoryRoot: root,
      outputDirectory: output
    });
    const metadata = lstatSync(join(root, ".tmp"));
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.isSymbolicLink(), false);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses a fixed offline read-only scanner invocation without Docker socket access", () => {
  const invocation = buildPluginAuthoringJudgeSbomInvocation({
    archivePath: "/tmp/judge-image.tar",
    imageId
  });
  assert.equal(invocation.command, "docker");
  for (const required of [
    "--platform=linux/amd64",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--user=65532:65532",
    "--env=SYFT_CHECK_FOR_APP_UPDATE=false",
    "--mount=type=bind,src=/tmp/judge-image.tar,dst=/scan/image.tar,readonly",
    "anchore/syft@sha256:9a9f85314017f1ea798fb012edfa7fe9259923910f82c8d4bc983ab5c765e60b",
    "docker-archive:/scan/image.tar",
    `--source-version=${imageId}`,
    "--output=cyclonedx-json"
  ]) {
    assert.ok(invocation.args.includes(required), `missing ${required}`);
  }
  assert.equal(
    invocation.args.some((argument) => argument.includes("docker.sock")),
    false
  );
  assert.equal(
    invocation.args.some((argument) => /password|token|credential/iu.test(argument)),
    false
  );
  assert.throws(
    () =>
      buildPluginAuthoringJudgeSbomInvocation({
        archivePath: "/tmp/image.tar,dst=/escape",
        imageId
      }),
    { name: "AssertionError" }
  );
});

test("accepts a bounded CycloneDX inventory and source-bound candidate evidence", () => {
  const sbom = validSbom();
  const summary = validatePluginAuthoringJudgeImageSbom(sbom);
  assert.deepEqual(summary, { components: 9, dependencies: 1 });

  const evidence = validEvidence(sbom);
  assert.deepEqual(
    validatePluginAuthoringJudgeImageEvidence(evidence, sbom, {
      sourceRevision: revision,
      imageId,
      sbomSha256: "1".repeat(64)
    }),
    evidence
  );
});

test("rejects malformed, incomplete, development, and unsafe SBOM inventories", () => {
  const cases = [
    ["unsupported version", (sbom) => (sbom.specVersion = "1.6")],
    ["duplicate component", (sbom) => sbom.components.push(structuredClone(sbom.components[0]))],
    ["missing dependency", (sbom) => sbom.dependencies[0].dependsOn.push("missing-ref")],
    [
      "missing Node",
      (sbom) => (sbom.components = sbom.components.filter(({ name }) => name !== "node"))
    ],
    [
      "development package",
      (sbom) => sbom.components.push(component("@tenantscript/test-config", "0.0.0", "library"))
    ],
    ["machine path", (sbom) => (sbom.components[0].name = "/Users/example/private")],
    ["secret-shaped value", (sbom) => (sbom.components[0].name = `ghp_${"x".repeat(36)}`)]
  ];

  for (const [name, mutate] of cases) {
    const sbom = validSbom();
    mutate(sbom);
    assert.throws(
      () => validatePluginAuthoringJudgeImageSbom(sbom),
      /judge image SBOM is invalid/u,
      name
    );
  }

  const oversized = validSbom();
  while (oversized.components.length <= PLUGIN_AUTHORING_JUDGE_SBOM_MAX_COMPONENTS) {
    oversized.components.push(component(`bounded-${String(oversized.components.length)}`, "1.0.0"));
  }
  assert.throws(
    () => validatePluginAuthoringJudgeImageSbom(oversized),
    /judge image SBOM is invalid/u
  );
});

test("rejects evidence identity drift, approval claims, and unknown fields", () => {
  const cases = [
    ["source drift", (evidence) => (evidence.sourceRevision = "c".repeat(40))],
    ["image drift", (evidence) => (evidence.image.id = `sha256:${"d".repeat(64)}`)],
    [
      "archive over budget",
      (evidence) =>
        (evidence.image.archiveBytes = PLUGIN_AUTHORING_JUDGE_IMAGE_ARCHIVE_MAX_BYTES + 1)
    ],
    ["SBOM drift", (evidence) => (evidence.sbom.sha256 = "e".repeat(64))],
    ["approval claim", (evidence) => (evidence.decision.status = "approved")],
    ["missing blocker", (evidence) => evidence.decision.blockers.pop()],
    ["unknown field", (evidence) => (evidence.registryDigest = `sha256:${"f".repeat(64)}`)]
  ];

  for (const [name, mutate] of cases) {
    const sbom = validSbom();
    const evidence = validEvidence(sbom);
    mutate(evidence);
    assert.throws(
      () =>
        validatePluginAuthoringJudgeImageEvidence(evidence, sbom, {
          sourceRevision: revision,
          imageId,
          sbomSha256: "1".repeat(64)
        }),
      /judge image evidence is invalid/u,
      name
    );
  }
});

function validSbom() {
  const components = [
    component("node", "24.2.0", "application", "pkg:generic/node@24.2.0"),
    component("typescript", "5.9.3"),
    component("esbuild", "0.28.1"),
    component("@tenantscript/cli", "0.0.0"),
    component("@tenantscript/control-plane", "0.0.0"),
    component("@tenantscript/host-sdk", "0.0.0"),
    component("@tenantscript/loader", "0.0.0"),
    component("@tenantscript/manifest", "0.0.0"),
    component("debian", "12", "operating-system", "pkg:generic/debian@12")
  ];
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000000",
    version: 1,
    metadata: {
      timestamp: "2026-01-01T00:00:00Z",
      component: {
        "bom-ref": "judge-image",
        type: "container",
        name: "tenantscript/plugin-authoring-judge",
        version: imageId
      },
      tools: {
        components: [{ type: "application", author: "anchore", name: "syft", version: "1.49.0" }]
      }
    },
    components,
    dependencies: [{ ref: components[3]["bom-ref"], dependsOn: [components[4]["bom-ref"]] }]
  };
}

function component(name, version, type = "library", purl = `pkg:npm/${name}@${version}`) {
  return { "bom-ref": purl, type, name, version, purl };
}

function validEvidence(sbom) {
  return {
    schemaVersion: 1,
    kind: "plugin-authoring-judge-image-candidate",
    platform: "linux/amd64",
    sourceRevision: revision,
    inputs: {
      baseImage: "node@sha256:1a6a7b2e2e2c80a6973f57aa8b0c6ad67a961ddbc5ef326c448e133f93564ff9",
      dockerfileFrontend:
        "docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e",
      dockerfileSha256: "2".repeat(64),
      lockfileSha256: "3".repeat(64),
      contextSha256: "4".repeat(64)
    },
    image: {
      reference: "tenantscript/plugin-authoring-judge:evidence",
      id: imageId,
      archiveSha256: "5".repeat(64),
      archiveBytes: 120_000_000
    },
    sbom: {
      format: "CycloneDX",
      specVersion: "1.7",
      sha256: "1".repeat(64),
      bytes: 1_000_000,
      components: sbom.components.length,
      dependencies: sbom.dependencies.length,
      scanner: {
        name: "syft",
        version: "1.49.0",
        image:
          "anchore/syft@sha256:9a9f85314017f1ea798fb012edfa7fe9259923910f82c8d4bc983ab5c765e60b"
      }
    },
    decision: {
      status: "candidate",
      blockers: ["attestation", "independent-review", "registry-digest"]
    }
  };
}
