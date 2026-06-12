import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { bundlePlugin, runScopedHandler } from "@tenantscript/loader";
import { parseManifest } from "@tenantscript/manifest";
import type {
  ApprovalRecord,
  DecideApprovalRequest,
  RollbackInstallationRequest,
  RollbackResult
} from "@tenantscript/control-plane";

export interface RollbackClient {
  rollbackInstallation: (request: RollbackInstallationRequest) => Promise<RollbackResult>;
}

export interface ApprovalDecisionClient {
  decideApproval: (request: DecideApprovalRequest) => Promise<ApprovalRecord>;
}

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface FetchLike {
  (
    input: string,
    init: { method: "POST"; headers: Record<string, string>; body: string }
  ): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
}

export interface RollbackDrillMeasurementRequest {
  deployedAt: Date;
  detectedAt: Date;
  rollbackStartedAt: Date;
  completedAt: Date;
  thresholdMs?: number;
}

export interface RollbackDrillMeasurement {
  deployedAt: string;
  detectedAt: string;
  rollbackStartedAt: string;
  completedAt: string;
  detectionMs: number;
  rollbackMs: number;
  mttrMs: number;
  thresholdMs: number;
  passed: boolean;
}

export async function runExtCli(
  argv: readonly string[],
  client: RollbackClient & Partial<ApprovalDecisionClient>,
  io: CliIo = consoleIo
): Promise<number> {
  const [command, ...args] = argv;
  if (command === "init") {
    return await runInit(args, io);
  }
  if (command === "build") {
    return await runBuild(args, io);
  }
  if (command === "dev") {
    return await runDev(args, io);
  }
  if (command === "replay") {
    return await runReplay(args, io);
  }
  if (command === "schema") {
    return await runSchema(args, io);
  }
  if (command === "manifest") {
    return await runManifest(args, io);
  }
  if (command === "rollback-drill") {
    return runRollbackDrill(args, io);
  }
  if (command === "approvals") {
    return await runApprovalDecision(args, client, io);
  }
  if (command !== "rollback") {
    io.stderr(`unknown command: ${command ?? ""}`);
    return 2;
  }

  const parsed = parseRollbackArgs(args);
  if (!parsed.ok) {
    io.stderr(parsed.error);
    return 2;
  }

  let result;
  try {
    result = await client.rollbackInstallation(parsed.request);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "rollback failed");
    return 1;
  }
  io.stdout(
    JSON.stringify({
      installationId: result.installation.id,
      pluginVersionId: result.installation.pluginVersionId,
      auditId: result.audit.id
    })
  );
  return 0;
}

export function createHttpRollbackClient(
  baseUrl: string,
  fetchImpl: FetchLike
): RollbackClient & ApprovalDecisionClient {
  const trimmedBaseUrl = baseUrl.replace(/\/$/, "");
  return {
    rollbackInstallation: async (request) => {
      const response = await fetchImpl(
        `${trimmedBaseUrl}/installations/${request.installationId}/rollback`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request)
        }
      );
      if (!response.ok) {
        throw new Error(
          `rollback request failed with HTTP ${String(response.status)}: ${await response.text()}`
        );
      }
      return (await response.json()) as Awaited<ReturnType<RollbackClient["rollbackInstallation"]>>;
    },
    decideApproval: async (request) => {
      const response = await fetchImpl(`${trimmedBaseUrl}/approvals/${request.id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request)
      });
      if (!response.ok) {
        throw new Error(
          `approval decision request failed with HTTP ${String(response.status)}: ${await response.text()}`
        );
      }
      return (await response.json()) as Awaited<
        ReturnType<ApprovalDecisionClient["decideApproval"]>
      >;
    }
  };
}

export function measureRollbackDrill(
  request: RollbackDrillMeasurementRequest
): RollbackDrillMeasurement {
  assertOrdered("detectedAt", request.detectedAt, "deployedAt", request.deployedAt);
  assertOrdered("rollbackStartedAt", request.rollbackStartedAt, "detectedAt", request.detectedAt);
  assertOrdered("completedAt", request.completedAt, "rollbackStartedAt", request.rollbackStartedAt);

  const thresholdMs = request.thresholdMs ?? 5 * 60 * 1000;
  const mttrMs = request.completedAt.getTime() - request.deployedAt.getTime();
  return {
    deployedAt: request.deployedAt.toISOString(),
    detectedAt: request.detectedAt.toISOString(),
    rollbackStartedAt: request.rollbackStartedAt.toISOString(),
    completedAt: request.completedAt.toISOString(),
    detectionMs: request.detectedAt.getTime() - request.deployedAt.getTime(),
    rollbackMs: request.completedAt.getTime() - request.rollbackStartedAt.getTime(),
    mttrMs,
    thresholdMs,
    passed: mttrMs < thresholdMs
  };
}

function runRollbackDrill(args: readonly string[], io: CliIo): number {
  const parsed = parseRollbackDrillArgs(args);
  if (!parsed.ok) {
    io.stderr(parsed.error);
    return 2;
  }

  try {
    io.stdout(JSON.stringify(measureRollbackDrill(parsed.request)));
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "rollback drill measurement failed");
    return 2;
  }
  return 0;
}

async function runInit(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseInitArgs(args);
  if (!parsed.ok) {
    io.stderr(parsed.error);
    return 2;
  }

  try {
    const result = await writePluginScaffold(parsed.request);
    io.stdout(JSON.stringify(result));
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "plugin scaffold generation failed");
    return 2;
  }
}

async function runBuild(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseBuildArgs(args);
  if (!parsed.ok) {
    io.stderr(parsed.error);
    return 2;
  }

  try {
    const bundle = await bundlePlugin(parsed.request.entry);
    await mkdir(dirname(parsed.request.out), { recursive: true });
    await writeFile(parsed.request.out, bundle.code);
    io.stdout(
      JSON.stringify({
        entry: parsed.request.entry,
        out: parsed.request.out,
        sha256: bundle.sha256,
        bytes: bundle.code.length
      })
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "plugin build failed");
    return 1;
  }
}

async function runDev(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseDevArgs(args);
  if (!parsed.ok) {
    io.stderr(parsed.error);
    return 2;
  }

  try {
    const bundle = await bundlePlugin(parsed.request.entry);
    const result = await runScopedHandler({
      bundleCode: bundle.code,
      handlerName: parsed.request.hookName,
      payload: parsed.request.payload,
      context: {
        capability: (name, input) =>
          Promise.resolve({
            ok: true,
            name,
            input
          })
      }
    });
    io.stdout(
      JSON.stringify({
        hookName: parsed.request.hookName,
        value: result.value,
        logs: result.logs
      })
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "plugin dev invocation failed");
    return 1;
  }
}

async function runReplay(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseReplayArgs(args);
  if (!parsed.ok) {
    io.stderr(parsed.error);
    return 2;
  }

  let sample: ReplaySample;
  try {
    sample = await readReplaySample(parsed.request.sample);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "invalid replay sample");
    return error instanceof ReplaySampleError ? 2 : 1;
  }

  try {
    const capabilityCalls: { name: string; status: "success" | "denied" | "error" }[] = [];
    const bundle = await bundlePlugin(parsed.request.entry);
    const result = await runScopedHandler({
      bundleCode: bundle.code,
      handlerName: sample.execution.hookName,
      payload: sample.payload,
      context: {
        capability: (name, input) => {
          capabilityCalls.push({ name, status: "success" });
          return Promise.resolve(sample.capabilityResponses[name] ?? { ok: true, name, input });
        }
      }
    });

    io.stdout(
      JSON.stringify({
        executionId: sample.execution.id,
        hookName: sample.execution.hookName,
        previous: {
          value: sample.value,
          capabilityCalls: sample.execution.capabilityCalls
        },
        replay: {
          value: result.value,
          capabilityCalls
        },
        diff: {
          valueChanged: !jsonEqual(sample.value, result.value),
          capabilityCallsChanged: !jsonEqual(sample.execution.capabilityCalls, capabilityCalls)
        }
      })
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "plugin replay failed");
    return 1;
  }
}

async function runSchema(args: readonly string[], io: CliIo): Promise<number> {
  const [action, ...actionArgs] = args;
  if (action !== "diff") {
    io.stderr(`unknown schema action: ${action ?? ""}`);
    return 2;
  }
  const parsed = parseSchemaDiffArgs(actionArgs);
  if (!parsed.ok) {
    io.stderr(parsed.error);
    return 2;
  }

  try {
    const from = await readHookSchema(parsed.request.from);
    const to = await readHookSchema(parsed.request.to);
    const diff = diffHookSchemas(from, to);
    io.stdout(JSON.stringify(diff));
    return diff.compatible ? 0 : 1;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "schema diff failed");
    return 1;
  }
}

async function runManifest(args: readonly string[], io: CliIo): Promise<number> {
  const [action, ...actionArgs] = args;
  if (action !== "lint") {
    io.stderr(`unknown manifest action: ${action ?? ""}`);
    return 2;
  }
  const parsed = parseManifestLintArgs(actionArgs);
  if (!parsed.ok) {
    io.stderr(parsed.error);
    return 2;
  }

  try {
    const manifest = JSON.parse(await readFile(parsed.request.manifest, "utf8")) as unknown;
    const result = parseManifest(manifest);
    if (!result.ok) {
      io.stdout(JSON.stringify({ ok: false, errors: result.errors }));
      return 1;
    }
    io.stdout(
      JSON.stringify({
        ok: true,
        name: result.value.name,
        version: result.value.version,
        hooks: result.value.hooks.map((hook) => hook.name)
      })
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "manifest lint failed");
    return 1;
  }
}

async function runApprovalDecision(
  args: readonly string[],
  client: Partial<ApprovalDecisionClient>,
  io: CliIo
): Promise<number> {
  const parsed = parseApprovalDecisionArgs(args);
  if (!parsed.ok) {
    io.stderr(parsed.error);
    return 2;
  }
  if (client.decideApproval === undefined) {
    io.stderr("approval decision client is not configured");
    return 1;
  }

  let result;
  try {
    result = await client.decideApproval(parsed.request);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "approval decision failed");
    return 1;
  }

  io.stdout(
    JSON.stringify({
      approvalId: result.id,
      state: result.state,
      decidedBy: result.decidedBy
    })
  );
  return 0;
}

interface InitRequest {
  name: string;
  directory: string;
  hookName: string;
  hookType: "event" | "transform" | "policy";
}

interface InitResult {
  name: string;
  directory: string;
  files: readonly string[];
}

interface BuildRequest {
  entry: string;
  out: string;
}

interface DevRequest {
  entry: string;
  hookName: string;
  payload: unknown;
}

interface ReplayRequest {
  entry: string;
  sample: string;
}

interface ReplaySample {
  execution: {
    id: string;
    hookName: string;
    capabilityCalls: readonly { name: string; status: "success" | "denied" | "error" }[];
  };
  payload: unknown;
  value: unknown;
  capabilityResponses: Record<string, unknown>;
}

interface SchemaDiffRequest {
  from: string;
  to: string;
}

interface ManifestLintRequest {
  manifest: string;
}

interface HookSchema {
  properties: Record<string, { type: string }>;
  required: ReadonlySet<string>;
}

interface SchemaDiffResult {
  compatible: boolean;
  breaking: readonly string[];
  warnings: readonly string[];
}

class ReplaySampleError extends Error {}

function parseInitArgs(
  args: readonly string[]
): { ok: true; request: InitRequest } | { ok: false; error: string } {
  const flags = readFlags(args);
  const name = flags.name;
  if (name === undefined) {
    return { ok: false, error: "missing required init option: --name" };
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return { ok: false, error: "invalid init option: --name must be kebab-case" };
  }
  const directory = flags.dir;
  if (directory === undefined) {
    return { ok: false, error: "missing required init option: --dir" };
  }
  const hookName = flags.hook ?? "invoice.created";
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/.test(hookName)) {
    return {
      ok: false,
      error: "invalid init option: --hook must be dot-separated lowercase segments"
    };
  }
  const hookType = parseHookType(flags.type ?? "event");
  if (hookType === undefined) {
    return { ok: false, error: "invalid init option: --type must be event, transform, or policy" };
  }

  return {
    ok: true,
    request: {
      name,
      directory: resolve(directory),
      hookName,
      hookType
    }
  };
}

function parseBuildArgs(
  args: readonly string[]
): { ok: true; request: BuildRequest } | { ok: false; error: string } {
  const flags = readFlags(args);
  const entry = flags.entry;
  if (entry === undefined) {
    return { ok: false, error: "missing required build option: --entry" };
  }
  const out = flags.out ?? "dist/plugin.cjs";
  return {
    ok: true,
    request: {
      entry: resolve(entry),
      out: resolve(out)
    }
  };
}

function parseDevArgs(
  args: readonly string[]
): { ok: true; request: DevRequest } | { ok: false; error: string } {
  const flags = readFlags(args);
  const entry = flags.entry;
  if (entry === undefined) {
    return { ok: false, error: "missing required dev option: --entry" };
  }
  const hookName = flags.hook;
  if (hookName === undefined) {
    return { ok: false, error: "missing required dev option: --hook" };
  }
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/.test(hookName)) {
    return {
      ok: false,
      error: "invalid dev option: --hook must be dot-separated lowercase segments"
    };
  }
  const payload = parseJsonPayload(flags.payload ?? "{}");
  if (!payload.ok) {
    return { ok: false, error: payload.error };
  }

  return {
    ok: true,
    request: {
      entry: resolve(entry),
      hookName,
      payload: payload.value
    }
  };
}

function parseReplayArgs(
  args: readonly string[]
): { ok: true; request: ReplayRequest } | { ok: false; error: string } {
  const flags = readFlags(args);
  const entry = flags.entry;
  if (entry === undefined) {
    return { ok: false, error: "missing required replay option: --entry" };
  }
  const sample = flags.sample;
  if (sample === undefined) {
    return { ok: false, error: "missing required replay option: --sample" };
  }
  return {
    ok: true,
    request: {
      entry: resolve(entry),
      sample: resolve(sample)
    }
  };
}

function parseSchemaDiffArgs(
  args: readonly string[]
): { ok: true; request: SchemaDiffRequest } | { ok: false; error: string } {
  const flags = readFlags(args);
  const from = flags.from;
  if (from === undefined) {
    return { ok: false, error: "missing required schema diff option: --from" };
  }
  const to = flags.to;
  if (to === undefined) {
    return { ok: false, error: "missing required schema diff option: --to" };
  }
  return { ok: true, request: { from: resolve(from), to: resolve(to) } };
}

function parseManifestLintArgs(
  args: readonly string[]
): { ok: true; request: ManifestLintRequest } | { ok: false; error: string } {
  const flags = readFlags(args);
  const manifest = flags.manifest;
  if (manifest === undefined) {
    return { ok: false, error: "missing required manifest lint option: --manifest" };
  }
  return { ok: true, request: { manifest: resolve(manifest) } };
}

function parseJsonPayload(
  value: string
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false, error: "invalid dev option: --payload must be JSON" };
  }
}

async function readHookSchema(path: string): Promise<HookSchema> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`schema ${path} must be an object`);
  }
  const properties = parseSchemaProperties(parsed.properties);
  const required = Array.isArray(parsed.required)
    ? new Set(parsed.required.filter((name): name is string => typeof name === "string"))
    : new Set<string>();
  return { properties, required };
}

function parseSchemaProperties(value: unknown): Record<string, { type: string }> {
  if (!isRecord(value)) {
    return {};
  }
  const properties: Record<string, { type: string }> = {};
  for (const [name, field] of Object.entries(value)) {
    if (isRecord(field) && typeof field.type === "string") {
      properties[name] = { type: field.type };
    }
  }
  return properties;
}

function diffHookSchemas(from: HookSchema, to: HookSchema): SchemaDiffResult {
  const breaking: string[] = [];
  const warnings: string[] = [];

  for (const [name, previousField] of Object.entries(from.properties)) {
    const nextField = to.properties[name];
    if (nextField === undefined) {
      breaking.push(`field ${name} was removed`);
      continue;
    }
    if (nextField.type !== previousField.type) {
      breaking.push(`field ${name} changed type from ${previousField.type} to ${nextField.type}`);
    }
    if (!from.required.has(name) && to.required.has(name)) {
      breaking.push(`field ${name} became required`);
    }
  }

  for (const name of Object.keys(to.properties)) {
    if (from.properties[name] !== undefined) {
      continue;
    }
    if (to.required.has(name)) {
      breaking.push(`required field ${name} was added`);
    } else {
      warnings.push(`optional field ${name} was added`);
    }
  }

  return {
    compatible: breaking.length === 0,
    breaking,
    warnings
  };
}

async function readReplaySample(path: string): Promise<ReplaySample> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new ReplaySampleError("invalid replay sample: execution.hookName is required");
  }
  const execution = parsed.execution;
  if (!isRecord(execution) || typeof execution.hookName !== "string") {
    throw new ReplaySampleError("invalid replay sample: execution.hookName is required");
  }
  if (typeof execution.id !== "string") {
    throw new ReplaySampleError("invalid replay sample: execution.id is required");
  }

  return {
    execution: {
      id: execution.id,
      hookName: execution.hookName,
      capabilityCalls: parseReplayCapabilityCalls(execution.capabilityCalls)
    },
    payload: parsed.payload,
    value: parsed.value,
    capabilityResponses: isRecord(parsed.capabilityResponses) ? parsed.capabilityResponses : {}
  };
}

function parseReplayCapabilityCalls(
  value: unknown
): readonly { name: string; status: "success" | "denied" | "error" }[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      !isCapabilityCallStatus(entry.status)
    ) {
      return [];
    }
    return [{ name: entry.name, status: entry.status }];
  });
}

function isCapabilityCallStatus(value: unknown): value is "success" | "denied" | "error" {
  return value === "success" || value === "denied" || value === "error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseHookType(value: string): InitRequest["hookType"] | undefined {
  if (value === "event" || value === "transform" || value === "policy") {
    return value;
  }
  return undefined;
}

function parseRollbackArgs(
  args: readonly string[]
): { ok: true; request: RollbackInstallationRequest } | { ok: false; error: string } {
  const flags = readFlags(args);
  const requiredFlags = readRequiredRollbackFlags(flags);
  if (!requiredFlags.ok) {
    return { ok: false, error: requiredFlags.error };
  }

  return {
    ok: true,
    request: {
      appId: requiredFlags.value.app,
      pluginKey: requiredFlags.value.plugin,
      installationId: requiredFlags.value.installation,
      targetVersion: requiredFlags.value.to,
      auditId: requiredFlags.value.auditId,
      actor: requiredFlags.value.actor,
      ...(flags.reason === undefined ? {} : { reason: flags.reason })
    }
  };
}

function parseApprovalDecisionArgs(
  args: readonly string[]
): { ok: true; request: DecideApprovalRequest } | { ok: false; error: string } {
  const [action, ...flagArgs] = args;
  const decision = action === "approve" ? "approved" : action === "reject" ? "rejected" : undefined;
  if (decision === undefined) {
    return { ok: false, error: `unknown approvals action: ${action ?? ""}` };
  }
  const flags = readFlags(flagArgs);
  const required = readRequiredApprovalDecisionFlags(flags);
  if (!required.ok) {
    return { ok: false, error: required.error };
  }

  return {
    ok: true,
    request: {
      id: required.value.approval,
      tenantId: required.value.tenant,
      decision,
      auditId: required.value.auditId,
      actor: required.value.actor,
      ...(flags.reason === undefined ? {} : { reason: flags.reason })
    }
  };
}

function parseRollbackDrillArgs(
  args: readonly string[]
): { ok: true; request: RollbackDrillMeasurementRequest } | { ok: false; error: string } {
  const flags = readFlags(args);
  const deployedAt = readRequiredDateFlag(flags, "deployed-at");
  if (!deployedAt.ok) {
    return deployedAt;
  }
  const detectedAt = readRequiredDateFlag(flags, "detected-at");
  if (!detectedAt.ok) {
    return detectedAt;
  }
  const rollbackStartedAt = readRequiredDateFlag(flags, "rollback-started-at");
  if (!rollbackStartedAt.ok) {
    return rollbackStartedAt;
  }
  const completedAt = readRequiredDateFlag(flags, "completed-at");
  if (!completedAt.ok) {
    return completedAt;
  }
  const thresholdMs = readOptionalPositiveIntegerFlag(flags, "threshold-ms");
  if (!thresholdMs.ok) {
    return thresholdMs;
  }

  return {
    ok: true,
    request: {
      deployedAt: deployedAt.value,
      detectedAt: detectedAt.value,
      rollbackStartedAt: rollbackStartedAt.value,
      completedAt: completedAt.value,
      ...(thresholdMs.value === undefined ? {} : { thresholdMs: thresholdMs.value })
    }
  };
}

interface RequiredApprovalDecisionFlags {
  approval: string;
  tenant: string;
  auditId: string;
  actor: string;
}

function readRequiredApprovalDecisionFlags(
  flags: Record<string, string>
): { ok: true; value: RequiredApprovalDecisionFlags } | { ok: false; error: string } {
  const approval = flags.approval;
  if (approval === undefined) {
    return { ok: false, error: "missing required approvals option: --approval" };
  }
  const tenant = flags.tenant;
  if (tenant === undefined) {
    return { ok: false, error: "missing required approvals option: --tenant" };
  }
  const auditId = flags["audit-id"];
  if (auditId === undefined) {
    return { ok: false, error: "missing required approvals option: --audit-id" };
  }
  const actor = flags.actor;
  if (actor === undefined) {
    return { ok: false, error: "missing required approvals option: --actor" };
  }
  return { ok: true, value: { approval, tenant, auditId, actor } };
}

interface RequiredRollbackFlags {
  app: string;
  plugin: string;
  installation: string;
  to: string;
  auditId: string;
  actor: string;
}

function readRequiredRollbackFlags(
  flags: Record<string, string>
): { ok: true; value: RequiredRollbackFlags } | { ok: false; error: string } {
  const app = flags.app;
  if (app === undefined) {
    return { ok: false, error: "missing required rollback option: --app" };
  }
  const plugin = flags.plugin;
  if (plugin === undefined) {
    return { ok: false, error: "missing required rollback option: --plugin" };
  }
  const installation = flags.installation;
  if (installation === undefined) {
    return { ok: false, error: "missing required rollback option: --installation" };
  }
  const to = flags.to;
  if (to === undefined) {
    return { ok: false, error: "missing required rollback option: --to" };
  }
  const auditId = flags["audit-id"];
  if (auditId === undefined) {
    return { ok: false, error: "missing required rollback option: --audit-id" };
  }
  const actor = flags.actor;
  if (actor === undefined) {
    return { ok: false, error: "missing required rollback option: --actor" };
  }
  return { ok: true, value: { app, plugin, installation, to, auditId, actor } };
}

function readRequiredDateFlag(
  flags: Record<string, string>,
  name: string
): { ok: true; value: Date } | { ok: false; error: string } {
  const value = flags[name];
  if (value === undefined) {
    return { ok: false, error: `missing required rollback-drill option: --${name}` };
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: `invalid rollback-drill timestamp: --${name}` };
  }
  return { ok: true, value: date };
}

function readOptionalPositiveIntegerFlag(
  flags: Record<string, string>,
  name: string
): { ok: true; value?: number } | { ok: false; error: string } {
  const value = flags[name];
  if (value === undefined) {
    return { ok: true };
  }
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    return { ok: false, error: `invalid rollback-drill integer: --${name}` };
  }
  return { ok: true, value: numberValue };
}

function readFlags(args: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (name === undefined || !name.startsWith("--") || value === undefined) {
      continue;
    }
    flags[name.slice(2)] = value;
  }
  return flags;
}

async function writePluginScaffold(request: InitRequest): Promise<InitResult> {
  await assertTargetDirectoryIsEmpty(request.directory);

  const files = [
    "package.json",
    "tsconfig.json",
    "src/manifest.ts",
    "src/index.ts",
    "test/plugin.test.ts"
  ] as const;
  await mkdir(resolve(request.directory, "src"), { recursive: true });
  await mkdir(resolve(request.directory, "test"), { recursive: true });
  await Promise.all([
    writeScaffoldFile(request.directory, "package.json", packageJsonTemplate(request)),
    writeScaffoldFile(request.directory, "tsconfig.json", tsconfigTemplate()),
    writeScaffoldFile(request.directory, "src/manifest.ts", manifestTemplate(request)),
    writeScaffoldFile(request.directory, "src/index.ts", pluginTemplate(request)),
    writeScaffoldFile(request.directory, "test/plugin.test.ts", pluginTestTemplate(request))
  ]);

  return {
    name: request.name,
    directory: request.directory,
    files
  };
}

async function assertTargetDirectoryIsEmpty(directory: string): Promise<void> {
  try {
    const entries = await readdir(directory);
    if (entries.length > 0) {
      throw new Error(`target directory is not empty: ${directory}`);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function writeScaffoldFile(directory: string, path: string, content: string): Promise<void> {
  await writeFile(resolve(directory, path), content, { flag: "wx" });
}

function packageJsonTemplate(request: InitRequest): string {
  return `${JSON.stringify(
    {
      name: `@tenantscript-plugin/${request.name}`,
      version: "0.1.0",
      type: "module",
      private: true,
      scripts: {
        build: "tsc --noEmit",
        test: "vitest run"
      },
      dependencies: {
        "@tenantscript/manifest": "0.0.0",
        "@tenantscript/plugin-sdk": "0.0.0"
      },
      devDependencies: {
        typescript: "^5.8.3",
        vitest: "^4.1.8"
      }
    },
    null,
    2
  )}\n`;
}

function tsconfigTemplate(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        verbatimModuleSyntax: true,
        isolatedModules: true,
        skipLibCheck: true
      },
      include: ["src/**/*.ts", "test/**/*.ts"]
    },
    null,
    2
  )}\n`;
}

function manifestTemplate(request: InitRequest): string {
  return `import type { TenantScriptManifest } from "@tenantscript/manifest";

export const manifest = {
  name: "${request.name}",
  version: "0.1.0",
  hooks: [{ name: "${request.hookName}", type: "${request.hookType}", timeoutMs: 250 }],
  capabilities: {},
  configSchema: {
    properties: {},
    required: []
  },
  egress: { mode: "deny" },
  limits: { cpuMs: 50, timeoutMs: 500 }
} satisfies TenantScriptManifest;
`;
}

function pluginTemplate(request: InitRequest): string {
  return `import { definePlugin } from "@tenantscript/plugin-sdk";
import { manifest } from "./manifest.js";

export const plugin = definePlugin({
  manifest,
  handlers: {
    "${request.hookName}": ${handlerTemplate(request.hookType)}
  }
});

export default plugin;
`;
}

function handlerTemplate(hookType: InitRequest["hookType"]): string {
  if (hookType === "transform") {
    return "async (payload, _context) => payload";
  }
  if (hookType === "policy") {
    return 'async (_payload, _context) => ({ decision: "allow" })';
  }
  return "async (_payload, _context) => undefined";
}

function pluginTestTemplate(request: InitRequest): string {
  return `import { describe, expect, it, vi } from "vitest";
import { plugin } from "../src/index.js";

describe("${request.name}", () => {
  it("dispatches ${request.hookName}", async () => {
    const result = await plugin.dispatch({
      hookName: "${request.hookName}",
      payload: { id: "evt_1" },
      context: {
        capability: vi.fn()
      }
    });

    expect(result.ok).toBe(true);
  });
});
`;
}

function assertOrdered(
  currentName: string,
  current: Date,
  previousName: string,
  previous: Date
): void {
  if (current.getTime() < previous.getTime()) {
    throw new Error(`${currentName} must be at or after ${previousName}`);
  }
}

const consoleIo: CliIo = {
  stdout: (line) => {
    console.log(line);
  },
  stderr: (line) => {
    console.error(line);
  }
};
