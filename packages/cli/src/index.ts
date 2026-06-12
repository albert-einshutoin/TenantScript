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
