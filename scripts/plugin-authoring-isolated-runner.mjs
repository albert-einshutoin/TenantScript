import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  computePluginAuthoringCorpusDigest,
  parsePluginAuthoringCorpus,
  parsePluginAuthoringResult
} from "./plugin-authoring-eval.mjs";

const SHA40_PATTERN = /^[0-9a-f]{40}$/u;
const SHA64_PATTERN = /^[0-9a-f]{64}$/u;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$/u;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_JUDGE_OUTPUT_BYTES = 1024 * 1024;
const MAX_CANDIDATE_FILES = 2_000;
const MAX_CANDIDATE_ENTRIES = 4_000;
const MAX_CANDIDATE_FILE_BYTES = 256 * 1024;
const MAX_CANDIDATE_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_CANDIDATE_DEPTH = 8;
const MAX_CANDIDATE_PATH_BYTES = 240;
const PROHIBITED_NAMES = new Set([
  ".git",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
  ".pnpmfile.cjs",
  ".pnpmfile.mjs",
  ".yarnrc",
  ".yarnrc.yml",
  "node_modules",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "pnpm-workspace.yml"
]);
const UNSAFE_TEXT_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /(?:file:\/\/(?:localhost)?\/|(?:^|[^A-Za-z0-9])\/)(?:Users|Volumes|home|workspace|root|tmp)\/|[A-Za-z]:\\(?:Users|Volumes|home|workspace|root|tmp)\\/iu,
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]/iu
];
const NEXT_ACTIONS = {
  "manifest-invalid":
    "Inspect manifest-invalid evidence and improve manifest guidance or the scaffold template.",
  "build-failed":
    "Inspect build-failed evidence and improve scaffold build guidance or dependency constraints.",
  "unit-test-failed":
    "Inspect unit-test-failed evidence and improve the TDD recipe or generated behavior tests.",
  "security-test-failed":
    "Inspect security-test-failed evidence and improve generated security tests or guidance.",
  "audit-failed":
    "Inspect audit-failed evidence and improve ext audit guidance or remove the unsafe pattern.",
  "least-privilege-failed":
    "Inspect least-privilege-failed evidence and reduce capabilities or improve authoring guidance."
};

export function parseIsolatedRunnerRequest(input, corpusInput) {
  try {
    const corpus = parsePluginAuthoringCorpus(corpusInput);
    assertPlainObject(input);
    assertExactKeys(input, [
      "schemaVersion",
      "repositoryRevision",
      "corpusDigest",
      "run",
      "sandbox"
    ]);
    assert(input.schemaVersion === 1);
    assertString(input.repositoryRevision, 40, 40, SHA40_PATTERN);
    assert(input.repositoryRevision === corpus.baselineRevision);
    assertString(input.corpusDigest, 64, 64, SHA64_PATTERN);
    assert(input.corpusDigest === computePluginAuthoringCorpusDigest(corpus));

    assertPlainObject(input.run);
    assertExactKeys(input.run, ["id", "agent", "model", "costUsd"]);
    assertSafeString(input.run.id, 1, 100, ID_PATTERN);
    assertSafeString(input.run.agent, 1, 80, NAME_PATTERN);
    assertSafeString(input.run.model, 1, 120, NAME_PATTERN);
    assert(
      input.run.costUsd === null ||
        (typeof input.run.costUsd === "number" &&
          Number.isFinite(input.run.costUsd) &&
          input.run.costUsd >= 0 &&
          input.run.costUsd <= 100_000)
    );

    assertPlainObject(input.sandbox);
    assertExactKeys(input.sandbox, [
      "image",
      "timeoutMs",
      "memoryMb",
      "cpuCount",
      "pidsLimit",
      "tmpfsMb"
    ]);
    assertString(input.sandbox.image, 1, 300, IMAGE_PATTERN);
    assertIntegerBetween(input.sandbox.timeoutMs, 1_000, 600_000);
    assertIntegerBetween(input.sandbox.memoryMb, 128, 2_048);
    assert(
      typeof input.sandbox.cpuCount === "number" &&
        Number.isFinite(input.sandbox.cpuCount) &&
        input.sandbox.cpuCount >= 0.25 &&
        input.sandbox.cpuCount <= 4
    );
    assertIntegerBetween(input.sandbox.pidsLimit, 16, 256);
    assertIntegerBetween(input.sandbox.tmpfsMb, 16, 256);
    return structuredClone(input);
  } catch {
    throw new Error("isolated runner request is invalid");
  }
}

export function inspectIsolatedCandidateBundle(
  candidateRootInput,
  corpusInput,
  { readFile = readFileSync } = {}
) {
  try {
    assert(typeof readFile === "function");
    const corpus = parsePluginAuthoringCorpus(corpusInput);
    const candidateRoot = resolve(candidateRootInput);
    const rootMetadata = lstatSync(candidateRoot);
    assert(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink());
    const expectedTasks = corpus.tasks.map((task) => task.id);
    const collection = { records: [], totalBytes: 0, totalEntries: 0, readFile };
    const rootEntries = readBoundedDirectoryEntries(candidateRoot, collection);
    assertArrayEquals(
      rootEntries.map((entry) => entry.name),
      expectedTasks
    );
    assert(rootEntries.every((entry) => entry.isDirectory() && !entry.isSymbolicLink()));

    const taskFileCounts = new Map(expectedTasks.map((taskId) => [taskId, 0]));
    for (const taskId of expectedTasks) {
      collectCandidateFiles(candidateRoot, join(candidateRoot, taskId), taskId, collection, 1);
    }
    const { records } = collection;
    assert(records.length >= expectedTasks.length && records.length <= MAX_CANDIDATE_FILES);

    let totalBytes = 0;
    const digest = createHash("sha256");
    for (const record of records.sort((left, right) => compareText(left.path, right.path))) {
      totalBytes += record.bytes.length;
      assert(totalBytes <= MAX_CANDIDATE_TOTAL_BYTES);
      taskFileCounts.set(record.taskId, taskFileCounts.get(record.taskId) + 1);
      digest.update(record.path);
      digest.update("\0");
      digest.update(String(record.bytes.length));
      digest.update("\0");
      digest.update(createHash("sha256").update(record.bytes).digest("hex"));
      digest.update("\n");
    }
    assert(expectedTasks.every((taskId) => taskFileCounts.get(taskId) >= 1));
    assert(totalBytes >= 1);

    const output = {
      digest: digest.digest("hex"),
      tasks: expectedTasks.length,
      files: records.length,
      totalBytes
    };
    Object.defineProperty(output, "records", { value: records, enumerable: false });
    return output;
  } catch {
    throw new Error("isolated candidate bundle is invalid");
  }
}

function collectCandidateFiles(root, current, taskId, collection, depth) {
  assert(depth <= MAX_CANDIDATE_DEPTH);
  const entries = readBoundedDirectoryEntries(current, collection);
  for (const entry of entries) {
    assert(PATH_SEGMENT_PATTERN.test(entry.name));
    assert(!entry.name.startsWith(".") && !PROHIBITED_NAMES.has(entry.name));
    assert(!entry.name.startsWith(".env"));
    const absolutePath = join(current, entry.name);
    const relativePath = relative(root, absolutePath).split(sep).join("/");
    assert(Buffer.byteLength(relativePath) <= MAX_CANDIDATE_PATH_BYTES);
    const metadata = lstatSync(absolutePath);
    assert(!metadata.isSymbolicLink());
    if (metadata.isDirectory()) {
      collectCandidateFiles(root, absolutePath, taskId, collection, depth + 1);
      continue;
    }
    assert(metadata.isFile() && metadata.nlink === 1);
    assert(metadata.size <= MAX_CANDIDATE_FILE_BYTES);
    // Reject from metadata before allocating the next file. The post-read check below still
    // protects the bound if a file changes size between inspection and retention.
    assert(collection.totalBytes + metadata.size <= MAX_CANDIDATE_TOTAL_BYTES);
    const bytes = collection.readFile(absolutePath);
    assert(Buffer.isBuffer(bytes));
    assert(collection.totalBytes + bytes.length <= MAX_CANDIDATE_TOTAL_BYTES);
    const afterRead = lstatSync(absolutePath);
    assert(
      afterRead.isFile() &&
        !afterRead.isSymbolicLink() &&
        afterRead.nlink === 1 &&
        afterRead.dev === metadata.dev &&
        afterRead.ino === metadata.ino &&
        afterRead.size === metadata.size &&
        afterRead.mtimeMs === metadata.mtimeMs
    );
    collection.totalBytes += bytes.length;
    collection.records.push({ taskId, path: relativePath, bytes });
    assert(collection.records.length <= MAX_CANDIDATE_FILES);
  }
}

function readBoundedDirectoryEntries(path, collection) {
  const directory = opendirSync(path);
  const entries = [];
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      collection.totalEntries += 1;
      // Count directories as well as files so empty-directory fan-out cannot bypass the file cap.
      assert(collection.totalEntries <= MAX_CANDIDATE_ENTRIES);
      entries.push(entry);
    }
  } finally {
    directory.closeSync();
  }
  return entries.sort((left, right) => compareText(left.name, right.name));
}

export function buildIsolatedJudgeDockerInvocation({
  request,
  containerName,
  baselineRoot,
  candidateRoot,
  requestPath
}) {
  assert(/^tenantscript-agent-eval-[0-9a-f]{16}$/u.test(containerName));
  const sandbox = request.sandbox;
  const args = [
    "run",
    `--name=${containerName}`,
    "--pull=never",
    "--init",
    "--network=none",
    "--ipc=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    `--pids-limit=${String(sandbox.pidsLimit)}`,
    `--memory=${String(sandbox.memoryMb)}m`,
    `--memory-swap=${String(sandbox.memoryMb)}m`,
    `--cpus=${String(sandbox.cpuCount)}`,
    "--ulimit=nofile=256:256",
    `--ulimit=nproc=${String(sandbox.pidsLimit)}:${String(sandbox.pidsLimit)}`,
    "--user=65532:65532",
    "--env=CI=1",
    "--env=HOME=/tmp",
    `--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=${String(sandbox.tmpfsMb)}m`,
    `--tmpfs=/work:rw,nosuid,nodev,size=${String(sandbox.tmpfsMb)}m`,
    `--mount=type=bind,src=${baselineRoot},dst=/baseline,readonly`,
    `--mount=type=bind,src=${candidateRoot},dst=/candidate,readonly`,
    `--mount=type=bind,src=${requestPath},dst=/input/request.json,readonly`,
    "--workdir=/work",
    "--entrypoint=/opt/tenantscript/bin/plugin-authoring-judge",
    request.sandbox.image,
    "--request=/input/request.json",
    "--baseline=/baseline",
    "--candidate=/candidate",
    "--workspace=/work"
  ];
  return {
    command: "docker",
    args,
    containerName,
    timeoutMs: sandbox.timeoutMs,
    environmentKeys: ["PATH"]
  };
}

export async function executeIsolatedJudgeRun({
  repositoryRoot,
  candidateRoot,
  request: requestInput,
  corpus: corpusInput,
  backend = createDockerBackend(),
  workspace = createGitWorkspaceAdapter(),
  temporaryRootFactory = () => mkdtempSync(join(tmpdir(), "tenantscript-isolated-judge-")),
  now = () => new Date()
}) {
  const corpus = parsePluginAuthoringCorpus(corpusInput);
  const request = parseIsolatedRunnerRequest(requestInput, corpus);
  const candidate = inspectIsolatedCandidateBundle(candidateRoot, corpus);
  const temporaryRoot = resolve(temporaryRootFactory());
  const baselineDestination = join(temporaryRoot, "baseline");
  const candidateDestination = join(temporaryRoot, "candidate");
  const requestPath = join(temporaryRoot, "request.json");
  const containerName = `tenantscript-agent-eval-${randomBytes(8).toString("hex")}`;
  let runAttempted = false;
  let cleanupConfirmed = false;
  let executionFailure = false;
  let temporaryRootOwned = false;

  try {
    assertSafeTemporaryRoot(temporaryRoot);
    // Cleanup is authorized only after the factory-provided root has passed the empty,
    // non-symlink directory contract. A failed ownership check must preserve caller files.
    temporaryRootOwned = true;
    try {
      workspace.prepare({
        repositoryRoot: resolve(repositoryRoot),
        revision: request.repositoryRevision,
        destination: baselineDestination,
        temporaryRoot
      });
      assertSafePreparedDirectory(baselineDestination);
    } catch {
      throw new Error("isolated baseline workspace could not be prepared");
    }
    materializeCandidate(candidate, candidateDestination);
    writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o444,
      flag: "wx"
    });
    // Creation modes are reduced by the maintainer's umask. The judge runs as UID 65532, so set
    // the final read-only mode explicitly instead of depending on the invoking shell's policy.
    chmodSync(requestPath, 0o444);

    try {
      await backend.probe(request.sandbox.image);
    } catch {
      throw new Error("isolated judge sandbox is unavailable");
    }

    const startedAtInstant = now();
    const startedAt = startedAtInstant.toISOString();
    const invocation = buildIsolatedJudgeDockerInvocation({
      request,
      containerName,
      baselineRoot: baselineDestination,
      candidateRoot: candidateDestination,
      requestPath
    });
    let rawOutput;
    try {
      runAttempted = true;
      rawOutput = await backend.run(invocation);
    } catch {
      executionFailure = true;
    } finally {
      if (runAttempted) {
        try {
          cleanupConfirmed = (await backend.remove(containerName)) === true;
        } catch {
          cleanupConfirmed = false;
        }
      }
    }
    if (!cleanupConfirmed) {
      throw new Error("isolated judge cleanup was not confirmed");
    }
    if (executionFailure) {
      throw new Error("isolated judge execution failed");
    }

    const taskResults = parseJudgeOutput(rawOutput, corpus);
    const completedAtInstant = now();
    // Wall clocks may have millisecond resolution or move backwards. Published result contracts
    // require a strictly positive duration, so preserve ordering without trusting clock progress.
    const completedAt = new Date(
      Math.max(completedAtInstant.getTime(), startedAtInstant.getTime() + 1)
    ).toISOString();
    const evidencePayload = {
      schemaVersion: 1,
      run: {
        id: request.run.id,
        agent: request.run.agent,
        model: request.run.model,
        costUsd: request.run.costUsd
      },
      repositoryRevision: request.repositoryRevision,
      corpusDigest: request.corpusDigest,
      candidate: {
        digest: candidate.digest,
        tasks: candidate.tasks,
        files: candidate.files,
        totalBytes: candidate.totalBytes
      },
      sandbox: {
        image: request.sandbox.image,
        network: "none",
        readOnlyRoot: true,
        capabilities: "none",
        noNewPrivileges: true,
        timeoutMs: request.sandbox.timeoutMs,
        memoryMb: request.sandbox.memoryMb,
        cpuCount: request.sandbox.cpuCount,
        pidsLimit: request.sandbox.pidsLimit,
        tmpfsMb: request.sandbox.tmpfsMb,
        workspace: "bounded-tmpfs",
        cleanup: "confirmed"
      },
      startedAt,
      completedAt,
      taskResults
    };
    const evidence = {
      ...evidencePayload,
      digest: sha256Canonical(evidencePayload)
    };
    const result = {
      schemaVersion: 1,
      corpusDigest: request.corpusDigest,
      repositoryRevision: request.repositoryRevision,
      run: {
        id: request.run.id,
        agent: request.run.agent,
        model: request.run.model,
        provenance: "isolated-agent-run",
        evidenceBundleDigest: evidence.digest,
        startedAt,
        completedAt,
        costUsd: request.run.costUsd
      },
      taskResults
    };
    parsePluginAuthoringResult(result, corpus);
    const passed = taskResults.filter((task) =>
      task.judges.every((judge) => judge.status === "pass")
    ).length;
    const failureCodes = [
      ...new Set(
        taskResults.flatMap((task) =>
          task.judges
            .map((judge) => judge.failureCode)
            .filter((failureCode) => failureCode !== null)
        )
      )
    ].sort(compareText);
    return {
      status: passed === corpus.tasks.length ? "success" : "warning",
      summary: `${String(passed)} of ${String(corpus.tasks.length)} plugin authoring tasks passed all deterministic judges`,
      nextActions: failureCodes.map((failureCode) => NEXT_ACTIONS[failureCode]),
      artifacts: ["evidence.json", "result.json"],
      evidence,
      result
    };
  } finally {
    if (temporaryRootOwned) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

function parseJudgeOutput(rawOutput, corpus) {
  try {
    assert(typeof rawOutput === "string");
    assert(Buffer.byteLength(rawOutput) <= MAX_JUDGE_OUTPUT_BYTES);
    const parsed = JSON.parse(rawOutput);
    assertPlainObject(parsed);
    assertExactKeys(parsed, ["schemaVersion", "taskResults"]);
    assert(parsed.schemaVersion === 1);
    const probeResult = {
      schemaVersion: 1,
      corpusDigest: computePluginAuthoringCorpusDigest(corpus),
      repositoryRevision: corpus.baselineRevision,
      run: {
        id: "isolated-output-probe",
        agent: "isolated-output-probe",
        model: "isolated-output-probe",
        provenance: "isolated-agent-run",
        evidenceBundleDigest: "a".repeat(64),
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
        costUsd: null
      },
      taskResults: parsed.taskResults
    };
    return parsePluginAuthoringResult(probeResult, corpus).taskResults;
  } catch {
    throw new Error("isolated judge output is invalid");
  }
}

function materializeCandidate(candidate, destination) {
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  for (const record of candidate.records) {
    const destinationPath = join(destination, ...record.path.split("/"));
    mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
    writeFileSync(destinationPath, record.bytes, { mode: 0o600, flag: "wx" });
  }
  // The container receives this tree as read-only input, so the host copy never needs write
  // access after materialization. Explicit modes also neutralize permissive or restrictive umasks.
  chmodTree(destination, 0o755, 0o444);
}

function assertSafeTemporaryRoot(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  assert(metadata.isDirectory() && !metadata.isSymbolicLink());
  assert(readdirSync(path).length === 0);
}

function assertSafePreparedDirectory(path) {
  const metadata = lstatSync(path);
  assert(metadata.isDirectory() && !metadata.isSymbolicLink());
}

function chmodTree(root, directoryMode, fileMode) {
  const metadata = lstatSync(root);
  assert(!metadata.isSymbolicLink());
  chmodSync(root, metadata.isDirectory() ? directoryMode : fileMode);
  if (!metadata.isDirectory()) return;
  for (const entry of readdirSync(root)) {
    chmodTree(join(root, entry), directoryMode, fileMode);
  }
}

export function createGitWorkspaceAdapter() {
  return {
    prepare({ repositoryRoot, revision, destination, temporaryRoot }) {
      const worktree = join(temporaryRoot, "source-worktree");
      const environment = trustedEnvironment(temporaryRoot);
      const added = spawnSync("git", ["worktree", "add", "--detach", worktree, revision], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: environment,
        stdio: ["ignore", "pipe", "pipe"]
      });
      if (added.status !== 0 || added.error !== undefined) {
        throw new Error("worktree add failed");
      }
      try {
        cpSync(worktree, destination, {
          recursive: true,
          filter: (source) => {
            const [topLevel] = relative(worktree, source).split(sep);
            return ![".devloop", ".git", ".tmp"].includes(topLevel);
          }
        });
        // The Docker bind mount is the execution-time read-only boundary. Keeping the host-side
        // temporary copy removable prevents a failed run from leaving durable worktree evidence.
        chmodTree(destination, 0o755, 0o644);
      } finally {
        const removed = spawnSync("git", ["worktree", "remove", "--force", worktree], {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: environment,
          stdio: ["ignore", "pipe", "pipe"]
        });
        if (removed.status !== 0 || removed.error !== undefined) {
          throw new Error("worktree cleanup failed");
        }
      }
    }
  };
}

export function createDockerBackend() {
  return {
    async probe(image) {
      const result = spawnSync(
        "docker",
        ["image", "inspect", image, "--format={{json .RepoDigests}}"],
        {
          encoding: "utf8",
          env: commandEnvironment(),
          maxBuffer: 64 * 1024,
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      if (result.status !== 0 || result.error !== undefined) throw new Error("probe failed");
      const digests = JSON.parse(result.stdout);
      if (!Array.isArray(digests) || !digests.includes(image))
        throw new Error("digest unavailable");
    },
    run(invocation) {
      return runDockerInvocation(invocation);
    },
    async remove(containerName) {
      const result = spawnSync("docker", ["rm", "--force", containerName], {
        encoding: "utf8",
        env: commandEnvironment(),
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      });
      return result.status === 0 && result.error === undefined;
    }
  };
}

function runDockerInvocation(invocation) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.command, invocation.args, {
      detached: process.platform !== "win32",
      env: commandEnvironment(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks = [];
    let bytes = 0;
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      terminateProcessGroup(child.pid);
    };
    const timer = setTimeout(fail, invocation.timeoutMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_JUDGE_OUTPUT_BYTES) fail();
      else chunks.push(chunk);
    });
    // Drain but never retain attacker-controlled stderr.
    child.stderr.on("data", () => {});
    child.on("error", fail);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      terminateProcessGroup(child.pid);
      if (failed || signal !== null || status !== 0) {
        rejectPromise(new Error("docker execution failed"));
        return;
      }
      resolvePromise(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function terminateProcessGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function trustedEnvironment(root) {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0"
  };
}

function commandEnvironment() {
  return { PATH: process.env.PATH ?? "" };
}

export function writeIsolatedRunnerArtifacts(outputRootInput, output) {
  try {
    const outputRoot = resolve(outputRootInput);
    if (!existsSync(outputRoot)) mkdirSync(outputRoot, { recursive: false, mode: 0o755 });
    const metadata = lstatSync(outputRoot);
    assert(metadata.isDirectory() && !metadata.isSymbolicLink());
    assert(readdirSync(outputRoot).length === 0);
    writeFileSync(
      join(outputRoot, "evidence.json"),
      `${JSON.stringify(output.evidence, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o644,
        flag: "wx"
      }
    );
    writeFileSync(join(outputRoot, "result.json"), `${JSON.stringify(output.result, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o644,
      flag: "wx"
    });
  } catch {
    throw new Error("isolated runner output path is unsafe");
  }
}

function readBoundedJson(path, maximumBytes, errorMessage) {
  try {
    const metadata = lstatSync(path);
    assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= maximumBytes);
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(errorMessage);
  }
}

function sha256Canonical(value) {
  return createHash("sha256")
    .update(JSON.stringify(sortDeep(value)))
    .digest("hex");
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, sortDeep(value[key])])
  );
}

function assertPlainObject(value) {
  assert(typeof value === "object" && value !== null && !Array.isArray(value));
}

function assertExactKeys(value, keys) {
  assertArrayEquals(Object.keys(value).sort(compareText), [...keys].sort(compareText));
}

function assertString(value, minimum, maximum, pattern) {
  assert(typeof value === "string" && value.length >= minimum && value.length <= maximum);
  assert(!/[\u0000-\u001f\u007f]/u.test(value));
  assert(pattern.test(value));
}

function assertSafeString(value, minimum, maximum, pattern) {
  assertString(value, minimum, maximum, pattern);
  assert(!UNSAFE_TEXT_PATTERNS.some((unsafePattern) => unsafePattern.test(value)));
}

function assertIntegerBetween(value, minimum, maximum) {
  assert(Number.isSafeInteger(value) && value >= minimum && value <= maximum);
}

function assertArrayEquals(actual, expected) {
  assert(Array.isArray(actual) && actual.length === expected.length);
  assert(actual.every((value, index) => value === expected[index]));
}

function assert(condition) {
  if (!condition) throw new Error("assertion failed");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  if (process.argv.length !== 5) {
    process.stderr.write(
      "usage: plugin-authoring-isolated-runner.mjs <request.json> <candidate-directory> <output-directory>\n"
    );
    process.exit(1);
  }
  try {
    const repositoryRoot = resolve(import.meta.dirname, "..");
    const corpus = parsePluginAuthoringCorpus(
      readBoundedJson(
        join(repositoryRoot, "evals", "plugin-authoring", "corpus.json"),
        MAX_REQUEST_BYTES,
        "plugin authoring corpus is invalid"
      )
    );
    const request = readBoundedJson(
      resolve(process.argv[2]),
      MAX_REQUEST_BYTES,
      "isolated runner request is invalid"
    );
    const output = await executeIsolatedJudgeRun({
      repositoryRoot,
      candidateRoot: resolve(process.argv[3]),
      request,
      corpus
    });
    writeIsolatedRunnerArtifacts(resolve(process.argv[4]), output);
    process.stdout.write(
      `${JSON.stringify({
        status: output.status,
        summary: output.summary,
        nextActions: output.nextActions,
        artifacts: output.artifacts
      })}\n`
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "isolated judge runner failed"}\n`
    );
    process.exit(1);
  }
}
