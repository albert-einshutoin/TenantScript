#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPluginAuthoringJudgeImage } from "./plugin-authoring-judge-image-build.mjs";
import { PLUGIN_AUTHORING_JUDGE_IMAGE_BASE } from "./plugin-authoring-judge-image-context.mjs";
import {
  PLUGIN_AUTHORING_JUDGE_DOCKERFILE_FRONTEND,
  PLUGIN_AUTHORING_JUDGE_SBOM_MAX_BYTES,
  PLUGIN_AUTHORING_JUDGE_SBOM_SCANNER_IMAGE,
  PLUGIN_AUTHORING_JUDGE_SBOM_SCANNER_VERSION,
  validatePluginAuthoringJudgeImageEvidence,
  validatePluginAuthoringJudgeImageSbom
} from "./plugin-authoring-judge-image-sbom.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceImage = "tenantscript/plugin-authoring-judge:evidence";

export async function generatePluginAuthoringJudgeImageEvidence({
  repositoryRoot,
  outputDirectory,
  build,
  spawnSyncImpl = spawnSync,
  temporaryRootFactory
}) {
  let temporaryRoot;
  let temporaryRootOwned = false;
  let outputOwned = false;
  try {
    const root = resolve(repositoryRoot);
    const output = resolve(outputDirectory);
    assert(isAbsolute(output) && output !== root);
    assertMissing(output);
    assertBuildRecord(build);
    temporaryRoot = resolve(
      temporaryRootFactory?.() ?? mkdtempSync(join(tmpdir(), "tenantscript-judge-image-sbom-"))
    );
    assertSafeTemporaryRoot(temporaryRoot);
    temporaryRootOwned = true;
    const archivePath = join(temporaryRoot, "image.tar");
    const archiveResult = run(
      spawnSyncImpl,
      "docker",
      ["image", "save", `--output=${archivePath}`, build.image],
      { timeout: 120_000 }
    );
    assert(archiveResult.stdout === "");
    const archive = statSync(archivePath);
    assert(archive.isFile() && archive.size >= 1 && archive.size <= 256 * 1024 * 1024);
    const archiveSha256 = await digestFile(archivePath);

    const scannerInvocation = buildPluginAuthoringJudgeSbomInvocation({
      archivePath,
      imageId: build.id
    });
    const scanner = run(spawnSyncImpl, scannerInvocation.command, scannerInvocation.args, {
      timeout: scannerInvocation.timeoutMs,
      maxBuffer: PLUGIN_AUTHORING_JUDGE_SBOM_MAX_BYTES
    });
    const sbomBytes = Buffer.from(scanner.stdout, "utf8");
    assert(sbomBytes.length >= 1 && sbomBytes.length <= PLUGIN_AUTHORING_JUDGE_SBOM_MAX_BYTES);
    const sbom = JSON.parse(sbomBytes.toString("utf8"));
    const summary = validatePluginAuthoringJudgeImageSbom(sbom);
    const sbomSha256 = digestBytes(sbomBytes);
    const evidence = {
      schemaVersion: 1,
      kind: "plugin-authoring-judge-image-candidate",
      platform: "linux/amd64",
      sourceRevision: build.sourceRevision,
      inputs: {
        baseImage: PLUGIN_AUTHORING_JUDGE_IMAGE_BASE,
        dockerfileFrontend: PLUGIN_AUTHORING_JUDGE_DOCKERFILE_FRONTEND,
        dockerfileSha256: digestBytes(
          readFileSync(join(root, "deploy/plugin-authoring-judge/Dockerfile"))
        ),
        lockfileSha256: digestBytes(readFileSync(join(root, "pnpm-lock.yaml"))),
        contextSha256: build.contextSha256
      },
      image: {
        reference: evidenceImage,
        id: build.id,
        archiveSha256,
        archiveBytes: archive.size
      },
      sbom: {
        format: "CycloneDX",
        specVersion: "1.7",
        sha256: sbomSha256,
        bytes: sbomBytes.length,
        components: summary.components,
        dependencies: summary.dependencies,
        scanner: {
          name: "syft",
          version: PLUGIN_AUTHORING_JUDGE_SBOM_SCANNER_VERSION,
          image: PLUGIN_AUTHORING_JUDGE_SBOM_SCANNER_IMAGE
        }
      },
      decision: {
        status: "candidate",
        blockers: ["attestation", "independent-review", "registry-digest"]
      }
    };
    validatePluginAuthoringJudgeImageEvidence(evidence, sbom, {
      sourceRevision: build.sourceRevision,
      imageId: build.id,
      sbomSha256
    });

    mkdirSync(output, { mode: 0o700 });
    outputOwned = true;
    writeFileSync(join(output, "judge-image.cdx.json"), sbomBytes, { flag: "wx", mode: 0o600 });
    writeFileSync(
      join(output, "judge-image-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      {
        flag: "wx",
        mode: 0o600
      }
    );
    return Object.freeze({ outputDirectory: output, evidence });
  } catch {
    if (outputOwned) rmSync(resolve(outputDirectory), { recursive: true, force: true });
    throw new Error("plugin authoring judge image evidence generation failed");
  } finally {
    if (temporaryRootOwned) rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function buildPluginAuthoringJudgeSbomInvocation({ archivePath, imageId }) {
  assert(
    isAbsolute(archivePath) &&
      !/[\n\r,]/u.test(archivePath) &&
      /^sha256:[0-9a-f]{64}$/u.test(imageId)
  );
  return Object.freeze({
    command: "docker",
    timeoutMs: 180_000,
    args: Object.freeze([
      "run",
      "--rm",
      "--platform=linux/amd64",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--pids-limit=256",
      "--memory=2g",
      "--memory-swap=2g",
      "--cpus=2",
      "--user=65532:65532",
      "--env=SYFT_CHECK_FOR_APP_UPDATE=false",
      "--env=SYFT_CACHE_DIR=/tmp/cache",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=1g,uid=65532,gid=65532,mode=0700",
      `--mount=type=bind,src=${archivePath},dst=/scan/image.tar,readonly`,
      PLUGIN_AUTHORING_JUDGE_SBOM_SCANNER_IMAGE,
      "scan",
      "docker-archive:/scan/image.tar",
      "--source-name=tenantscript/plugin-authoring-judge",
      `--source-version=${imageId}`,
      "--quiet",
      "--output=cyclonedx-json"
    ])
  });
}

export async function buildAndGeneratePluginAuthoringJudgeImageEvidence({
  repositoryRoot,
  outputDirectory,
  sourceRevision,
  spawnSyncImpl = spawnSync
}) {
  let built = false;
  try {
    const build = buildPluginAuthoringJudgeImage({
      repositoryRoot,
      image: evidenceImage,
      sourceRevision,
      spawnSyncImpl
    });
    built = true;
    return await generatePluginAuthoringJudgeImageEvidence({
      repositoryRoot,
      outputDirectory,
      build,
      spawnSyncImpl
    });
  } finally {
    if (built) {
      spawnSyncImpl("docker", ["image", "rm", "--force", evidenceImage], {
        encoding: "utf8",
        timeout: 30_000
      });
    }
  }
}

export function preparePluginAuthoringJudgeEvidenceCliOutput({ repositoryRoot, outputDirectory }) {
  const root = resolve(repositoryRoot);
  const output = resolve(outputDirectory);
  const temporaryRoot = resolve(root, ".tmp");
  assert(output.startsWith(`${temporaryRoot}${sep}`));
  try {
    const metadata = lstatSync(temporaryRoot);
    assert(metadata.isDirectory() && !metadata.isSymbolicLink());
  } catch (error) {
    assert(error?.code === "ENOENT");
    mkdirSync(temporaryRoot, { mode: 0o700 });
  }
  let cursor = dirname(output);
  while (cursor !== root) {
    try {
      assert(!lstatSync(cursor).isSymbolicLink());
    } catch (error) {
      assert(error?.code === "ENOENT");
    }
    if (cursor === temporaryRoot) break;
    cursor = dirname(cursor);
  }
}

export function assertPluginAuthoringJudgeEvidenceSource({
  repositoryRoot,
  spawnSyncImpl = spawnSync
}) {
  const root = resolve(repositoryRoot);
  const diffPathspec = [".", ":(exclude).devloop/**", ":(exclude).tmp/**"];
  for (const args of [
    ["diff", "--quiet", "HEAD", "--", ...diffPathspec],
    ["diff", "--cached", "--quiet", "HEAD", "--", ...diffPathspec]
  ]) {
    const result = spawnSyncImpl("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000
    });
    assert(result.error === undefined && result.signal === null && result.status === 0);
  }
  const untracked = run(spawnSyncImpl, "git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: root,
    timeout: 30_000
  }).stdout;
  assert(untracked.trim() === "");
}

function assertBuildRecord(build) {
  assert(
    build?.image === evidenceImage ||
      /^tenantscript\/plugin-authoring-judge:[a-z0-9.-]+$/u.test(build?.image)
  );
  assert(/^sha256:[0-9a-f]{64}$/u.test(build?.id));
  assert(/^[0-9a-f]{40}$/u.test(build?.sourceRevision));
  assert(/^[0-9a-f]{64}$/u.test(build?.contextSha256));
  assert(build?.platform === "linux/amd64");
}

function assertMissing(path) {
  try {
    lstatSync(path);
    assert(false);
  } catch (error) {
    assert(error?.code === "ENOENT");
  }
}

function assertSafeTemporaryRoot(path) {
  const metadata = lstatSync(path);
  assert(metadata.isDirectory() && !metadata.isSymbolicLink());
  assert(readdirSync(path).length === 0);
}

function run(spawnSyncImpl, command, args, options = {}) {
  const result = spawnSyncImpl(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
    ...options
  });
  assert(result.error === undefined && result.signal === null && result.status === 0);
  return result;
}

function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function digestFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  try {
    assert(process.argv.length === 4 && process.argv[2] === "generate");
    const output = resolve(defaultRoot, process.argv[3]);
    preparePluginAuthoringJudgeEvidenceCliOutput({
      repositoryRoot: defaultRoot,
      outputDirectory: output
    });
    assertMissing(output);
    // The OCI revision label must describe the exact reviewed source. User-owned `.devloop` and
    // generated `.tmp` state are outside the allowlisted context and therefore do not block it.
    assertPluginAuthoringJudgeEvidenceSource({ repositoryRoot: defaultRoot });
    const revision = run(spawnSync, "git", ["rev-parse", "HEAD"], {
      cwd: defaultRoot,
      timeout: 30_000
    }).stdout.trim();
    const result = await buildAndGeneratePluginAuthoringJudgeImageEvidence({
      repositoryRoot: defaultRoot,
      outputDirectory: output,
      sourceRevision: revision
    });
    process.stdout.write(
      `Validated judge image SBOM evidence written to ${relative(defaultRoot, result.outputDirectory)}.\n`
    );
  } catch {
    process.stderr.write("plugin authoring judge image evidence generation failed\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
