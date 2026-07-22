import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLUGIN_AUTHORING_REQUIRED_JUDGES = Object.freeze([
  "manifest",
  "build",
  "unit-test",
  "security-test",
  "audit",
  "least-privilege"
]);
const CATEGORIES = ["approval", "capability", "error-handling", "policy", "webhook-transform"];
export const PLUGIN_AUTHORING_FAILURE_BY_JUDGE = Object.freeze({
  manifest: "manifest-invalid",
  build: "build-failed",
  "unit-test": "unit-test-failed",
  "security-test": "security-test-failed",
  audit: "audit-failed",
  "least-privilege": "least-privilege-failed"
});
export const PLUGIN_AUTHORING_TASK_IDS = Object.freeze([
  "approval-invoice-threshold",
  "approval-refund-review",
  "capability-github-issue",
  "capability-slack-alert",
  "error-malformed-payload",
  "error-provider-failure",
  "policy-api-method-allowlist",
  "policy-data-residency",
  "webhook-currency-normalizer",
  "webhook-ticket-priority"
]);
const NEXT_ACTION_BY_FAILURE = {
  "manifest-invalid": "Improve manifest guidance or the scaffold manifest template.",
  "build-failed": "Improve scaffold build guidance or generated dependency constraints.",
  "unit-test-failed": "Improve the TDD recipe and generated behavior tests.",
  "security-test-failed": "Improve generated security tests or the security-test authoring recipe.",
  "audit-failed": "Improve ext audit guidance or remove the reported unsafe pattern.",
  "least-privilege-failed":
    "Reduce declared capabilities or improve least-privilege authoring guidance."
};
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HOOK_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SHA40_PATTERN = /^[0-9a-f]{40}$/;
const SHA64_PATTERN = /^[0-9a-f]{64}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNSAFE_TEXT_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:file:\/\/(?:localhost)?\/|(?:^|[^A-Za-z0-9])\/)(?:Users|Volumes|home|workspace|root|tmp)\/|[A-Za-z]:\\(?:Users|Volumes|home|workspace|root|tmp)\\/i,
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]/i
];

export function parsePluginAuthoringCorpus(input) {
  try {
    assertPlainObject(input);
    assertExactKeys(input, ["schemaVersion", "baselineRevision", "requiredJudges", "tasks"]);
    assert(input.schemaVersion === 1);
    assertString(input.baselineRevision, 40, 40, SHA40_PATTERN);
    assertArrayEquals(input.requiredJudges, PLUGIN_AUTHORING_REQUIRED_JUDGES);
    assert(Array.isArray(input.tasks) && input.tasks.length >= 10 && input.tasks.length <= 100);

    const ids = [];
    const categoryCounts = new Map(CATEGORIES.map((category) => [category, 0]));
    for (const task of input.tasks) {
      assertPlainObject(task);
      assertExactKeys(task, [
        "id",
        "title",
        "category",
        "requirement",
        "hook",
        "capabilities",
        "egress"
      ]);
      assertString(task.id, 1, 80, ID_PATTERN);
      assertSafeText(task.title, 1, 120);
      assert(CATEGORIES.includes(task.category));
      assertSafeText(task.requirement, 40, 2_000);
      assertPlainObject(task.hook);
      assertExactKeys(task.hook, ["name", "type"]);
      assertString(task.hook.name, 1, 120, HOOK_PATTERN);
      assert(["event", "transform", "policy"].includes(task.hook.type));
      assert(Array.isArray(task.capabilities) && task.capabilities.length <= 20);
      for (const capability of task.capabilities) {
        assertString(capability, 1, 120, HOOK_PATTERN);
      }
      assertSortedUnique(task.capabilities);
      assertPlainObject(task.egress);
      assertExactKeys(task.egress, ["mode"]);
      assert(task.egress.mode === "deny");
      ids.push(task.id);
      categoryCounts.set(task.category, categoryCounts.get(task.category) + 1);
    }
    assertSortedUnique(ids);
    // A fixed two-task stratum keeps category pass rates comparable across agents and revisions.
    assert(CATEGORIES.every((category) => categoryCounts.get(category) === 2));
    return structuredClone(input);
  } catch {
    throw new Error("plugin authoring corpus is invalid");
  }
}

export function computePluginAuthoringCorpusDigest(corpus) {
  return createHash("sha256")
    .update(JSON.stringify(sortDeep(corpus)))
    .digest("hex");
}

export function parsePluginAuthoringResult(input, corpusInput) {
  try {
    const corpus = parsePluginAuthoringCorpus(corpusInput);
    assertPlainObject(input);
    assertExactKeys(input, [
      "schemaVersion",
      "corpusDigest",
      "repositoryRevision",
      "run",
      "taskResults"
    ]);
    assert(input.schemaVersion === 1);
    assertString(input.corpusDigest, 64, 64, SHA64_PATTERN);
    assert(input.corpusDigest === computePluginAuthoringCorpusDigest(corpus));
    assertString(input.repositoryRevision, 40, 40, SHA40_PATTERN);
    assert(input.repositoryRevision === corpus.baselineRevision);
    validateRun(input.run);
    validateTaskResults(input.taskResults, corpus);
    return structuredClone(input);
  } catch {
    throw new Error("plugin authoring result is invalid");
  }
}

function validateRun(run) {
  assertPlainObject(run);
  assertExactKeys(run, [
    "id",
    "agent",
    "model",
    "provenance",
    "evidenceBundleDigest",
    "startedAt",
    "completedAt",
    "costUsd"
  ]);
  assertSafeText(run.id, 1, 100, ID_PATTERN);
  assertSafeText(run.agent, 1, 80, NAME_PATTERN);
  assertSafeText(run.model, 1, 120, NAME_PATTERN);
  assert(["repository-simulation", "isolated-agent-run"].includes(run.provenance));
  if (run.provenance === "repository-simulation") {
    assert(run.evidenceBundleDigest === null);
  } else {
    assertString(run.evidenceBundleDigest, 64, 64, SHA64_PATTERN);
  }
  assertString(run.startedAt, 24, 24, ISO_DATE_PATTERN);
  assertString(run.completedAt, 24, 24, ISO_DATE_PATTERN);
  const startedAt = Date.parse(run.startedAt);
  const completedAt = Date.parse(run.completedAt);
  assert(Number.isFinite(startedAt) && Number.isFinite(completedAt));
  // Date.parse normalizes impossible calendar dates, so round-trip before using timestamps as
  // durable evidence or deriving wall-clock metrics from a different instant than the input names.
  assert(new Date(startedAt).toISOString() === run.startedAt);
  assert(new Date(completedAt).toISOString() === run.completedAt);
  assert(completedAt > startedAt);
  assert(
    run.costUsd === null ||
      (typeof run.costUsd === "number" &&
        Number.isFinite(run.costUsd) &&
        run.costUsd >= 0 &&
        run.costUsd <= 100_000)
  );
}

function validateTaskResults(taskResults, corpus) {
  assert(Array.isArray(taskResults));
  assert(taskResults.length === corpus.tasks.length && taskResults.length <= 100);
  const expectedTaskIds = corpus.tasks.map((task) => task.id);
  const observedTaskIds = [];
  for (const taskResult of taskResults) {
    assertPlainObject(taskResult);
    assertExactKeys(taskResult, ["taskId", "judges"]);
    assertString(taskResult.taskId, 1, 80, ID_PATTERN);
    observedTaskIds.push(taskResult.taskId);
    assert(Array.isArray(taskResult.judges));
    assert(taskResult.judges.length === PLUGIN_AUTHORING_REQUIRED_JUDGES.length);
    const judgeNames = [];
    for (const judge of taskResult.judges) {
      assertPlainObject(judge);
      assertExactKeys(judge, ["name", "status", "durationMs", "failureCode"]);
      assert(PLUGIN_AUTHORING_REQUIRED_JUDGES.includes(judge.name));
      judgeNames.push(judge.name);
      assert(["pass", "fail"].includes(judge.status));
      assert(
        Number.isInteger(judge.durationMs) && judge.durationMs >= 0 && judge.durationMs <= 3_600_000
      );
      if (judge.status === "pass") {
        assert(judge.failureCode === null);
      } else {
        assert(judge.failureCode === PLUGIN_AUTHORING_FAILURE_BY_JUDGE[judge.name]);
      }
    }
    assertArrayEquals(judgeNames, PLUGIN_AUTHORING_REQUIRED_JUDGES);
  }
  assertArrayEquals(observedTaskIds, expectedTaskIds);
}

export function buildPluginAuthoringEvalReport(corpusInput, resultInputs) {
  const corpus = parsePluginAuthoringCorpus(corpusInput);
  assert(Array.isArray(resultInputs) && resultInputs.length >= 1 && resultInputs.length <= 100);
  const results = resultInputs
    .map((result) => parsePluginAuthoringResult(result, corpus))
    .sort(compareResults);
  const runIds = results.map((result) => result.run.id);
  if (new Set(runIds).size !== runIds.length) {
    throw new Error("plugin authoring results contain duplicate runs");
  }
  // Repository simulations verify the scoring contract but must never inflate external-agent
  // metrics. Once isolated evidence exists, it becomes the sole metric population.
  const metricProvenance = results.some((result) => result.run.provenance === "isolated-agent-run")
    ? "isolated-agent-run"
    : "repository-simulation";

  const failureCounts = new Map();
  const categoryCounts = new Map(CATEGORIES.map((category) => [category, { passed: 0, total: 0 }]));
  const taskCounts = new Map(corpus.tasks.map((task) => [task.id, { passed: 0, total: 0 }]));
  const taskById = new Map(corpus.tasks.map((task) => [task.id, task]));
  const runs = results.map((result) => {
    const contributesMetrics = result.run.provenance === metricProvenance;
    let passed = 0;
    for (const taskResult of result.taskResults) {
      const taskPassed = taskResult.judges.every((judge) => judge.status === "pass");
      if (taskPassed) passed += 1;
      if (contributesMetrics) {
        const taskCount = taskCounts.get(taskResult.taskId);
        taskCount.total += 1;
        if (taskPassed) taskCount.passed += 1;
        const categoryCount = categoryCounts.get(taskById.get(taskResult.taskId).category);
        categoryCount.total += 1;
        if (taskPassed) categoryCount.passed += 1;
        for (const judge of taskResult.judges) {
          if (judge.failureCode !== null) {
            failureCounts.set(judge.failureCode, (failureCounts.get(judge.failureCode) ?? 0) + 1);
          }
        }
      }
    }
    return {
      id: result.run.id,
      agent: result.run.agent,
      model: result.run.model,
      provenance: result.run.provenance,
      status: passed === corpus.tasks.length ? "success" : "warning",
      summary: {
        passed,
        total: corpus.tasks.length,
        passRate: passed / corpus.tasks.length
      },
      durationMs: Date.parse(result.run.completedAt) - Date.parse(result.run.startedAt),
      costUsd: result.run.costUsd
    };
  });

  const metricRuns = runs.filter((run) => run.provenance === metricProvenance);
  const agentGroups = new Map();
  for (const run of metricRuns) {
    const key = `${run.agent}\u0000${run.model}`;
    const group = agentGroups.get(key) ?? {
      agent: run.agent,
      model: run.model,
      runs: 0,
      passed: 0,
      total: 0,
      knownCostUsd: 0,
      costComplete: true
    };
    group.runs += 1;
    group.passed += run.summary.passed;
    group.total += run.summary.total;
    if (run.costUsd === null) group.costComplete = false;
    else group.knownCostUsd += run.costUsd;
    agentGroups.set(key, group);
  }

  return {
    schemaVersion: 1,
    source: {
      corpusDigest: computePluginAuthoringCorpusDigest(corpus),
      baselineRevision: corpus.baselineRevision,
      tasks: corpus.tasks.length,
      runs: runs.length,
      metricProvenance,
      metricRuns: metricRuns.length
    },
    runs,
    agents: [...agentGroups.values()]
      .map((group) => ({
        agent: group.agent,
        model: group.model,
        runs: group.runs,
        passed: group.passed,
        total: group.total,
        passAt1: group.passed / group.total,
        costUsd: group.costComplete ? group.knownCostUsd : null
      }))
      .sort(
        (left, right) =>
          compareText(left.agent, right.agent) || compareText(left.model, right.model)
      ),
    categories: CATEGORIES.map((category) => ({
      category,
      ...categoryCounts.get(category),
      passRate: ratio(categoryCounts.get(category))
    })),
    tasks: corpus.tasks.map((task) => ({
      id: task.id,
      category: task.category,
      ...taskCounts.get(task.id),
      passRate: ratio(taskCounts.get(task.id))
    })),
    failures: [...failureCounts.entries()]
      .map(([code, count]) => ({ count, code, nextAction: NEXT_ACTION_BY_FAILURE[code] }))
      .sort((left, right) => compareText(left.code, right.code))
  };
}

export function renderPluginAuthoringEvalDashboard(report) {
  const scope =
    report.source.metricProvenance === "isolated-agent-run"
      ? "> Isolated agent runs only. Repository simulations remain listed as evidence but are excluded from metrics; isolated execution does not establish production safety."
      : "> Repository simulation only. These fixtures validate the scoring contract; they do not compare real agents or establish production safety.";
  const lines = [
    "# Plugin authoring eval dashboard",
    "",
    scope,
    "",
    `Baseline revision: \`${report.source.baselineRevision.slice(0, 12)}\``,
    `Corpus: ${String(report.source.tasks)} tasks / ${String(report.source.metricRuns)} metric runs / ${String(report.source.runs)} evidence runs`,
    "",
    "## Agent results",
    ""
  ];
  for (const agent of report.agents) {
    lines.push(
      `- \`${agent.agent}\` / \`${agent.model}\`: ${String(agent.runs)} runs, pass@1 ${formatPercent(agent.passAt1)}, ${agent.costUsd === null ? "Cost: unknown" : `Cost: $${agent.costUsd.toFixed(4)}`}`
    );
  }
  lines.push("", "## Category results", "");
  for (const category of report.categories) {
    lines.push(
      `- \`${category.category}\`: ${String(category.passed)} / ${String(category.total)} (${formatPercent(category.passRate)})`
    );
  }
  lines.push("", "## Failure guidance", "");
  if (report.failures.length === 0) {
    lines.push(
      report.source.metricProvenance === "isolated-agent-run"
        ? "No isolated-agent failures in the declared evidence. This does not establish production safety."
        : "No fixture failures. This is not evidence from an external agent run."
    );
  } else {
    for (const failure of report.failures) {
      lines.push(`- \`${failure.code}\` (${String(failure.count)}): ${failure.nextAction}`);
    }
  }
  lines.push(
    "",
    "## Execution boundary",
    "",
    report.source.metricProvenance === "isolated-agent-run"
      ? "This repository contract does not execute unknown generated code while generating this report. Isolated-agent evidence is accepted only with a declared evidence bundle digest and does not establish production safety."
      : "This repository contract does not execute unknown generated code. A future isolated runner must produce every deterministic judge result, preserve the pinned revision, and stop when isolation is unavailable.",
    ""
  );
  return lines.join("\n");
}

export function generatePluginAuthoringEvalArtifacts(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const evalsRoot = join(root, "evals");
  const evalRoot = join(root, "evals", "plugin-authoring");
  const resultDirectory = join(evalRoot, "results");
  try {
    // Validate every repository-controlled directory before any read so a parent symlink cannot
    // redirect corpus or result evidence outside the checkout while child Dirents still look safe.
    assertSafeDirectory(evalsRoot);
    assertSafeDirectory(evalRoot);
    assertSafeDirectory(resultDirectory);
  } catch {
    throw new Error("plugin authoring eval inputs are invalid");
  }
  const corpus = parsePluginAuthoringCorpus(readBoundedJson(join(evalRoot, "corpus.json")));
  let entries;
  try {
    entries = readdirSync(resultDirectory, { withFileTypes: true });
  } catch {
    throw new Error("plugin authoring eval inputs are invalid");
  }
  if (entries.length < 1 || entries.length > 100) {
    throw new Error("plugin authoring eval inputs are invalid");
  }
  const names = entries.map((entry) => entry.name).sort();
  if (
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
    names.some((name) => !ID_PATTERN.test(name.replace(/\.json$/, "")) || !name.endsWith(".json"))
  ) {
    throw new Error("plugin authoring eval inputs are invalid");
  }
  const results = names.map((name) =>
    parsePluginAuthoringResult(readBoundedJson(join(resultDirectory, name)), corpus)
  );
  const report = buildPluginAuthoringEvalReport(corpus, results);
  return {
    reportJson: `${JSON.stringify(report, null, 2)}\n`,
    dashboardMarkdown: renderPluginAuthoringEvalDashboard(report)
  };
}

function assertSafeDirectory(path) {
  const metadata = lstatSync(path);
  assert(metadata.isDirectory() && !metadata.isSymbolicLink());
}

function readBoundedJson(path) {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_048_576) {
      throw new Error("unsafe");
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("plugin authoring eval inputs are invalid");
  }
}

function assertOutputPath(path) {
  try {
    const metadata = lstatSync(path);
    assert(metadata.isFile() && !metadata.isSymbolicLink());
  } catch (error) {
    if (typeof error !== "object" || error === null || error.code !== "ENOENT") throw error;
  }
}

function readBoundedArtifact(path) {
  const metadata = lstatSync(path);
  assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 1_048_576);
  return readFileSync(path, "utf8");
}

function checkOrWriteArtifacts(root, write) {
  const outputs = generatePluginAuthoringEvalArtifacts(root);
  const evalRoot = join(root, "evals", "plugin-authoring");
  const artifacts = [
    [join(evalRoot, "report.json"), outputs.reportJson],
    [join(evalRoot, "dashboard.md"), outputs.dashboardMarkdown]
  ];
  for (const [path, expected] of artifacts) {
    if (write) {
      try {
        assertOutputPath(path);
        writeFileSync(path, expected, { encoding: "utf8", mode: 0o644 });
      } catch {
        throw new Error("plugin authoring eval output path is unsafe");
      }
    } else {
      try {
        assert(readBoundedArtifact(path) === expected);
      } catch {
        throw new Error("plugin authoring eval artifacts are missing or stale");
      }
    }
  }
  return outputs;
}

function assertPlainObject(value) {
  assert(typeof value === "object" && value !== null && !Array.isArray(value));
}

function assertExactKeys(value, keys) {
  assertArrayEquals(Object.keys(value).sort(), [...keys].sort());
}

function assertString(value, minLength, maxLength, pattern) {
  assert(typeof value === "string" && value.length >= minLength && value.length <= maxLength);
  assert(!/[\u0000-\u001f\u007f]/u.test(value));
  if (pattern !== undefined) assert(pattern.test(value));
}

function assertSafeText(value, minLength, maxLength, pattern) {
  assertString(value, minLength, maxLength, pattern);
  // Eval prose is copied into durable public artifacts, so use the repository's broader
  // credential and machine-path shapes even when a secret is not preceded by a field label.
  assert(!UNSAFE_TEXT_PATTERNS.some((unsafePattern) => unsafePattern.test(value)));
}

function assertSortedUnique(values) {
  assertArrayEquals(values, [...new Set(values)].sort());
}

function assertArrayEquals(actual, expected) {
  assert(Array.isArray(actual) && actual.length === expected.length);
  assert(actual.every((value, index) => value === expected[index]));
}

function assert(condition) {
  if (!condition) throw new Error("assertion failed");
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortDeep(value[key])])
  );
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareResults(left, right) {
  return (
    compareText(left.run.agent, right.run.agent) ||
    compareText(left.run.model, right.run.model) ||
    compareText(left.run.id, right.run.id)
  );
}

function ratio(counts) {
  return counts.total === 0 ? 0 : counts.passed / counts.total;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const positional = args.filter((argument) => argument !== "--write");
  if (
    positional.length > 1 ||
    args.some((argument) => argument.startsWith("--") && argument !== "--write")
  ) {
    process.stderr.write("usage: plugin-authoring-eval.mjs [repository-root] [--write]\n");
    process.exit(1);
  }
  try {
    const root = resolve(positional[0] ?? process.cwd());
    const output = checkOrWriteArtifacts(root, write);
    process.stdout.write(
      `Plugin authoring eval ${write ? "written" : "check passed"} (${String(JSON.parse(output.reportJson).source.tasks)} tasks).\n`
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "plugin authoring eval failed"}\n`
    );
    process.exit(1);
  }
}
