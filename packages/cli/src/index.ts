import type { RollbackInstallationRequest, RollbackResult } from "@tenantscript/control-plane";

export interface RollbackClient {
  rollbackInstallation: (request: RollbackInstallationRequest) => Promise<RollbackResult>;
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

export async function runExtCli(
  argv: readonly string[],
  client: RollbackClient,
  io: CliIo = consoleIo
): Promise<number> {
  const [command, ...args] = argv;
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

export function createHttpRollbackClient(baseUrl: string, fetchImpl: FetchLike): RollbackClient {
  return {
    rollbackInstallation: async (request) => {
      const response = await fetchImpl(
        `${baseUrl.replace(/\/$/, "")}/installations/${request.installationId}/rollback`,
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
    }
  };
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

const consoleIo: CliIo = {
  stdout: (line) => {
    console.log(line);
  },
  stderr: (line) => {
    console.error(line);
  }
};
