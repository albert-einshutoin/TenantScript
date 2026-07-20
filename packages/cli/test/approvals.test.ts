import { describe, expect, it } from "vitest";
import {
  createHttpRollbackClient,
  runExtCli,
  type ApprovalDecisionClient,
  type CliIo,
  type FetchLike,
  type RollbackClient
} from "../src/index.js";

describe("ext approvals", () => {
  it("approves an approval and prints the updated state", async () => {
    const calls: unknown[] = [];
    const stdout: string[] = [];
    const client: RollbackClient & ApprovalDecisionClient = {
      rollbackInstallation: () => {
        throw new Error("rollback should not be called");
      },
      decideApproval: (request) => {
        calls.push(request);
        return Promise.resolve({
          id: request.id,
          tenantId: request.tenantId,
          pluginId: "plugin_1",
          role: "manager",
          subject: { invoiceId: "inv_1" },
          resumeHook: "onInvoiceApprovalDecided",
          state: request.decision,
          expiresAt: new Date("2026-06-14T01:00:00.000Z"),
          createdAt: new Date("2026-06-13T01:00:00.000Z"),
          decidedBy: request.actor,
          decidedAt: new Date("2026-06-13T01:15:00.000Z")
        });
      }
    };

    await expect(
      runExtCli(
        [
          "approvals",
          "approve",
          "--approval",
          "approval_1",
          "--tenant",
          "tenant_1",
          "--audit-id",
          "audit_1",
          "--actor",
          "manager@example.com",
          "--reason",
          "valid"
        ],
        client,
        captureIo(stdout, [])
      )
    ).resolves.toBe(0);

    expect(calls).toEqual([
      {
        id: "approval_1",
        tenantId: "tenant_1",
        decision: "approved",
        auditId: "audit_1",
        actor: "manager@example.com",
        reason: "valid"
      }
    ]);
    expect(stdout).toEqual([
      JSON.stringify({
        approvalId: "approval_1",
        state: "approved",
        decidedBy: "manager@example.com"
      })
    ]);
  });

  it.each([
    ["approval", ["approvals", "reject"]],
    ["tenant", ["approvals", "reject", "--approval", "approval_1"]],
    ["audit-id", ["approvals", "reject", "--approval", "approval_1", "--tenant", "tenant_1"]],
    [
      "actor",
      [
        "approvals",
        "reject",
        "--approval",
        "approval_1",
        "--tenant",
        "tenant_1",
        "--audit-id",
        "audit_1"
      ]
    ]
  ])("rejects missing --%s approval decision options", async (missing, argv) => {
    const stderr: string[] = [];

    await expect(
      runExtCli(argv, rollbackOnlyClient, {
        stdout: () => {},
        stderr: (line) => stderr.push(line)
      })
    ).resolves.toBe(2);

    expect(stderr).toEqual([`missing required approvals option: --${missing}`]);
  });

  it("rejects unknown approval actions", async () => {
    const stderr: string[] = [];

    await expect(
      runExtCli(["approvals", "maybe"], rollbackOnlyClient, captureIo([], stderr))
    ).resolves.toBe(2);

    expect(stderr).toEqual(["unknown approvals action: maybe"]);
  });

  it("fails when approval decisions are not configured on the client", async () => {
    const stderr: string[] = [];

    await expect(
      runExtCli(
        [
          "approvals",
          "approve",
          "--approval",
          "approval_1",
          "--tenant",
          "tenant_1",
          "--audit-id",
          "audit_1",
          "--actor",
          "manager@example.com"
        ],
        rollbackOnlyClient,
        captureIo([], stderr)
      )
    ).resolves.toBe(1);

    expect(stderr).toEqual(["approval decision client is not configured"]);
  });

  it("returns a command failure when approval decisions fail", async () => {
    const stderr: string[] = [];
    const client: RollbackClient & ApprovalDecisionClient = {
      rollbackInstallation: rollbackOnlyClient.rollbackInstallation,
      decideApproval: () => Promise.reject(new Error("decision conflict"))
    };

    await expect(
      runExtCli(
        [
          "approvals",
          "reject",
          "--approval",
          "approval_1",
          "--tenant",
          "tenant_1",
          "--audit-id",
          "audit_1",
          "--actor",
          "manager@example.com"
        ],
        client,
        captureIo([], stderr)
      )
    ).resolves.toBe(1);

    expect(stderr).toEqual(["decision conflict"]);
  });

  it("posts approval decisions through the HTTP client", async () => {
    const calls: unknown[] = [];
    const fetchImpl: FetchLike = (input, init) => {
      calls.push({ input, init });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            id: "approval_1",
            tenantId: "tenant_1",
            pluginId: "plugin_1",
            role: "manager",
            subject: { invoiceId: "inv_1" },
            resumeHook: "onInvoiceApprovalDecided",
            state: "rejected",
            expiresAt: "2026-06-14T01:00:00.000Z",
            createdAt: "2026-06-13T01:00:00.000Z",
            decidedBy: "manager@example.com"
          }),
        text: () => Promise.resolve("")
      });
    };

    await expect(
      createHttpRollbackClient("https://control-plane.example", fetchImpl).decideApproval({
        id: "approval_1",
        tenantId: "tenant_1",
        decision: "rejected",
        auditId: "audit_1",
        actor: "manager@example.com"
      })
    ).resolves.toMatchObject({ id: "approval_1", state: "rejected" });

    expect(calls).toEqual([
      {
        input: "https://control-plane.example/approvals/approval_1/decision",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: "approval_1",
            tenantId: "tenant_1",
            decision: "rejected",
            auditId: "audit_1",
            actor: "manager@example.com"
          })
        }
      }
    ]);
  });

  it("surfaces HTTP approval decision failures", async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve({
        ok: false,
        status: 409,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve("already decided with fixture-secret")
      });

    await expect(
      createHttpRollbackClient("https://control-plane.example", fetchImpl).decideApproval({
        id: "approval_1",
        tenantId: "tenant_1",
        decision: "approved",
        auditId: "audit_1",
        actor: "manager@example.com"
      })
    ).rejects.toThrow(/^approval decision request failed with HTTP 409$/u);
  });
});

const rollbackOnlyClient: RollbackClient = {
  rollbackInstallation: () => {
    throw new Error("rollback should not be called");
  }
};

function captureIo(stdout: string[], stderr: string[]): CliIo {
  return {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  };
}
