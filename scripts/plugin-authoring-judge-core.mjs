import {
  PLUGIN_AUTHORING_FAILURE_BY_JUDGE,
  PLUGIN_AUTHORING_REQUIRED_JUDGES,
  PLUGIN_AUTHORING_TASK_IDS,
  computePluginAuthoringCorpusDigest,
  parsePluginAuthoringCorpus
} from "./plugin-authoring-eval.mjs";

const MAX_DURATION_MS = 3_600_000;
export const PLUGIN_AUTHORING_JUDGE_CORPUS_DIGEST =
  "9bf86c36f4bf79e1a9c659f92e88dfd619c83ab5db196d89bc46f6f0b87441f9";

export async function runPluginAuthoringJudgeCore({
  corpus: corpusInput,
  runJudge,
  now = () => performance.now()
}) {
  if (typeof runJudge !== "function" || typeof now !== "function") {
    throw new Error("plugin authoring judge core configuration is invalid");
  }
  let corpus;
  try {
    corpus = parsePluginAuthoringCorpus(corpusInput);
    const taskIds = corpus.tasks.map((task) => task.id);
    if (
      taskIds.length !== PLUGIN_AUTHORING_TASK_IDS.length ||
      taskIds.some((taskId, index) => taskId !== PLUGIN_AUTHORING_TASK_IDS[index]) ||
      computePluginAuthoringCorpusDigest(corpus) !== PLUGIN_AUTHORING_JUDGE_CORPUS_DIGEST
    ) {
      throw new Error("task contract drifted");
    }
  } catch {
    // The image schema is fixed to this reviewed corpus. Drift must create a new reviewed image,
    // never silently widen the output contract or expose untrusted corpus metadata.
    throw new Error("plugin authoring judge core configuration is invalid");
  }
  const taskResults = [];

  // Sequential evaluation makes the public task/judge order independent of scheduler timing and
  // keeps future resource-bound adapters from accidentally running untrusted tasks concurrently.
  for (const task of corpus.tasks) {
    const taskId = task.id;
    const judges = [];
    for (const judge of PLUGIN_AUTHORING_REQUIRED_JUDGES) {
      const startedAt = readClock(now);
      let passed = false;
      try {
        // Each adapter receives a fresh copy so mutation in one judge cannot alter later policy.
        passed = (await runJudge({ task: structuredClone(task), judge })) === true;
      } catch {
        // Adapter diagnostics may contain candidate code, paths, or secrets. Only the fixed failure
        // taxonomy crosses the judge core boundary.
        passed = false;
      }
      const durationMs = boundedDuration(startedAt, readClock(now));
      judges.push({
        name: judge,
        status: passed ? "pass" : "fail",
        durationMs,
        failureCode: passed ? null : PLUGIN_AUTHORING_FAILURE_BY_JUDGE[judge]
      });
    }
    taskResults.push({ taskId, judges });
  }

  return { schemaVersion: 1, taskResults };
}

function readClock(now) {
  try {
    const value = now();
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function boundedDuration(startedAt, completedAt) {
  if (startedAt === null || completedAt === null) return 0;
  return Math.min(MAX_DURATION_MS, Math.max(0, Math.trunc(completedAt - startedAt)));
}
