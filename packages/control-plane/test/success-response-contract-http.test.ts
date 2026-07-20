import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

/* Test doubles intentionally implement async ports with immediately resolved values. */
/* eslint-disable @typescript-eslint/require-await */
import type { AdminDashboardStore } from "../src/admin-dashboard.js";
import {
  ADMIN_HTTP_ENDPOINT_CONTRACTS,
  CONTROL_PLANE_SUCCESS_RESPONSE_SCHEMAS,
  createControlPlaneHttpHandler,
  type AdminHttpEndpointContract,
  type AdminHttpMethod,
  type ControlPlaneHttpHandlerOptions
} from "../src/http-api.js";
import { createStaticTokenIdentityResolver } from "../src/index.js";

const authorization = "Bearer manager-token";
const jsonHeaders = {
  Authorization: authorization,
  "Content-Type": "application/json"
};

describe("Control Plane HTTP success response contracts", () => {
  it("validates a real successful handler response for every public method", async () => {
    const handler = createControlPlaneHttpHandler(successOptions());
    const requests = successRequests();
    const validated = new Set<string>();
    const ajv = new Ajv({ allErrors: true, strict: true });

    for (const request of requests) {
      const url = new URL(request.url);
      const contract = ADMIN_HTTP_ENDPOINT_CONTRACTS.find(({ path }) => path === url.pathname);
      expect(contract, `${request.method} ${url.pathname}`).toBeDefined();
      if (contract === undefined) throw new Error("missing endpoint contract");
      const publicContract: AdminHttpEndpointContract = contract;
      const method = request.method as AdminHttpMethod;
      const success = publicContract.success[method];
      expect(success, `${method} ${url.pathname}`).toBeDefined();
      if (success === undefined) throw new Error("missing success response contract");

      const response = await handler(request);
      expect(response.status, `${method} ${url.pathname}`).toBe(success.status);
      if (success.body === "none") {
        expect(await response.text()).toBe("");
      } else {
        expect(response.headers.get("content-type")).toContain("application/json");
        const body: unknown = await response.json();
        const validate = ajv.compile(CONTROL_PLANE_SUCCESS_RESPONSE_SCHEMAS[success.schema]);
        expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
      }
      validated.add(`${method} ${url.pathname}`);
    }

    const published = ADMIN_HTTP_ENDPOINT_CONTRACTS.flatMap((contract) =>
      contract.methods.map((method) => `${method} ${contract.path}`)
    );
    expect([...validated].sort()).toEqual(published.sort());
  });
});

function successRequests(): Request[] {
  const get = (path: string) =>
    new Request(`https://api.example.com${path}`, { headers: { Authorization: authorization } });
  const command = (path: string, method: string, body?: Record<string, unknown>) =>
    new Request(`https://api.example.com${path}`, {
      method,
      headers: jsonHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

  return [
    get("/v1/session"),
    get("/v1/admin/dashboard"),
    get("/v1/admin/dashboard/operations"),
    get("/v1/admin/dashboard/installations"),
    get("/v1/admin/dashboard/pluginVersions"),
    get("/v1/admin/dashboard/approvals"),
    get("/v1/admin/dashboard/executions"),
    get("/v1/admin/dashboard/auditEvents"),
    get("/v1/admin/provider-connections"),
    get("/v1/admin/installation-review?id=inst_1"),
    command("/v1/admin/installation-command", "PATCH", {
      id: "inst_1",
      expectedRevision: 0,
      enabled: true
    }),
    get("/v1/admin/install-preview?versionId=version_1"),
    requestWithIdempotency("/v1/admin/installations"),
    requestWithIdempotency("/v1/admin/installation-requests"),
    commandWithIdempotency("/v1/admin/rollbacks", {
      installationId: "inst_1",
      targetVersionId: "version_0",
      expectedRevision: 0
    }),
    get("/v1/admin/execution-detail?id=execution_1"),
    get("/v1/admin/usage?fromDate=2026-07-01&toDate=2026-07-20"),
    command("/v1/admin/approval-decisions", "POST", {
      approvalId: "approval_1",
      decision: "approved"
    }),
    command("/v1/admin/service-tokens", "POST", {
      label: "CI deployer",
      role: "operator",
      scopes: ["installation:read"],
      expiresAt: "2026-08-01T00:00:00.000Z"
    }),
    new Request("https://api.example.com/v1/admin/service-tokens?id=token_1", {
      method: "DELETE",
      headers: { Authorization: authorization }
    })
  ];
}

function requestWithIdempotency(path: string): Request {
  return commandWithIdempotency(path, {
    versionId: "version_1",
    config: {},
    confirmedCapabilities: [],
    enabled: true,
    priority: 10
  });
}

function commandWithIdempotency(path: string, body: Record<string, unknown>): Request {
  return new Request(`https://api.example.com${path}`, {
    method: "POST",
    headers: { ...jsonHeaders, "Idempotency-Key": "idempotency-key-0001" },
    body: JSON.stringify(body)
  });
}

function successOptions(): ControlPlaneHttpHandlerOptions {
  const dashboardStore: AdminDashboardStore = {
    readSection: async ({ section }) => {
      switch (section) {
        case "installations":
          return {
            section,
            items: [
              {
                id: "inst_1",
                pluginKey: "example",
                version: "1.0.0",
                enabled: true,
                priority: 10,
                revision: 0
              }
            ]
          };
        case "pluginVersions":
          return {
            section,
            items: [
              {
                id: "version_1",
                pluginId: "plugin_1",
                pluginKey: "example",
                version: "1.0.0",
                artifactHash: "sha256:abc",
                createdAt: "2026-07-20T00:00:00.000Z"
              }
            ]
          };
        case "approvals":
          return {
            section,
            items: [
              {
                id: "approval_1",
                pluginId: "plugin_1",
                role: "admin",
                resumeHook: "installation.request",
                state: "pending",
                expiresAt: "2026-07-21T00:00:00.000Z",
                createdAt: "2026-07-20T00:00:00.000Z"
              }
            ]
          };
        case "executions":
          return {
            section,
            items: [
              {
                id: "execution_1",
                pluginId: "plugin_1",
                hookName: "invoice.created",
                version: "1.0.0",
                status: "success",
                durationMs: 12,
                capabilityNames: ["storage.read"],
                createdAt: "2026-07-20T00:00:00.000Z"
              }
            ]
          };
        case "auditEvents":
          return {
            section,
            items: [
              {
                id: "audit_1",
                installationId: "inst_1",
                pluginId: "plugin_1",
                revision: 1,
                actor: "operator_1",
                action: "installation.command",
                before: { enabled: true, revision: 0 },
                after: { enabled: false, revision: 1 },
                createdAt: "2026-07-20T00:00:00.000Z"
              }
            ]
          };
      }
    },
    readUsageSummary: async () => ({ date: "2026-07-20", executions: 1, runtimeMs: 12 }),
    readOperationalHealth: async () => ({
      date: "2026-07-20",
      totalExecutions: 1,
      failedExecutions: 0,
      failureRateBps: 0,
      timeoutExecutions: 0,
      egressDeniedExecutions: 0,
      budgetExceededExecutions: 0
    }),
    readSchemaMigrations: async () => [
      {
        hookName: "invoice.created",
        versions: [
          {
            version: "1.0.0",
            installationCount: 0,
            removable: true,
            blockingInstallations: []
          }
        ],
        incompatibleInstallations: []
      }
    ]
  };

  return {
    identityResolver: createStaticTokenIdentityResolver({
      "manager-token": {
        subject: "operator_1",
        role: "manager",
        appId: "app_1",
        tenantId: "tenant_1"
      }
    }),
    dashboardStore,
    providerConnectionStore: {
      readConnections: async () => [
        {
          provider: "slack",
          id: "connection_1",
          workspaceId: "workspace_1",
          workspaceName: "Operations",
          botUserId: "bot_1",
          connectedAt: "2026-07-20T00:00:00.000Z"
        }
      ]
    },
    cursorCodec: {
      encode: async () => "cursor_1",
      decode: async () => ({
        appId: "app_1",
        tenantId: "tenant_1",
        section: "installations",
        position: "position_1"
      })
    },
    installationDetailStore: { readInstallation: async () => installationDetail() },
    installationCommandStore: {
      updateInstallation: async () => ({
        outcome: "updated",
        id: "inst_1",
        enabled: true,
        priority: 10,
        revision: 1,
        changed: true
      })
    },
    installFlowStore: {
      readVersion: async () => installPreview(),
      install: async () => installResult()
    },
    installRequestStore: {
      requestInstallation: async () => ({
        approvalId: "approval_1",
        state: "pending",
        pluginKey: "example",
        version: "1.0.0",
        capabilities: [],
        expiresAt: "2026-07-21T00:00:00.000Z"
      })
    },
    rollbackStore: {
      rollback: async () => ({
        outcome: "rolled_back",
        installationId: "inst_1",
        pluginKey: "example",
        fromVersion: "1.0.0",
        toVersion: "0.9.0",
        revision: 1,
        auditId: "audit_1",
        completedAt: "2026-07-20T00:00:00.000Z"
      })
    },
    executionDetailStore: {
      readExecution: async () => ({
        id: "execution_1",
        pluginId: "plugin_1",
        hookName: "invoice.created",
        version: "1.0.0",
        status: "success",
        durationMs: 12,
        capabilityCalls: [{ name: "storage.read", status: "success" }],
        createdAt: "2026-07-20T00:00:00.000Z"
      })
    },
    usageMeter: {
      recordExecutionUsage: async () => usageItem(),
      getDailyUsageSummary: async () => usageItem(),
      getDailyUsageSummaries: async () => [usageItem()]
    },
    approvalDecisionStore: {
      decide: async () => ({
        approvalId: "approval_1",
        state: "approved",
        auditId: "audit_approval_1",
        decidedAt: "2026-07-20T00:00:00.000Z",
        installation: installResult()
      })
    },
    serviceTokenManager: {
      issue: async () => ({
        id: "token_1",
        token: "ts_service_redacted-fixture",
        label: "CI deployer",
        role: "operator",
        scopes: ["installation:read"],
        createdAt: "2026-07-20T00:00:00.000Z",
        expiresAt: "2026-08-01T00:00:00.000Z"
      }),
      revoke: async () => true
    },
    adminMutationRateLimiter: { reserve: async () => ({ allowed: true, remaining: 99 }) },
    telemetryStatus: { enabled: false, mode: "disabled", schemaVersion: 1 },
    now: () => new Date("2026-07-20T00:00:00.000Z")
  };
}

function installationDetail() {
  return {
    id: "inst_1",
    pluginKey: "example",
    version: "1.0.0",
    enabled: true,
    priority: 10,
    revision: 0,
    configFields: [
      {
        name: "channel",
        type: "string" as const,
        required: true,
        configured: true,
        hasDefault: false
      }
    ],
    capabilities: [
      {
        name: "storage.read",
        status: "granted" as const,
        scopeKeys: ["tenantId"],
        configReferences: []
      }
    ],
    egress: { mode: "deny" as const, allowlistedHostCount: 0 }
  };
}

function installPreview() {
  return {
    versionId: "version_1",
    pluginKey: "example",
    version: "1.0.0",
    configFields: [{ name: "channel", type: "string" as const, required: true, hasDefault: false }],
    capabilities: [{ name: "storage.read", scopeKeys: ["tenantId"], configReferences: [] }],
    egress: { mode: "deny" as const, allowlistedHostCount: 0 }
  };
}

function installResult() {
  return {
    id: "inst_1",
    versionId: "version_1",
    pluginKey: "example",
    version: "1.0.0",
    enabled: true,
    priority: 10,
    revision: 0 as const
  };
}

function usageItem() {
  return {
    tenantId: "tenant_1",
    pluginId: "plugin_1",
    date: "2026-07-20",
    executions: 1,
    cpuMs: 12,
    subrequests: 1,
    workflowRuns: 0
  };
}
