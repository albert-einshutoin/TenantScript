import { describe, expect, it, vi } from "vitest";
import { createControlPlaneHttpHandler } from "@tenantscript/control-plane";
import {
  createBinaryAdminClient,
  createHttpAdminMutationClient,
  runExtCli,
  type AdminMutationClient,
  type CliIo,
  type FetchLike,
  type RollbackClient
} from "../src/index.js";

const token = "fixture-admin-service-token";

describe("authenticated Admin HTTP mutation client", () => {
  it("round-trips rollback authentication and authority through the shipped Worker handler", async () => {
    const storeRequests: unknown[] = [];
    const handler = createControlPlaneHttpHandler({
      adminMutationRateLimiter: allowAdminMutations,
      identityResolver: {
        resolveToken: (credential) =>
          credential === token
            ? { subject: "operator_1", role: "admin", appId: "app_1", tenantId: "tenant_1" }
            : null
      },
      rollbackStore: {
        rollback: (request) => {
          storeRequests.push(request);
          return Promise.resolve({ outcome: "rolled_back", ...rollbackResponse() });
        }
      }
    });
    const client = createHttpAdminMutationClient({
      baseUrl: "https://control-plane.example",
      token,
      fetchImpl: (input, init) => handler(new Request(input, init))
    });

    await expect(
      client.rollbackAdminInstallation({
        installationId: "inst_1",
        targetVersionId: "version_0",
        expectedRevision: 7,
        idempotencyKey: "rollback-request-0001"
      })
    ).resolves.toEqual(rollbackResponse());
    expect(storeRequests).toEqual([
      {
        appId: "app_1",
        tenantId: "tenant_1",
        actor: "operator_1",
        installationId: "inst_1",
        targetVersionId: "version_0",
        expectedRevision: 7,
        idempotencyKey: "rollback-request-0001"
      }
    ]);
  });

  it("round-trips approval scope through the shipped Worker handler", async () => {
    const storeRequests: unknown[] = [];
    const handler = createControlPlaneHttpHandler({
      adminMutationRateLimiter: allowAdminMutations,
      identityResolver: {
        resolveToken: () => ({
          subject: "manager_1",
          role: "admin",
          appId: "app_1",
          tenantId: "tenant_1"
        })
      },
      approvalDecisionStore: {
        decide: (request) => {
          storeRequests.push(request);
          return Promise.resolve(approvalResponse());
        }
      }
    });
    const client = createHttpAdminMutationClient({
      baseUrl: "https://control-plane.example",
      token,
      fetchImpl: (input, init) => handler(new Request(input, init))
    });

    await expect(
      client.decideAdminApproval({
        approvalId: "approval_1",
        decision: "rejected",
        reason: "policy mismatch"
      })
    ).resolves.toEqual(approvalResponse());
    expect(storeRequests).toEqual([
      {
        appId: "app_1",
        tenantId: "tenant_1",
        actor: "manager_1",
        actorRole: "admin",
        approvalId: "approval_1",
        decision: "rejected",
        reason: "policy mismatch"
      }
    ]);
  });

  it("posts an exact authenticated rollback request without client-owned tenant authority", async () => {
    const calls: Array<{ input: string; init: unknown }> = [];
    const fetchImpl: FetchLike = (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(response(200, rollbackResponse()));
    };
    const client = createHttpAdminMutationClient({
      baseUrl: "https://control-plane.example/",
      token,
      fetchImpl
    });

    await expect(
      client.rollbackAdminInstallation({
        installationId: "inst_1",
        targetVersionId: "version_0",
        expectedRevision: 7,
        idempotencyKey: "rollback-request-0001"
      })
    ).resolves.toEqual(rollbackResponse());

    expect(calls).toEqual([
      {
        input: "https://control-plane.example/v1/admin/rollbacks",
        init: {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "idempotency-key": "rollback-request-0001"
          },
          body: JSON.stringify({
            installationId: "inst_1",
            targetVersionId: "version_0",
            expectedRevision: 7
          })
        }
      }
    ]);
  });

  it("posts an exact approval decision and leaves actor and tenant scope to the token", async () => {
    const calls: Array<{ input: string; init: unknown }> = [];
    const fetchImpl: FetchLike = (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(response(200, approvalResponse()));
    };
    const client = createHttpAdminMutationClient({
      baseUrl: "https://control-plane.example",
      token,
      fetchImpl
    });

    await expect(
      client.decideAdminApproval({
        approvalId: "approval_1",
        decision: "rejected",
        reason: "policy mismatch"
      })
    ).resolves.toEqual(approvalResponse());
    expect(calls).toEqual([
      {
        input: "https://control-plane.example/v1/admin/approval-decisions",
        init: {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            approvalId: "approval_1",
            decision: "rejected",
            reason: "policy mismatch"
          })
        }
      }
    ]);
  });

  it.each([
    ["HTTP remote origin", "http://control-plane.example", token],
    ["URL credentials", "https://user@control-plane.example", token],
    ["URL query", "https://control-plane.example?tenant=secret", token],
    ["URL path", "https://control-plane.example/admin", token],
    ["empty token", "https://control-plane.example", ""],
    ["whitespace token", "https://control-plane.example", "fixture token"],
    ["oversized token", "https://control-plane.example", "x".repeat(4097)]
  ])("rejects %s before network access", (_label, baseUrl, credential) => {
    const fetchImpl = vi.fn<FetchLike>();

    expect(() => createHttpAdminMutationClient({ baseUrl, token: credential, fetchImpl })).toThrow(
      "Admin mutation client configuration is invalid"
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows loopback HTTP for local development only", async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(response(200, approvalResponse()));
    const client = createHttpAdminMutationClient({
      baseUrl: "http://127.0.0.1:8787",
      token,
      fetchImpl
    });

    await expect(
      client.decideAdminApproval({ approvalId: "approval_1", decision: "approved" })
    ).resolves.toEqual(approvalResponse());
  });

  it("reports only a bounded public error code and never retries or reflects response data", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(
      response(409, {
        error: {
          code: "installation_revision_conflict",
          message: `private SQL detail ${token}`
        }
      })
    );
    const client = createHttpAdminMutationClient({
      baseUrl: "https://control-plane.example",
      token,
      fetchImpl
    });

    const error = await client
      .rollbackAdminInstallation({
        installationId: "inst_1",
        targetVersionId: "version_0",
        expectedRevision: 7,
        idempotencyKey: "rollback-request-0001"
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Admin mutation request failed with HTTP 409 (installation_revision_conflict)"
    );
    expect((error as Error).message).not.toContain(token);
    expect((error as Error).message).not.toContain("private SQL detail");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("redacts transport failures that may contain request credentials", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockRejectedValue(new Error(`socket failure with Authorization: Bearer ${token}`));
    const client = createHttpAdminMutationClient({
      baseUrl: "https://control-plane.example",
      token,
      fetchImpl
    });

    const error = await client
      .decideAdminApproval({ approvalId: "approval_1", decision: "approved" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Admin mutation request failed");
    expect((error as Error).message).not.toContain(token);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects a malformed success response instead of trusting an assertion", async () => {
    const client = createHttpAdminMutationClient({
      baseUrl: "https://control-plane.example",
      token,
      fetchImpl: () => Promise.resolve(response(200, { installationId: "inst_1" }))
    });

    await expect(
      client.rollbackAdminInstallation({
        installationId: "inst_1",
        targetVersionId: "version_0",
        expectedRevision: 7,
        idempotencyKey: "rollback-request-0001"
      })
    ).rejects.toThrow("Admin mutation response is invalid");
  });

  it("rejects an oversized response body before parsing it", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve("x".repeat(65_537))
    });
    const client = createHttpAdminMutationClient({
      baseUrl: "https://control-plane.example",
      token,
      fetchImpl
    });

    await expect(
      client.decideAdminApproval({ approvalId: "approval_1", decision: "approved" })
    ).rejects.toThrow("Admin mutation response is invalid");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("Admin mutation CLI contract", () => {
  it("uses the shipped rollback command fields and prints the closed Worker response", async () => {
    const requests: unknown[] = [];
    const client = adminClient({
      rollbackAdminInstallation: (request) => {
        requests.push(request);
        return Promise.resolve(rollbackResponse());
      }
    });
    const stdout: string[] = [];

    await expect(
      runExtCli(
        [
          "rollback",
          "--installation",
          "inst_1",
          "--target-version",
          "version_0",
          "--expected-revision",
          "7",
          "--idempotency-key",
          "rollback-request-0001"
        ],
        client,
        captureIo(stdout, [])
      )
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
        installationId: "inst_1",
        targetVersionId: "version_0",
        expectedRevision: 7,
        idempotencyKey: "rollback-request-0001"
      }
    ]);
    expect(stdout).toEqual([JSON.stringify(rollbackResponse())]);
  });

  it("uses token-scoped approval fields without accepting tenant or actor authority", async () => {
    const requests: unknown[] = [];
    const client = adminClient({
      decideAdminApproval: (request) => {
        requests.push(request);
        return Promise.resolve(approvalResponse());
      }
    });
    const stdout: string[] = [];

    await expect(
      runExtCli(
        ["approvals", "approve", "--approval", "approval_1", "--reason", "reviewed"],
        client,
        captureIo(stdout, [])
      )
    ).resolves.toBe(0);

    expect(requests).toEqual([
      { approvalId: "approval_1", decision: "approved", reason: "reviewed" }
    ]);
    expect(stdout).toEqual([JSON.stringify(approvalResponse())]);
  });

  it.each([
    [
      "rollback",
      [
        "rollback",
        "--installation",
        "inst_1",
        "--target-version",
        "version_0",
        "--expected-revision",
        "7",
        "--idempotency-key",
        "short",
        "--actor",
        "injected"
      ],
      "unsupported rollback option: --actor"
    ],
    [
      "approval",
      ["approvals", "approve", "--approval", "approval_1", "--tenant", "injected"],
      "unsupported approvals option: --tenant"
    ]
  ])("rejects client-owned authority on %s", async (_label, argv, expected) => {
    const stderr: string[] = [];
    await expect(runExtCli(argv, adminClient({}), captureIo([], stderr))).resolves.toBe(2);
    expect(stderr).toEqual([expected]);
  });

  it("rejects an invalid idempotency key as usage before calling rollback", async () => {
    const rollbackAdminInstallation = vi.fn<AdminMutationClient["rollbackAdminInstallation"]>();
    const stderr: string[] = [];

    await expect(
      runExtCli(
        [
          "rollback",
          "--installation",
          "inst_1",
          "--target-version",
          "version_0",
          "--expected-revision",
          "7",
          "--idempotency-key",
          "short"
        ],
        adminClient({ rollbackAdminInstallation }),
        captureIo([], stderr)
      )
    ).resolves.toBe(2);
    expect(stderr).toEqual(["invalid rollback option: --idempotency-key"]);
    expect(rollbackAdminInstallation).not.toHaveBeenCalled();
  });
});

describe("public binary Admin client composition", () => {
  it("requires the endpoint and token together without falling back to the legacy contract", async () => {
    const stderr: string[] = [];
    const client = createBinaryAdminClient(
      { TENANTSCRIPT_CONTROL_PLANE_URL: "https://control-plane.example" },
      vi.fn<FetchLike>()
    );

    await expect(
      runExtCli(
        [
          "rollback",
          "--installation",
          "inst_1",
          "--target-version",
          "version_0",
          "--expected-revision",
          "7",
          "--idempotency-key",
          "rollback-request-0001"
        ],
        client,
        captureIo([], stderr)
      )
    ).resolves.toBe(1);
    expect(stderr).toEqual(["Admin mutation client is not configured"]);
  });

  it("turns unsafe environment configuration into a stable command error", async () => {
    const credential = "fixture token";
    const stderr: string[] = [];
    const client = createBinaryAdminClient(
      {
        TENANTSCRIPT_CONTROL_PLANE_URL: "https://control-plane.example?scope=private",
        TENANTSCRIPT_CONTROL_PLANE_TOKEN: credential
      },
      vi.fn<FetchLike>()
    );

    await expect(
      runExtCli(["approvals", "reject", "--approval", "approval_1"], client, captureIo([], stderr))
    ).resolves.toBe(1);
    expect(stderr).toEqual(["Admin mutation client is not configured"]);
    expect(stderr.join("\n")).not.toContain(credential);
  });
});

function adminClient(
  overrides: Partial<AdminMutationClient>
): RollbackClient & AdminMutationClient {
  return {
    rollbackInstallation: () => {
      throw new Error("legacy rollback must not be used");
    },
    rollbackAdminInstallation: () => Promise.reject(new Error("unexpected rollback")),
    decideAdminApproval: () => Promise.reject(new Error("unexpected approval")),
    ...overrides
  };
}

function rollbackResponse() {
  return {
    installationId: "inst_1",
    pluginKey: "invoice-policy",
    fromVersion: "1.1.0",
    toVersion: "1.0.0",
    revision: 8,
    auditId: "audit_1",
    completedAt: "2026-07-20T12:00:00.000Z"
  };
}

function approvalResponse() {
  return {
    approvalId: "approval_1",
    state: "rejected" as const,
    auditId: "audit_1",
    decidedAt: "2026-07-20T12:00:00.000Z"
  };
}

function response(status: number, body: unknown) {
  const serialized = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(serialized)
  };
}

function captureIo(stdout: string[], stderr: string[]): CliIo {
  return {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  };
}

const allowAdminMutations = {
  reserve: () => Promise.resolve({ allowed: true as const, remaining: 999 })
};
