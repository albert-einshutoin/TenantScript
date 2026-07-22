import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { stagePluginAuthoringJudgeImageContext } from "./plugin-authoring-judge-image-context.mjs";

export const PLUGIN_AUTHORING_JUDGE_IMAGE_PLATFORM = "linux/amd64";
export const PLUGIN_AUTHORING_JUDGE_IMAGE_ENTRYPOINT =
  "/opt/tenantscript/bin/plugin-authoring-judge";

const imagePattern = /^tenantscript\/plugin-authoring-judge:[a-z0-9][a-z0-9.-]{0,63}$/u;
const revisionPattern = /^[0-9a-f]{40}$/u;

export function buildPluginAuthoringJudgeImage({
  repositoryRoot,
  image,
  sourceRevision,
  spawnSyncImpl = spawnSync,
  temporaryRootFactory = () => mkdtempSync(join(tmpdir(), "tenantscript-judge-image-build-"))
}) {
  let temporaryRoot;
  let temporaryRootOwned = false;
  let phase = "preflight";
  try {
    const root = resolve(repositoryRoot);
    assert(imagePattern.test(image));
    assert(revisionPattern.test(sourceRevision));
    temporaryRoot = resolve(temporaryRootFactory());
    assertSafeTemporaryRoot(temporaryRoot);
    temporaryRootOwned = true;
    const contextRoot = join(temporaryRoot, "context");
    const staged = stagePluginAuthoringJudgeImageContext({
      repositoryRoot: root,
      outputRoot: contextRoot
    });
    const contextSha256 = digestContext(contextRoot, staged.paths);
    phase = "Docker build";
    run(
      spawnSyncImpl,
      "docker",
      [
        "build",
        `--platform=${PLUGIN_AUTHORING_JUDGE_IMAGE_PLATFORM}`,
        `--build-arg=SOURCE_REVISION=${sourceRevision}`,
        "--file=deploy/plugin-authoring-judge/Dockerfile",
        `--tag=${image}`,
        "."
      ],
      { cwd: contextRoot, timeout: 180_000 }
    );
    phase = "image inspection";
    const inspection = JSON.parse(
      run(spawnSyncImpl, "docker", ["image", "inspect", image], { timeout: 30_000 }).stdout
    );
    assert(Array.isArray(inspection) && inspection.length === 1);
    const record = inspection[0];
    assert(record.Architecture === "amd64" && record.Os === "linux");
    assert(record.Config?.User === "node");
    assert.deepEqual(record.Config?.Entrypoint, [PLUGIN_AUTHORING_JUDGE_IMAGE_ENTRYPOINT]);
    assert(record.Config?.Labels?.["org.opencontainers.image.revision"] === sourceRevision);
    assert(/^sha256:[0-9a-f]{64}$/u.test(record.Id));
    assert(
      Number.isSafeInteger(record.Size) && record.Size >= 1 && record.Size <= 256 * 1024 * 1024
    );
    return Object.freeze({
      image,
      id: record.Id,
      sizeBytes: record.Size,
      sourceRevision,
      contextSha256,
      platform: PLUGIN_AUTHORING_JUDGE_IMAGE_PLATFORM
    });
  } catch {
    throw new Error(`plugin authoring judge image ${phase} failed`);
  } finally {
    if (temporaryRootOwned) rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function assertSafeTemporaryRoot(path) {
  const metadata = lstatSync(path);
  assert(metadata.isDirectory() && !metadata.isSymbolicLink());
  assert(readdirSync(path).length === 0);
}

function digestContext(contextRoot, paths) {
  const hash = createHash("sha256");
  for (const path of paths) {
    const bytes = readFileSync(join(contextRoot, path));
    hash.update(`${String(Buffer.byteLength(path))}:`);
    hash.update(path);
    hash.update(`${String(bytes.length)}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function run(spawnSyncImpl, command, args, options = {}) {
  const result = spawnSyncImpl(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
    ...options
  });
  assert(result.error === undefined);
  assert(result.signal === null);
  assert(result.status === 0);
  return result;
}
