import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { buildPluginAuthoringJudgeImage } from "./plugin-authoring-judge-image-build.mjs";
import { generatePluginAuthoringJudgeImageEvidence } from "./plugin-authoring-judge-image-evidence.mjs";
import {
  computePluginAuthoringCorpusDigest,
  parsePluginAuthoringCorpus
} from "./plugin-authoring-eval.mjs";
import {
  buildIsolatedJudgeDockerInvocation,
  parseIsolatedRunnerRequest,
  parseJudgeOutput
} from "./plugin-authoring-isolated-runner.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const image = "tenantscript/plugin-authoring-judge:contract-test";
const successContainer = "tenantscript-agent-eval-1111111111111111";
const failureContainer = "tenantscript-agent-eval-2222222222222222";
const corpus = parsePluginAuthoringCorpus(
  JSON.parse(readFileSync(join(repoRoot, "evals", "plugin-authoring", "corpus.json"), "utf8"))
);

test(
  "builds and runs the known-good corpus in the least-authority container",
  { timeout: 240_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tenantscript-judge-image-test-"));
    const baselineRoot = join(root, "baseline");
    const candidateRoot = join(root, "candidate");
    const requestPath = join(root, "request.json");
    try {
      const revision = run("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).stdout.trim();
      const build = buildPluginAuthoringJudgeImage({
        repositoryRoot: repoRoot,
        image,
        sourceRevision: revision
      });
      assert.equal(build.platform, "linux/amd64");
      assert.equal(build.sourceRevision, revision);
      assert.match(build.contextSha256, /^[0-9a-f]{64}$/u);

      writeCandidateFixture({ baselineRoot, candidateRoot, requestPath });
      const request = parseIsolatedRunnerRequest(
        JSON.parse(readFileSync(requestPath, "utf8")),
        corpus
      );
      const executionInvocation = productionInvocation({
        request,
        containerName: successContainer,
        baselineRoot,
        candidateRoot,
        requestPath
      });
      const execution = run(executionInvocation.command, executionInvocation.args, {
        timeout: executionInvocation.timeoutMs
      });
      assert.equal(execution.stderr, "");
      const taskResults = parseJudgeOutput(execution.stdout, corpus);
      const failures = taskResults.flatMap((taskResult) =>
        taskResult.judges
          .filter((judge) => judge.status !== "pass")
          .map((judge) => `${taskResult.taskId}:${judge.name}`)
      );
      assert.deepEqual(failures, []);
      run("docker", ["container", "rm", successContainer]);

      const failureInvocation = productionInvocation({
        request,
        containerName: failureContainer,
        baselineRoot,
        candidateRoot,
        requestPath,
        omitMounts: true
      });
      const failure = spawnSync(failureInvocation.command, failureInvocation.args, {
        encoding: "utf8",
        timeout: 30_000
      });
      assert.equal(failure.status, 1);
      assert.equal(failure.stdout, "");
      assert.equal(failure.stderr, "plugin authoring judge failed\n");

      const generated = await generatePluginAuthoringJudgeImageEvidence({
        repositoryRoot: repoRoot,
        outputDirectory: join(root, "evidence"),
        build
      });
      assert.equal(generated.evidence.image.id, build.id);
      assert.equal(generated.evidence.sourceRevision, revision);
      assert.equal(generated.evidence.decision.status, "candidate");
      assert.equal(
        readFileSync(join(root, "evidence", "judge-image.cdx.json"), "utf8").length > 0,
        true
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      spawnSync("docker", ["container", "rm", "--force", successContainer], {
        encoding: "utf8"
      });
      spawnSync("docker", ["container", "rm", "--force", failureContainer], {
        encoding: "utf8"
      });
      spawnSync("docker", ["image", "rm", "--force", image], { encoding: "utf8" });
    }
  }
);

function writeCandidateFixture({ baselineRoot, candidateRoot, requestPath }) {
  mkdirSync(join(baselineRoot, "evals", "plugin-authoring"), { recursive: true });
  mkdirSync(candidateRoot);
  writeFileSync(
    join(baselineRoot, "evals", "plugin-authoring", "corpus.json"),
    `${JSON.stringify(corpus)}\n`
  );
  writeFileSync(
    requestPath,
    `${JSON.stringify({
      schemaVersion: 1,
      repositoryRevision: corpus.baselineRevision,
      corpusDigest: computePluginAuthoringCorpusDigest(corpus),
      run: { id: "judge-image-contract", agent: "fixture", model: "fixture", costUsd: null },
      sandbox: {
        image: `ghcr.io/tenantscript/plugin-authoring-judge@sha256:${"a".repeat(64)}`,
        timeoutMs: 120_000,
        memoryMb: 512,
        cpuCount: 1,
        pidsLimit: 64,
        tmpfsMb: 64
      }
    })}\n`
  );
  for (const task of corpus.tasks) {
    const taskRoot = join(candidateRoot, task.id);
    mkdirSync(join(taskRoot, "src"), { recursive: true });
    writeFileSync(join(taskRoot, "src", "manifest.ts"), manifestSource(task));
    writeFileSync(join(taskRoot, "src", "index.ts"), pluginSource(task));
    writeFileSync(
      join(taskRoot, "package.json"),
      '{"scripts":{"test":"node --test"},"devDependencies":{"@tenantscript/plugin-sdk":"0.0.0"}}\n'
    );
  }
}

function productionInvocation({
  request,
  containerName,
  baselineRoot,
  candidateRoot,
  requestPath,
  omitMounts = false
}) {
  const invocation = buildIsolatedJudgeDockerInvocation({
    request,
    containerName,
    baselineRoot,
    candidateRoot,
    requestPath
  });
  return {
    ...invocation,
    // The production parser requires a GHCR digest. The contract test substitutes only that
    // reviewed image reference after deriving every runtime flag from the production builder.
    args: invocation.args
      .filter((argument) => !omitMounts || !argument.startsWith("--mount="))
      .map((argument) => (argument === request.sandbox.image ? image : argument))
  };
}

function manifestSource(task) {
  return `import type { TenantScriptManifest } from "@tenantscript/manifest";
export const manifest = ${JSON.stringify({
    name: task.id,
    version: "0.1.0",
    hooks: [
      {
        name: task.hook.name,
        type: task.hook.type,
        timeoutMs: 250,
        schemaVersionRange: "^1.0.0"
      }
    ],
    capabilities: Object.fromEntries(task.capabilities.map((name) => [name, {}])),
    configSchema: { properties: {}, required: [] },
    egress: task.egress,
    limits: { cpuMs: 50, timeoutMs: 500 }
  })} satisfies TenantScriptManifest;\n`;
}

function pluginSource(task) {
  const body = handlerBodies[task.id];
  assert.notEqual(body, undefined);
  return `import { definePlugin } from "@tenantscript/plugin-sdk";
import { manifest } from "./manifest.js";
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function bounded(value: unknown, maximum: number): string | undefined { return typeof value === "string" && value.length >= 1 && value.length <= maximum ? value : undefined; }
export default definePlugin({ manifest, handlers: { ${JSON.stringify(task.hook.name)}: async (payload, context) => { ${body} } } });\n`;
}

const handlerBodies = {
  "approval-invoice-threshold": `const value = record(payload)?.totalCents; if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid_invoice_total"); return value >= 100000 ? { decision: "deny", reason: "approval_required" } : { decision: "allow" };`,
  "approval-refund-review": `const value = record(payload)?.purchaseAgeDays; return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 30 ? { decision: "allow" } : { decision: "deny", reason: "approval_required" };`,
  "capability-github-issue": `const value = record(payload); const id = bounded(value?.deploymentId, 64); const reason = bounded(value?.reason, 160); if (id === undefined || reason === undefined) throw new Error("invalid_deployment"); try { await context.capability("github.issue.create", { title: \`Deployment \${id} failed\`, body: reason }); } catch { throw new Error("issue_creation_failed"); }`,
  "capability-slack-alert": `const value = record(payload); const id = bounded(value?.orderId, 64); const reason = bounded(value?.reason, 160); const channel = bounded(value?.channel, 80); if (id === undefined || reason === undefined || channel === undefined) throw new Error("invalid_blocked_order"); try { await context.capability("slack.send", { channel, message: \`Order \${id} blocked: \${reason}\` }); } catch { throw new Error("alert_failed"); }`,
  "error-malformed-payload": `const value = record(payload); const customerId = bounded(value?.customerId, 64); const displayName = bounded(value?.displayName, 100); if (customerId === undefined || displayName === undefined) throw new Error("invalid_customer"); return { customerId, displayName };`,
  "error-provider-failure": `const value = record(payload); const id = bounded(value?.incidentId, 64); const channel = bounded(value?.channel, 80); if (id === undefined || channel === undefined) throw new Error("invalid_incident"); try { const result = record(await context.capability("slack.send", { channel, message: \`Incident \${id} opened\` })); if (bounded(result?.messageId, 80) === undefined) throw new Error("bad result"); } catch { throw new Error("notification_failed"); }`,
  "policy-api-method-allowlist": `const value = record(payload); const keys = value === undefined ? [] : Object.keys(value); const allowed = keys.length === 2 && keys.includes("method") && keys.includes("url") && (value?.method === "GET" || value?.method === "POST") && typeof value?.url === "string" && (value.url === "https://api.example.com" || value.url.startsWith("https://api.example.com/")); return allowed ? { decision: "allow" } : { decision: "deny", reason: "request_not_allowed" };`,
  "policy-data-residency": `return record(payload)?.region === "eu-west" ? { decision: "allow" } : { decision: "deny", reason: "region_not_allowed" };`,
  "webhook-currency-normalizer": `const value = record(payload); const currency = value?.currency; const amount = value?.amount; if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency) || typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) throw new Error("invalid_payment"); return { currency: currency.toUpperCase(), amount };`,
  "webhook-ticket-priority": `const value = record(payload)?.priority; const priorities: Record<string, number> = { low: 1, normal: 2, high: 3, urgent: 4 }; return { priority: typeof value === "string" ? priorities[value] ?? 2 : 2 };`
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
    ...options
  });
  assert.equal(result.error, undefined, `${command} failed to start`);
  assert.equal(result.signal, null, `${command} was signaled: ${result.stderr}`);
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return result;
}
