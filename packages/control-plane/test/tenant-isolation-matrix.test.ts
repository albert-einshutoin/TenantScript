import { describe, expect, it } from "vitest";
import {
  ADMIN_HTTP_ENDPOINT_CONTRACTS,
  AdminApprovalDecisionError,
  createControlPlaneHttpHandler,
  createStaticTokenIdentityResolver,
  matchAdminHttpEndpoint,
  type AdminHttpEndpointContract,
  type AdminHttpEndpointId
} from "../src/index.js";
import type { ControlPlaneHttpHandlerOptions } from "../src/http-api.js";

const expectedEndpointIds = [
  "session",
  "dashboard",
  "dashboardOperations",
  "dashboardInstallations",
  "dashboardPluginVersions",
  "dashboardApprovals",
  "dashboardExecutions",
  "dashboardAuditEvents",
  "installationReview",
  "installationCommand",
  "installPreview",
  "installCreate",
  "installRequestCreate",
  "rollbackCreate",
  "executionDetail",
  "usage",
  "approvalDecisionCreate",
  "serviceTokenCollection"
] as const satisfies readonly AdminHttpEndpointId[];

describe("Admin HTTP tenant-isolation matrix registration", () => {
  it("keeps every routed endpoint in one exhaustive security contract", () => {
    expect(ADMIN_HTTP_ENDPOINT_CONTRACTS.map(({ id }) => id)).toEqual(expectedEndpointIds);
    expect(new Set(ADMIN_HTTP_ENDPOINT_CONTRACTS.map(({ path }) => path)).size).toBe(
      ADMIN_HTTP_ENDPOINT_CONTRACTS.length
    );
    expect(
      ADMIN_HTTP_ENDPOINT_CONTRACTS.every(({ isolation }) => (isolation as string) !== "unscoped")
    ).toBe(true);
  });

  it.each(ADMIN_HTTP_ENDPOINT_CONTRACTS)(
    "routes $id through its declared scope contract",
    (contract) => {
      const query = contract.id === "installationReview" ? "?id=installation_1" : "";
      const match = matchAdminHttpEndpoint(
        new URL(`https://api.example.com${contract.path}${query}`)
      );

      expect(match).not.toBeNull();
      expect(match?.contract).toBe(contract);
    }
  );

  it.each(ADMIN_HTTP_ENDPOINT_CONTRACTS)(
    "enforces the registered methods for $id",
    async (contract) => {
      const unsupportedMethod = contract.methods.some((method) => method === "GET") ? "PUT" : "GET";
      const query = contract.id === "installationReview" ? "?id=installation_1" : "";
      const handler = createControlPlaneHttpHandler({});

      const response = await handler(
        new Request(`https://api.example.com${contract.path}${query}`, {
          method: unsupportedMethod
        })
      );

      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe([...contract.methods, "OPTIONS"].join(", "));
    }
  );

  it("rejects an unregistered endpoint instead of silently assigning a scope", () => {
    expect(
      matchAdminHttpEndpoint(new URL("https://api.example.com/v1/admin/future-endpoint"))
    ).toBeNull();
  });

  it.each(
    ADMIN_HTTP_ENDPOINT_CONTRACTS.flatMap((contract) =>
      contract.methods.map((method) => ({ contract, method }))
    )
  )(
    "derives $method $contract.id scope only from authenticated identity",
    async ({ contract, method }) => {
      const calls: object[] = [];
      const handler = createControlPlaneHttpHandler({
        identityResolver: createStaticTokenIdentityResolver({
          scoped: {
            subject: "owner_scope",
            role: "owner",
            appId: "app_scope",
            tenantId: "tenant_scope"
          }
        }),
        ...scopeProbeOptions(contract, calls)
      });

      const response = await handler(scopeProbeRequest(contract, method));

      if (contract.id === "session") {
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          appId: "app_scope",
          tenantId: "tenant_scope"
        });
        return;
      }
      expect(response.status).toBe(500);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const record = call as Record<string, unknown>;
        if (Object.hasOwn(record, "appId")) expect(record.appId).toBe("app_scope");
        if (Object.hasOwn(record, "tenantId")) expect(record.tenantId).toBe("tenant_scope");
      }
      await expect(response.json()).resolves.toEqual({
        error: { code: "internal_error", message: "internal control-plane error" }
      });
    }
  );

  it.each(
    ADMIN_HTTP_ENDPOINT_CONTRACTS.filter(
      (contract) =>
        contract.isolation === "tenant-resource" || contract.isolation === "tenant-mutation"
    ).map((contract) => ({
      contract,
      method: contract.id === "serviceTokenCollection" ? "DELETE" : contract.methods[0]
    }))
  )("conceals a cross-scope target on $method $contract.id", async ({ contract, method }) => {
    const handler = createControlPlaneHttpHandler({
      identityResolver: createStaticTokenIdentityResolver({
        scoped: {
          subject: "owner_scope",
          role: "owner",
          appId: "app_scope",
          tenantId: "tenant_scope"
        }
      }),
      ...crossScopeMissOptions(contract)
    });

    const response = await handler(scopeProbeRequest(contract, method));

    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain("scope probe");
  });
});

function scopeProbeOptions(
  contract: AdminHttpEndpointContract,
  calls: object[]
): Omit<ControlPlaneHttpHandlerOptions, "identityResolver"> {
  const fail = (request: object): Promise<never> => {
    calls.push(request);
    return Promise.reject(new Error("scope probe must stay private"));
  };
  const rateLimiter = {
    reserve: () => Promise.resolve({ allowed: true as const, remaining: 999 })
  };
  switch (contract.id) {
    case "session":
      return {};
    case "dashboard":
    case "dashboardOperations":
    case "dashboardInstallations":
    case "dashboardPluginVersions":
    case "dashboardApprovals":
    case "dashboardExecutions":
    case "dashboardAuditEvents":
      return {
        dashboardStore: {
          readSection: (request) => fail(request),
          readUsageSummary: (request) => fail(request),
          readOperationalHealth: (request) => fail(request)
        },
        cursorCodec: {
          encode: () => Promise.reject(new Error("unexpected cursor encode")),
          decode: () => Promise.reject(new Error("unexpected cursor decode"))
        }
      };
    case "installationReview":
      return { installationDetailStore: { readInstallation: (request) => fail(request) } };
    case "installationCommand":
      return {
        installationCommandStore: { updateInstallation: (request) => fail(request) },
        adminMutationRateLimiter: rateLimiter
      };
    case "installPreview":
    case "installCreate":
      return {
        installFlowStore: {
          readVersion: (request) => fail(request),
          install: (request) => fail(request)
        },
        adminMutationRateLimiter: rateLimiter
      };
    case "installRequestCreate":
      return {
        installRequestStore: { requestInstallation: (request) => fail(request) },
        adminMutationRateLimiter: rateLimiter
      };
    case "rollbackCreate":
      return {
        rollbackStore: { rollback: (request) => fail(request) },
        adminMutationRateLimiter: rateLimiter
      };
    case "executionDetail":
      return { executionDetailStore: { readExecution: (request) => fail(request) } };
    case "usage":
      return {
        usageMeter: {
          recordExecutionUsage: (request) => fail(request),
          getDailyUsageSummary: (request) => fail(request),
          getDailyUsageSummaries: (request) => fail(request)
        }
      };
    case "approvalDecisionCreate":
      return {
        approvalDecisionStore: { decide: (request) => fail(request) },
        adminMutationRateLimiter: rateLimiter
      };
    case "serviceTokenCollection":
      return {
        serviceTokenManager: {
          issue: (request) => fail(request),
          revoke: (request) => fail(request)
        },
        adminMutationRateLimiter: rateLimiter
      };
  }
}

function scopeProbeRequest(contract: AdminHttpEndpointContract, method: string): Request {
  const url = new URL(`https://api.example.com${contract.path}`);
  const headers = new Headers({ Authorization: "Bearer scoped" });
  let body: string | undefined;
  if (contract.id === "installationReview") url.searchParams.set("id", "tenant_forged_resource");
  if (contract.id === "installPreview") url.searchParams.set("versionId", "app_forged_version");
  if (contract.id === "executionDetail") url.searchParams.set("id", "tenant_forged_execution");
  if (contract.id === "usage") {
    url.searchParams.set("fromDate", "2026-07-01");
    url.searchParams.set("toDate", "2026-07-02");
  }
  if (contract.id === "serviceTokenCollection" && method === "DELETE") {
    url.searchParams.set("id", "tenant_forged_token");
  }
  if (method !== "GET" && method !== "DELETE") {
    headers.set("Content-Type", "application/json");
    if (contract.id !== "serviceTokenCollection") {
      headers.set("Idempotency-Key", "scope-matrix-key-0001");
    }
    body = JSON.stringify(scopeProbeBody(contract.id));
  }
  return new Request(url, { method, headers, ...(body === undefined ? {} : { body }) });
}

function crossScopeMissOptions(
  contract: AdminHttpEndpointContract
): Omit<ControlPlaneHttpHandlerOptions, "identityResolver"> {
  const rateLimiter = {
    reserve: () => Promise.resolve({ allowed: true as const, remaining: 999 })
  };
  switch (contract.id) {
    case "installationReview":
      return { installationDetailStore: { readInstallation: () => Promise.resolve(null) } };
    case "installationCommand":
      return {
        installationCommandStore: { updateInstallation: () => Promise.resolve(null) },
        adminMutationRateLimiter: rateLimiter
      };
    case "installPreview":
      return {
        installFlowStore: {
          readVersion: () => Promise.resolve(null),
          install: () => Promise.resolve(null)
        }
      };
    case "installCreate":
      return {
        installFlowStore: {
          readVersion: () => Promise.resolve(null),
          install: () => Promise.resolve(null)
        },
        adminMutationRateLimiter: rateLimiter
      };
    case "installRequestCreate":
      return {
        installRequestStore: { requestInstallation: () => Promise.resolve(null) },
        adminMutationRateLimiter: rateLimiter
      };
    case "rollbackCreate":
      return {
        rollbackStore: { rollback: () => Promise.resolve(null) },
        adminMutationRateLimiter: rateLimiter
      };
    case "executionDetail":
      return { executionDetailStore: { readExecution: () => Promise.resolve(null) } };
    case "approvalDecisionCreate":
      return {
        approvalDecisionStore: {
          decide: () => Promise.reject(new AdminApprovalDecisionError(404, "approval_not_found"))
        },
        adminMutationRateLimiter: rateLimiter
      };
    case "serviceTokenCollection":
      return {
        serviceTokenManager: {
          issue: () => Promise.reject(new Error("unexpected issue")),
          revoke: () => Promise.resolve(false)
        },
        adminMutationRateLimiter: rateLimiter
      };
    default:
      throw new Error(`endpoint ${contract.id} is not a cross-scope resource`);
  }
}

function scopeProbeBody(id: AdminHttpEndpointId): Record<string, unknown> {
  switch (id) {
    case "installationCommand":
      return { id: "tenant_forged_installation", expectedRevision: 0, enabled: false };
    case "installCreate":
    case "installRequestCreate":
      return {
        versionId: "app_forged_version",
        config: {},
        confirmedCapabilities: [],
        enabled: false,
        priority: 10
      };
    case "rollbackCreate":
      return {
        installationId: "tenant_forged_installation",
        targetVersionId: "app_forged_version",
        expectedRevision: 0
      };
    case "approvalDecisionCreate":
      return { approvalId: "tenant_forged_approval", decision: "rejected" };
    case "serviceTokenCollection":
      return {
        label: "scope probe",
        role: "viewer",
        scopes: ["session:read"],
        expiresAt: "2026-07-21T00:00:00.000Z"
      };
    default:
      return {};
  }
}
