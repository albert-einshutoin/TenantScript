import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHttpRollbackClient,
  runExtCli,
  type CliIo,
  type FetchLike,
  type RollbackClient
} from "../src/index.js";

describe("ext rollback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the rollback client and prints the updated pin and audit id", async () => {
    const calls: unknown[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const client: RollbackClient = {
      rollbackInstallation: (request) => {
        calls.push(request);
        return Promise.resolve({
          installation: {
            id: request.installationId,
            tenantId: "tenant_1",
            pluginVersionId: "version_0",
            enabled: true,
            priority: 10,
            config: {},
            grants: {}
          },
          audit: {
            id: request.auditId,
            tenantId: "tenant_1",
            pluginId: "plugin_1",
            hookName: "installation.rollback",
            version: request.targetVersion,
            status: "success",
            durationMs: 0,
            error: "rolled back",
            capabilityCalls: [{ name: "rollback", status: "success" }],
            createdAt: new Date("2026-06-13T00:00:00.000Z")
          }
        });
      }
    };

    await expect(
      runExtCli(
        [
          "rollback",
          "--app",
          "app_1",
          "--plugin",
          "large-invoice-notify",
          "--installation",
          "inst_1",
          "--to",
          "0.9.0",
          "--audit-id",
          "audit_1",
          "--actor",
          "ops@example.com",
          "--reason",
          "bad deploy"
        ],
        client,
        captureIo(stdout, stderr)
      )
    ).resolves.toBe(0);

    expect(calls).toEqual([
      {
        appId: "app_1",
        pluginKey: "large-invoice-notify",
        installationId: "inst_1",
        targetVersion: "0.9.0",
        auditId: "audit_1",
        actor: "ops@example.com",
        reason: "bad deploy"
      }
    ]);
    expect(stdout).toEqual([
      JSON.stringify({
        installationId: "inst_1",
        pluginVersionId: "version_0",
        auditId: "audit_1"
      })
    ]);
    expect(stderr).toEqual([]);
  });

  it("rejects missing rollback options without calling the client", async () => {
    const stderr: string[] = [];
    const client: RollbackClient = {
      rollbackInstallation: () => {
        throw new Error("should not be called");
      }
    };

    await expect(
      runExtCli(["rollback", "--app", "app_1"], client, captureIo([], stderr))
    ).resolves.toBe(2);

    expect(stderr).toEqual(["missing required rollback option: --plugin"]);
  });

  it("ignores malformed flag pairs while reporting the first missing option", async () => {
    const stderr: string[] = [];
    const client: RollbackClient = {
      rollbackInstallation: () => {
        throw new Error("should not be called");
      }
    };

    await expect(
      runExtCli(["rollback", "app_1", "--plugin"], client, captureIo([], stderr))
    ).resolves.toBe(2);

    expect(stderr).toEqual(["missing required rollback option: --app"]);
  });

  it.each([
    ["plugin", ["rollback", "--app", "app_1"]],
    ["installation", ["rollback", "--app", "app_1", "--plugin", "large-invoice-notify"]],
    [
      "to",
      ["rollback", "--app", "app_1", "--plugin", "large-invoice-notify", "--installation", "inst_1"]
    ],
    [
      "audit-id",
      [
        "rollback",
        "--app",
        "app_1",
        "--plugin",
        "large-invoice-notify",
        "--installation",
        "inst_1",
        "--to",
        "0.9.0"
      ]
    ],
    [
      "actor",
      [
        "rollback",
        "--app",
        "app_1",
        "--plugin",
        "large-invoice-notify",
        "--installation",
        "inst_1",
        "--to",
        "0.9.0",
        "--audit-id",
        "audit_1"
      ]
    ]
  ])("reports missing --%s", async (missing, argv) => {
    const stderr: string[] = [];
    const client: RollbackClient = {
      rollbackInstallation: () => {
        throw new Error("should not be called");
      }
    };

    await expect(runExtCli(argv, client, captureIo([], stderr))).resolves.toBe(2);

    expect(stderr).toEqual([`missing required rollback option: --${missing}`]);
  });

  it("supports rollback without an optional reason using the default stdout", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const client: RollbackClient = {
      rollbackInstallation: (request) =>
        Promise.resolve({
          installation: {
            id: request.installationId,
            tenantId: "tenant_1",
            pluginVersionId: "version_0",
            enabled: true,
            priority: 10,
            config: {},
            grants: {}
          },
          audit: {
            id: request.auditId,
            tenantId: "tenant_1",
            pluginId: "plugin_1",
            hookName: "installation.rollback",
            version: request.targetVersion,
            status: "success",
            durationMs: 0,
            error: "rolled back",
            capabilityCalls: [{ name: "rollback", status: "success" }],
            createdAt: new Date("2026-06-13T00:00:00.000Z")
          }
        })
    };

    await expect(
      runExtCli(
        [
          "rollback",
          "--app",
          "app_1",
          "--plugin",
          "large-invoice-notify",
          "--installation",
          "inst_1",
          "--to",
          "0.9.0",
          "--audit-id",
          "audit_1",
          "--actor",
          "ops@example.com"
        ],
        client
      )
    ).resolves.toBe(0);

    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        installationId: "inst_1",
        pluginVersionId: "version_0",
        auditId: "audit_1"
      })
    );
  });

  it("rejects unknown commands using the default stderr", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client: RollbackClient = {
      rollbackInstallation: () => {
        throw new Error("should not be called");
      }
    };

    await expect(runExtCli(["unknown"], client)).resolves.toBe(2);

    expect(error).toHaveBeenCalledWith("unknown command: unknown");
  });

  it("returns a command failure when the rollback client fails", async () => {
    const stderr: string[] = [];
    const client: RollbackClient = {
      rollbackInstallation: () => Promise.reject(new Error("network unavailable"))
    };

    await expect(
      runExtCli(
        [
          "rollback",
          "--app",
          "app_1",
          "--plugin",
          "large-invoice-notify",
          "--installation",
          "inst_1",
          "--to",
          "0.9.0",
          "--audit-id",
          "audit_1",
          "--actor",
          "ops@example.com"
        ],
        client,
        captureIo([], stderr)
      )
    ).resolves.toBe(1);

    expect(stderr).toEqual(["network unavailable"]);
  });

  it("posts rollback requests through the HTTP client", async () => {
    const calls: unknown[] = [];
    const fetchImpl: FetchLike = (input, init) => {
      calls.push({ input, init });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            installation: {
              id: "inst_1",
              tenantId: "tenant_1",
              pluginVersionId: "version_0",
              enabled: true,
              priority: 10,
              config: {},
              grants: {}
            },
            audit: {
              id: "audit_1",
              tenantId: "tenant_1",
              pluginId: "plugin_1",
              hookName: "installation.rollback",
              version: "0.9.0",
              status: "success",
              durationMs: 0,
              error: "rolled back",
              capabilityCalls: [{ name: "rollback", status: "success" }],
              createdAt: "2026-06-13T00:00:00.000Z"
            }
          }),
        text: () => Promise.resolve("")
      });
    };

    await expect(
      createHttpRollbackClient("https://control-plane.example/", fetchImpl).rollbackInstallation({
        appId: "app_1",
        pluginKey: "large-invoice-notify",
        installationId: "inst_1",
        targetVersion: "0.9.0",
        auditId: "audit_1",
        actor: "ops@example.com"
      })
    ).resolves.toMatchObject({
      installation: { id: "inst_1", pluginVersionId: "version_0" },
      audit: { id: "audit_1" }
    });

    expect(calls).toEqual([
      {
        input: "https://control-plane.example/installations/inst_1/rollback",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            appId: "app_1",
            pluginKey: "large-invoice-notify",
            installationId: "inst_1",
            targetVersion: "0.9.0",
            auditId: "audit_1",
            actor: "ops@example.com"
          })
        }
      }
    ]);
  });

  it("surfaces HTTP rollback failures", async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve({
        ok: false,
        status: 409,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve("version conflict with fixture-secret")
      });

    await expect(
      createHttpRollbackClient("https://control-plane.example", fetchImpl).rollbackInstallation({
        appId: "app_1",
        pluginKey: "large-invoice-notify",
        installationId: "inst_1",
        targetVersion: "0.9.0",
        auditId: "audit_1",
        actor: "ops@example.com"
      })
    ).rejects.toThrow(/^rollback request failed with HTTP 409$/u);
  });
});

function captureIo(stdout: string[], stderr: string[]): CliIo {
  return {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  };
}
