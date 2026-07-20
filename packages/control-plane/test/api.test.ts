import { describe, expect, it } from "vitest";
import {
  ControlPlaneApiError,
  createInMemorySlackConnectionStore,
  createControlPlaneApi,
  createInMemoryUsageMeter,
  createInMemorySecretStore,
  toControlPlaneErrorResponse,
  type ApprovalContinuationRequest,
  type ApprovalRecord,
  type ArtifactStore,
  type ContinuationRunner,
  type AppRecord,
  type ControlPlaneStore,
  type ExecutionRecord,
  type InstallationRecord,
  type PluginRecord,
  type TenantRecord,
  type PluginVersionRecord
} from "../src/index.js";
import type { TenantScriptManifest } from "@tenantscript/manifest";

const manifest = {
  name: "large-invoice-notify",
  version: "1.0.0",
  hooks: [{ name: "invoice.created", type: "event", timeoutMs: 250, schemaVersionRange: "^1.0.0" }],
  capabilities: { "slack.send": { channel: "C123" } },
  configSchema: { properties: {}, required: [] },
  egress: { mode: "deny" },
  limits: { cpuMs: 50, timeoutMs: 500 }
} satisfies TenantScriptManifest;

const configurableManifest = {
  ...manifest,
  capabilities: { "slack.send": { channel: "$config.notifyChannel" } },
  configSchema: {
    properties: {
      notifyChannel: { type: "string" },
      minAmount: { type: "number", default: 100000 }
    },
    required: ["notifyChannel"]
  }
} satisfies TenantScriptManifest;

const arrayGrantManifest = {
  ...manifest,
  capabilities: { "invoice.read": { fields: ["id", "amountCents"] } }
} satisfies TenantScriptManifest;

const invalidGrantReferenceManifest = {
  ...manifest,
  capabilities: { "slack.send": { channel: "$config.missingChannel" } }
} satisfies TenantScriptManifest;

describe("createControlPlaneApi plugin/version registration", () => {
  it("registers a plugin version and lists versions for the plugin", async () => {
    const store = new InMemoryControlPlaneStore();
    const artifacts = new InMemoryArtifactStore();
    const api = createControlPlaneApi({ store, artifacts });

    await api.createApp({ id: "app_1", name: "Example SaaS" });
    const plugin = await api.registerPlugin({ appId: "app_1", key: "large-invoice-notify" });
    const version = await api.registerPluginVersion({
      appId: "app_1",
      pluginKey: "large-invoice-notify",
      version: "1.0.0",
      manifest,
      artifactHash: "hash_1",
      artifact: "bundle-code"
    });

    await expect(
      api.listPluginVersions({ appId: "app_1", pluginKey: "large-invoice-notify" })
    ).resolves.toEqual([version]);
    expect(plugin).toMatchObject({ appId: "app_1", key: "large-invoice-notify" });
    expect(artifacts.get("hash_1")).toBe("bundle-code");
  });

  it("returns the existing plugin when registering the same key twice", async () => {
    const api = createControlPlaneApi({
      store: new InMemoryControlPlaneStore(),
      artifacts: new InMemoryArtifactStore()
    });
    await api.createApp({ id: "app_1", name: "Example SaaS" });

    const first = await api.registerPlugin({ appId: "app_1", key: "large-invoice-notify" });
    const second = await api.registerPlugin({ appId: "app_1", key: "large-invoice-notify" });

    expect(second).toBe(first);
  });

  it("rejects duplicate plugin version registration as immutable", async () => {
    const api = createControlPlaneApi({
      store: new InMemoryControlPlaneStore(),
      artifacts: new InMemoryArtifactStore()
    });
    await api.createApp({ id: "app_1", name: "Example SaaS" });
    await api.registerPlugin({ appId: "app_1", key: "large-invoice-notify" });
    await api.registerPluginVersion({
      appId: "app_1",
      pluginKey: "large-invoice-notify",
      version: "1.0.0",
      manifest,
      artifactHash: "hash_1",
      artifact: "bundle-code"
    });

    await expect(
      api.registerPluginVersion({
        appId: "app_1",
        pluginKey: "large-invoice-notify",
        version: "1.0.0",
        manifest,
        artifactHash: "hash_2",
        artifact: "replacement-code"
      })
    ).rejects.toMatchObject({
      status: 409,
      code: "plugin_version_already_exists"
    } satisfies Partial<ControlPlaneApiError>);
  });

  it("rejects invalid manifests before storing artifacts", async () => {
    const artifacts = new InMemoryArtifactStore();
    const api = createControlPlaneApi({
      store: new InMemoryControlPlaneStore(),
      artifacts
    });
    await api.createApp({ id: "app_1", name: "Example SaaS" });
    await api.registerPlugin({ appId: "app_1", key: "large-invoice-notify" });

    await expect(
      api.registerPluginVersion({
        appId: "app_1",
        pluginKey: "large-invoice-notify",
        version: "1.0.0",
        manifest: { ...manifest, version: "2.0.0" },
        artifactHash: "hash_1",
        artifact: "bundle-code"
      })
    ).rejects.toMatchObject({
      status: 400,
      code: "version_mismatch"
    } satisfies Partial<ControlPlaneApiError>);
    expect(artifacts.get("hash_1")).toBeUndefined();
  });

  it("rejects malformed manifests and missing plugins with API errors", async () => {
    const api = createControlPlaneApi({
      store: new InMemoryControlPlaneStore(),
      artifacts: new InMemoryArtifactStore()
    });
    await api.createApp({ id: "app_1", name: "Example SaaS" });

    await expect(
      api.registerPluginVersion({
        appId: "app_1",
        pluginKey: "missing-plugin",
        version: "1.0.0",
        manifest,
        artifactHash: "hash_1",
        artifact: "bundle-code"
      })
    ).rejects.toMatchObject({
      status: 404,
      code: "plugin_not_found"
    } satisfies Partial<ControlPlaneApiError>);

    await api.registerPlugin({ appId: "app_1", key: "large-invoice-notify" });
    await expect(
      api.registerPluginVersion({
        appId: "app_1",
        pluginKey: "large-invoice-notify",
        version: "1.0.0",
        manifest: { ...manifest, hooks: [] },
        artifactHash: "hash_1",
        artifact: "bundle-code"
      })
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_manifest"
    } satisfies Partial<ControlPlaneApiError>);
  });

  it("rejects plugin registration for missing apps", async () => {
    const api = createControlPlaneApi({
      store: new InMemoryControlPlaneStore(),
      artifacts: new InMemoryArtifactStore()
    });

    await expect(
      api.registerPlugin({ appId: "missing_app", key: "large-invoice-notify" })
    ).rejects.toMatchObject({
      status: 404,
      code: "app_not_found"
    } satisfies Partial<ControlPlaneApiError>);
  });
});

describe("control-plane API error envelope", () => {
  it("formats API errors into a stable envelope", async () => {
    const api = createControlPlaneApi({
      store: new InMemoryControlPlaneStore(),
      artifacts: new InMemoryArtifactStore()
    });

    const error = await captureError(
      api.registerPlugin({ appId: "missing_app", key: "large-invoice-notify" })
    );

    expect(toControlPlaneErrorResponse(error)).toEqual({
      status: 404,
      body: {
        error: {
          code: "app_not_found",
          message: "app missing_app was not found"
        }
      }
    });
  });

  it("formats unknown errors without leaking implementation details", () => {
    expect(toControlPlaneErrorResponse(new Error("database token leaked"))).toEqual({
      status: 500,
      body: {
        error: {
          code: "internal_error",
          message: "internal control-plane error"
        }
      }
    });
  });
});

describe("createControlPlaneApi app and tenant management", () => {
  it("creates apps and tenants under an app", async () => {
    const api = createControlPlaneApi({
      store: new InMemoryControlPlaneStore(),
      artifacts: new InMemoryArtifactStore()
    });

    await expect(api.createApp({ id: "app_1", name: "Example SaaS" })).resolves.toEqual({
      id: "app_1",
      name: "Example SaaS"
    });
    await expect(
      api.createTenant({ id: "tenant_1", appId: "app_1", name: "Acme" })
    ).resolves.toEqual({
      id: "tenant_1",
      appId: "app_1",
      name: "Acme"
    });
  });

  it("rejects tenant creation for missing apps", async () => {
    const api = createControlPlaneApi({
      store: new InMemoryControlPlaneStore(),
      artifacts: new InMemoryArtifactStore()
    });

    await expect(
      api.createTenant({ id: "tenant_1", appId: "missing_app", name: "Acme" })
    ).rejects.toMatchObject({
      status: 404,
      code: "app_not_found"
    } satisfies Partial<ControlPlaneApiError>);
  });
});

describe("createControlPlaneApi usage meter", () => {
  it("records execution usage and returns tenant/plugin daily summaries", async () => {
    const usageMeter = createInMemoryUsageMeter();
    const api = createControlPlaneApi({
      store: new InMemoryControlPlaneStore(),
      artifacts: new InMemoryArtifactStore(),
      usageMeter
    });

    await expect(
      api.recordExecutionUsage({
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        hookType: "event",
        status: "success",
        cpuMs: 15,
        subrequests: 3,
        workflowRuns: 1,
        at: new Date("2026-06-14T12:00:00.000Z")
      })
    ).resolves.toMatchObject({
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      date: "2026-06-14",
      executions: 1,
      cpuMs: 15,
      subrequests: 3,
      workflowRuns: 1
    });
    await expect(
      api.getDailyUsageSummary({
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        date: "2026-06-14"
      })
    ).resolves.toMatchObject({ executions: 1, cpuMs: 15, subrequests: 3, workflowRuns: 1 });
    await expect(
      api.getDailyUsageSummaries({
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        fromDate: "2026-06-14",
        toDate: "2026-06-14"
      })
    ).resolves.toEqual([
      expect.objectContaining({ executions: 1, cpuMs: 15, pluginId: "plugin_1" })
    ]);
  });
});

describe("createControlPlaneApi Slack OAuth connection", () => {
  it("stores OAuth tokens only in the secret store and keeps public surfaces token-free", async () => {
    const rawToken = "xoxb-secret-oauth-token";
    const store = new InMemoryControlPlaneStore();
    const secretStore = createInMemorySecretStore();
    const slackConnections = createInMemorySlackConnectionStore();
    const api = createControlPlaneApi({
      store,
      artifacts: new InMemoryArtifactStore(),
      secretStore,
      slackConnections,
      slackOAuth: {
        exchangeCode: (request) => {
          expect(request).toEqual({
            code: "oauth_code_1",
            redirectUri: "https://app.example.com/oauth/slack/callback"
          });
          return Promise.resolve({
            accessToken: rawToken,
            workspaceId: "T123",
            workspaceName: "Acme Workspace",
            botUserId: "B123"
          });
        }
      }
    });
    store.seedApp({ id: "app_1", name: "Example SaaS" });
    store.seedTenant({ id: "tenant_1", appId: "app_1", name: "Acme" });

    const connection = await api.connectSlackWorkspace({
      appId: "app_1",
      tenantId: "tenant_1",
      code: "oauth_code_1",
      redirectUri: "https://app.example.com/oauth/slack/callback",
      connectedAt: new Date("2026-06-13T01:00:00.000Z")
    });

    expect(connection).toEqual({
      id: "slack:tenant_1:T123",
      tenantId: "tenant_1",
      workspaceId: "T123",
      workspaceName: "Acme Workspace",
      botUserId: "B123",
      secretRef: {
        provider: "slack",
        tenantId: "tenant_1",
        secretId: "slack:T123"
      },
      connectedAt: new Date("2026-06-13T01:00:00.000Z")
    });
    await expect(secretStore.getSecret(connection.secretRef)).resolves.toBe(rawToken);

    const publicSurfaces = JSON.stringify({
      connection,
      controlPlaneStore: store.dumpSerializableRecords(),
      slackConnections: slackConnections.listConnections(),
      executions: store.executions
    });
    expect(publicSurfaces).not.toContain(rawToken);
  });
});

describe("createControlPlaneApi installation CRUD", () => {
  it("installs a plugin after validating config, grants, and priority", async () => {
    const api = createApiWithVersion(configurableManifest);

    await expect(
      api.installPlugin({
        id: "inst_1",
        appId: "app_1",
        tenantId: "tenant_1",
        pluginKey: "large-invoice-notify",
        version: "1.0.0",
        config: { notifyChannel: "C123" },
        grants: { "slack.send": { channel: "C123" } },
        priority: 20
      })
    ).resolves.toEqual(
      expect.objectContaining({
        id: "inst_1",
        tenantId: "tenant_1",
        pluginVersionId: "version_1",
        enabled: true,
        priority: 20,
        config: { notifyChannel: "C123", minAmount: 100000 },
        grants: { "slack.send": { channel: "C123" } }
      })
    );
  });

  it("accepts manifest grants that contain arrays", async () => {
    const api = createApiWithVersion(arrayGrantManifest);

    await expect(
      api.installPlugin({
        id: "inst_1",
        appId: "app_1",
        tenantId: "tenant_1",
        pluginKey: "large-invoice-notify",
        version: "1.0.0",
        config: {},
        grants: { "invoice.read": { fields: ["id", "amountCents"] } },
        priority: 20
      })
    ).resolves.toEqual(
      expect.objectContaining({
        grants: { "invoice.read": { fields: ["id", "amountCents"] } }
      })
    );
  });

  it("rejects installation when required config is missing or grants exceed manifest requirements", async () => {
    const api = createApiWithVersion(configurableManifest);

    await expect(
      api.installPlugin({
        id: "inst_1",
        appId: "app_1",
        tenantId: "tenant_1",
        pluginKey: "large-invoice-notify",
        version: "1.0.0",
        config: {},
        grants: { "slack.send": { channel: "C123" } },
        priority: 10
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" });

    await expect(
      api.installPlugin({
        id: "inst_2",
        appId: "app_1",
        tenantId: "tenant_1",
        pluginKey: "large-invoice-notify",
        version: "1.0.0",
        config: { notifyChannel: "C123" },
        grants: { "slack.send": { channel: "C999" } },
        priority: 10
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_grants" });
  });

  it("rejects installs when the plugin version or resolved manifest grants are invalid", async () => {
    const store = new InMemoryControlPlaneStore();
    const api = createControlPlaneApi({ store, artifacts: new InMemoryArtifactStore() });
    store.seedApp({ id: "app_1", name: "Example SaaS" });
    store.seedTenant({ id: "tenant_1", appId: "app_1", name: "Acme" });
    store.seedPlugin({ id: "plugin_1", appId: "app_1", key: "large-invoice-notify" });

    await expect(
      api.installPlugin({
        id: "inst_1",
        appId: "app_1",
        tenantId: "tenant_1",
        pluginKey: "large-invoice-notify",
        version: "1.0.0",
        config: {},
        grants: {},
        priority: 20
      })
    ).rejects.toMatchObject({ status: 404, code: "plugin_version_not_found" });

    const invalidGrantApi = createApiWithVersion(invalidGrantReferenceManifest);
    await expect(
      invalidGrantApi.installPlugin({
        id: "inst_1",
        appId: "app_1",
        tenantId: "tenant_1",
        pluginKey: "large-invoice-notify",
        version: "1.0.0",
        config: {},
        grants: {},
        priority: 20
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_grants" });
  });

  it("rejects installation into a tenant outside the app scope", async () => {
    const store = new InMemoryControlPlaneStore();
    const api = createControlPlaneApi({ store, artifacts: new InMemoryArtifactStore() });
    store.seedApp({ id: "app_1", name: "Example SaaS" });
    store.seedApp({ id: "app_2", name: "Other SaaS" });
    store.seedTenant({ id: "tenant_other", appId: "app_2", name: "Other Tenant" });
    store.seedPlugin({ id: "plugin_1", appId: "app_1", key: "large-invoice-notify" });
    store.seedPluginVersion({
      id: "version_1",
      pluginId: "plugin_1",
      version: "1.0.0",
      artifactHash: "hash_1",
      manifest
    });

    await expect(
      api.installPlugin({
        id: "inst_1",
        appId: "app_1",
        tenantId: "tenant_other",
        pluginKey: "large-invoice-notify",
        version: "1.0.0",
        config: {},
        grants: { "slack.send": { channel: "C123" } },
        priority: 20
      })
    ).rejects.toMatchObject({
      status: 404,
      code: "tenant_not_found"
    } satisfies Partial<ControlPlaneApiError>);
  });

  it("updates installation config, enabled state, and priority", async () => {
    const api = createApiWithVersion(configurableManifest);
    await api.installPlugin({
      id: "inst_1",
      appId: "app_1",
      tenantId: "tenant_1",
      pluginKey: "large-invoice-notify",
      version: "1.0.0",
      config: { notifyChannel: "C123" },
      grants: { "slack.send": { channel: "C123" } },
      priority: 20
    });

    await expect(
      api.updateInstallationConfig({
        id: "inst_1",
        config: { notifyChannel: "C456", minAmount: 200000 }
      })
    ).resolves.toEqual(
      expect.objectContaining({
        config: { notifyChannel: "C456", minAmount: 200000 },
        grants: { "slack.send": { channel: "C456" } }
      })
    );
    await expect(api.setInstallationEnabled({ id: "inst_1", enabled: false })).resolves.toEqual(
      expect.objectContaining({ enabled: false })
    );
    await expect(api.updateInstallationPriority({ id: "inst_1", priority: 5 })).resolves.toEqual(
      expect.objectContaining({ priority: 5 })
    );
  });

  it("rejects installation config updates when the installation or pinned version is missing", async () => {
    const store = new InMemoryControlPlaneStore();
    const api = createControlPlaneApi({ store, artifacts: new InMemoryArtifactStore() });

    await expect(
      api.updateInstallationConfig({ id: "missing_installation", config: {} })
    ).rejects.toMatchObject({ status: 404, code: "installation_not_found" });
    await expect(
      api.setInstallationEnabled({ id: "missing_installation", enabled: false })
    ).rejects.toMatchObject({ status: 404, code: "installation_not_found" });
    await expect(
      api.updateInstallationPriority({ id: "missing_installation", priority: 1 })
    ).rejects.toMatchObject({ status: 404, code: "installation_not_found" });

    store.seedInstallation({
      id: "inst_1",
      tenantId: "tenant_1",
      pluginVersionId: "missing_version",
      enabled: true,
      priority: 10,
      config: {},
      grants: {}
    });
    await expect(api.updateInstallationConfig({ id: "inst_1", config: {} })).rejects.toMatchObject({
      status: 404,
      code: "plugin_version_not_found"
    });
  });

  it("rolls an installation back to an existing plugin version and writes an audit execution", async () => {
    const store = new InMemoryControlPlaneStore();
    const api = createApiWithVersion(configurableManifest, store);
    store.seedPluginVersion({
      id: "version_0",
      pluginId: "plugin_1",
      version: "0.9.0",
      artifactHash: "hash_0",
      manifest: { ...configurableManifest, version: "0.9.0" }
    });
    await api.installPlugin({
      id: "inst_1",
      appId: "app_1",
      tenantId: "tenant_1",
      pluginKey: "large-invoice-notify",
      version: "1.0.0",
      config: { notifyChannel: "C123" },
      grants: { "slack.send": { channel: "C123" } },
      priority: 20
    });

    const rollback = await api.rollbackInstallation({
      auditId: "audit_rollback_1",
      appId: "app_1",
      installationId: "inst_1",
      pluginKey: "large-invoice-notify",
      targetVersion: "0.9.0",
      actor: "ops@example.com",
      reason: "bad production deploy"
    });

    expect(rollback.installation).toMatchObject({
      id: "inst_1",
      pluginVersionId: "version_0"
    });
    expect(rollback.audit).toMatchObject({
      id: "audit_rollback_1",
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      hookName: "installation.rollback",
      version: "0.9.0",
      status: "success",
      error: "rolled back from 1.0.0 by ops@example.com: bad production deploy"
    });
    await expect(
      api.updateInstallationConfig({
        id: "inst_1",
        config: { notifyChannel: "C456" }
      })
    ).resolves.toEqual(
      expect.objectContaining({
        pluginVersionId: "version_0",
        grants: { "slack.send": { channel: "C456" } }
      })
    );
    expect(store.executions).toEqual([
      expect.objectContaining({
        id: "audit_rollback_1",
        hookName: "installation.rollback",
        version: "0.9.0"
      })
    ]);
  });

  it("rejects rollback when the installation or target version is missing", async () => {
    const store = new InMemoryControlPlaneStore();
    const api = createApiWithVersion(configurableManifest, store);
    await api.installPlugin({
      id: "inst_1",
      appId: "app_1",
      tenantId: "tenant_1",
      pluginKey: "large-invoice-notify",
      version: "1.0.0",
      config: { notifyChannel: "C123" },
      grants: { "slack.send": { channel: "C123" } },
      priority: 20
    });

    await expect(
      api.rollbackInstallation({
        auditId: "audit_rollback_missing_installation",
        appId: "app_1",
        installationId: "missing_installation",
        pluginKey: "large-invoice-notify",
        targetVersion: "1.0.0",
        actor: "ops@example.com"
      })
    ).rejects.toMatchObject({ status: 404, code: "installation_not_found" });
    await expect(
      api.rollbackInstallation({
        auditId: "audit_rollback_missing_version",
        appId: "app_1",
        installationId: "inst_1",
        pluginKey: "large-invoice-notify",
        targetVersion: "0.8.0",
        actor: "ops@example.com"
      })
    ).rejects.toMatchObject({ status: 404, code: "plugin_version_not_found" });
  });

  it("decides pending approvals and records an audit execution", async () => {
    const store = new InMemoryControlPlaneStore();
    const api = createApiWithVersion(configurableManifest, store);
    store.seedApproval({
      id: "approval_1",
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      role: "manager",
      subject: { invoiceId: "inv_1" },
      resumeHook: "onInvoiceApprovalDecided",
      state: "pending",
      expiresAt: new Date("2026-06-14T01:00:00.000Z"),
      createdAt: new Date("2026-06-13T01:00:00.000Z")
    });

    await expect(
      api.decideApproval({
        id: "approval_1",
        tenantId: "tenant_1",
        decision: "approved",
        actor: "manager@example.com",
        reason: "invoice is valid",
        auditId: "audit_approval_1",
        decidedAt: new Date("2026-06-13T01:15:00.000Z")
      })
    ).resolves.toEqual(
      expect.objectContaining({
        id: "approval_1",
        state: "approved",
        decidedBy: "manager@example.com",
        decisionReason: "invoice is valid",
        decidedAt: new Date("2026-06-13T01:15:00.000Z")
      })
    );
    expect(store.executions).toEqual([
      expect.objectContaining({
        id: "audit_approval_1",
        hookName: "approval.decision",
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        capabilityCalls: [{ name: "approvals.decide", status: "success" }]
      })
    ]);
  });

  it("rejects missing, cross-tenant, and already decided approvals", async () => {
    const store = new InMemoryControlPlaneStore();
    const api = createApiWithVersion(configurableManifest, store);
    store.seedApproval({
      id: "approval_decided",
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      role: "manager",
      subject: { invoiceId: "inv_1" },
      resumeHook: "onInvoiceApprovalDecided",
      state: "approved",
      expiresAt: new Date("2026-06-14T01:00:00.000Z"),
      createdAt: new Date("2026-06-13T01:00:00.000Z"),
      decidedBy: "manager@example.com",
      decidedAt: new Date("2026-06-13T01:15:00.000Z")
    });

    await expect(
      api.decideApproval({
        id: "missing",
        tenantId: "tenant_1",
        decision: "approved",
        actor: "manager@example.com",
        auditId: "audit_missing"
      })
    ).rejects.toMatchObject({ status: 404, code: "approval_not_found" });
    await expect(
      api.decideApproval({
        id: "approval_decided",
        tenantId: "tenant_2",
        decision: "approved",
        actor: "manager@example.com",
        auditId: "audit_cross_tenant"
      })
    ).rejects.toMatchObject({ status: 404, code: "approval_not_found" });
    await expect(
      api.decideApproval({
        id: "approval_decided",
        tenantId: "tenant_1",
        decision: "rejected",
        actor: "manager@example.com",
        auditId: "audit_double"
      })
    ).rejects.toMatchObject({ status: 409, code: "approval_already_decided" });
  });

  it("runs the resumeHook as a new execution with the decision payload", async () => {
    const store = new InMemoryControlPlaneStore();
    const continuationCalls: ApprovalContinuationRequest[] = [];
    const continuationRunner: ContinuationRunner = {
      runApprovalContinuation: (request) => {
        continuationCalls.push(request);
        return Promise.resolve({
          id: "exec_resume_1",
          tenantId: request.approval.tenantId,
          pluginId: request.approval.pluginId,
          hookName: request.approval.resumeHook,
          version: "1.0.0",
          status: "success",
          durationMs: 7,
          capabilityCalls: [],
          createdAt: request.decidedAt
        });
      }
    };
    const api = createApiWithVersion(configurableManifest, store, continuationRunner);
    await store.createApproval({
      id: "approval_1",
      tenantId: "tenant_1",
      pluginId: "plugin_1",
      role: "manager",
      subject: { invoiceId: "inv_1", amountCents: 150_000 },
      resumeHook: "onInvoiceApprovalDecided",
      state: "pending",
      expiresAt: new Date("2026-06-14T01:00:00.000Z"),
      createdAt: new Date("2026-06-13T01:00:00.000Z")
    });

    await expect(
      api.decideApproval({
        id: "approval_1",
        tenantId: "tenant_1",
        decision: "approved",
        actor: "manager@example.com",
        reason: "valid invoice",
        auditId: "audit_approval_1",
        decidedAt: new Date("2026-06-13T01:15:00.000Z")
      })
    ).resolves.toMatchObject({ state: "approved" });

    expect(continuationCalls).toEqual([
      {
        approval: {
          id: "approval_1",
          tenantId: "tenant_1",
          pluginId: "plugin_1",
          role: "manager",
          resumeHook: "onInvoiceApprovalDecided",
          state: "pending",
          subject: { invoiceId: "inv_1", amountCents: 150_000 },
          expiresAt: new Date("2026-06-14T01:00:00.000Z"),
          createdAt: new Date("2026-06-13T01:00:00.000Z")
        },
        payload: {
          approvalId: "approval_1",
          decision: "approved",
          subject: { invoiceId: "inv_1", amountCents: 150_000 },
          decidedBy: "manager@example.com",
          reason: "valid invoice"
        },
        decidedAt: new Date("2026-06-13T01:15:00.000Z")
      }
    ]);
    expect(store.executions).toEqual([
      expect.objectContaining({ id: "audit_approval_1", hookName: "approval.decision" }),
      expect.objectContaining({ id: "exec_resume_1", hookName: "onInvoiceApprovalDecided" })
    ]);
  });
});

function createApiWithVersion(
  manifestInput: TenantScriptManifest,
  store = new InMemoryControlPlaneStore(),
  continuationRunner?: ContinuationRunner
) {
  const api = createControlPlaneApi({
    store,
    artifacts: new InMemoryArtifactStore(),
    ...(continuationRunner === undefined ? {} : { continuationRunner })
  });
  store.seedApp({ id: "app_1", name: "Example SaaS" });
  store.seedTenant({ id: "tenant_1", appId: "app_1", name: "Acme" });
  store.seedPlugin({ id: "plugin_1", appId: "app_1", key: "large-invoice-notify" });
  store.seedPluginVersion({
    id: "version_1",
    pluginId: "plugin_1",
    version: "1.0.0",
    artifactHash: "hash_1",
    manifest: manifestInput
  });
  return api;
}

async function captureError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

class InMemoryControlPlaneStore implements ControlPlaneStore {
  private readonly apps = new Map<string, AppRecord>();
  private readonly tenants = new Map<string, TenantRecord>();
  private readonly plugins = new Map<string, PluginRecord>();
  private readonly versions = new Map<string, PluginVersionRecord>();
  private readonly installations = new Map<string, InstallationRecord>();
  private readonly approvals = new Map<string, ApprovalRecord>();
  readonly executions: ExecutionRecord[] = [];

  createApp(record: AppRecord) {
    this.seedApp(record);
    return Promise.resolve(record);
  }

  seedApp(record: AppRecord) {
    this.apps.set(record.id, record);
  }

  findAppById(id: string) {
    return Promise.resolve(this.apps.get(id) ?? null);
  }

  createTenant(record: TenantRecord) {
    this.seedTenant(record);
    return Promise.resolve(record);
  }

  seedTenant(record: TenantRecord) {
    this.tenants.set(record.id, record);
  }

  findTenantById(id: string) {
    return Promise.resolve(this.tenants.get(id) ?? null);
  }

  createPlugin(record: PluginRecord) {
    this.seedPlugin(record);
    return Promise.resolve(record);
  }

  seedPlugin(record: PluginRecord) {
    this.plugins.set(record.id, record);
  }

  findPluginByKey(query: { appId: string; key: string }) {
    return Promise.resolve(
      [...this.plugins.values()].find(
        (plugin) => plugin.appId === query.appId && plugin.key === query.key
      ) ?? null
    );
  }

  createPluginVersion(record: PluginVersionRecord) {
    this.seedPluginVersion(record);
    return Promise.resolve(record);
  }

  seedPluginVersion(record: PluginVersionRecord) {
    this.versions.set(record.id, record);
  }

  findPluginVersionById(id: string) {
    return Promise.resolve(this.versions.get(id) ?? null);
  }

  findPluginVersion(query: { pluginId: string; version: string }) {
    return Promise.resolve(
      [...this.versions.values()].find(
        (version) => version.pluginId === query.pluginId && version.version === query.version
      ) ?? null
    );
  }

  listPluginVersions(query: { pluginId: string }) {
    return Promise.resolve(
      [...this.versions.values()].filter((version) => version.pluginId === query.pluginId)
    );
  }

  createInstallation(record: InstallationRecord) {
    this.seedInstallation(record);
    return Promise.resolve(record);
  }

  seedInstallation(record: InstallationRecord) {
    this.installations.set(record.id, record);
  }

  findInstallationById(id: string) {
    return Promise.resolve(this.installations.get(id) ?? null);
  }

  updateInstallationConfig(request: {
    id: string;
    config: Record<string, unknown>;
    grants: Record<string, unknown>;
  }) {
    const installation = this.requireInstallation(request.id);
    const updated = {
      ...installation,
      config: request.config,
      grants: request.grants
    };
    this.installations.set(request.id, updated);
    return Promise.resolve(updated);
  }

  setInstallationEnabled(request: { id: string; enabled: boolean }) {
    const installation = this.requireInstallation(request.id);
    const updated = { ...installation, enabled: request.enabled };
    this.installations.set(request.id, updated);
    return Promise.resolve(updated);
  }

  updateInstallationPriority(request: { id: string; priority: number }) {
    const installation = this.requireInstallation(request.id);
    const updated = { ...installation, priority: request.priority };
    this.installations.set(request.id, updated);
    return Promise.resolve(updated);
  }

  updateInstallationVersion(request: { id: string; pluginVersionId: string }) {
    const installation = this.requireInstallation(request.id);
    const updated = { ...installation, pluginVersionId: request.pluginVersionId };
    this.installations.set(request.id, updated);
    return Promise.resolve(updated);
  }

  writeExecution(record: ExecutionRecord) {
    this.executions.push(record);
    return Promise.resolve(record);
  }

  createApproval(record: ApprovalRecord) {
    this.seedApproval(record);
    return Promise.resolve(record);
  }

  seedApproval(record: ApprovalRecord) {
    this.approvals.set(record.id, record);
  }

  findApprovalById(id: string) {
    return Promise.resolve(this.approvals.get(id) ?? null);
  }

  decideApproval(request: {
    id: string;
    decision: "approved" | "rejected";
    decidedBy: string;
    decisionReason?: string;
    decidedAt: Date;
  }) {
    const approval = this.approvals.get(request.id);
    if (approval === undefined) {
      throw new Error(`approval ${request.id} was not seeded`);
    }
    const updated = { ...approval, state: request.decision, ...request };
    this.approvals.set(request.id, updated);
    return Promise.resolve(updated);
  }

  dumpSerializableRecords() {
    return {
      apps: [...this.apps.values()],
      tenants: [...this.tenants.values()],
      plugins: [...this.plugins.values()],
      versions: [...this.versions.values()],
      installations: [...this.installations.values()],
      approvals: [...this.approvals.values()]
    };
  }

  private requireInstallation(id: string) {
    const installation = this.installations.get(id);
    if (installation === undefined) {
      throw new Error(`installation ${id} was not seeded`);
    }
    return installation;
  }
}

class InMemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, string | ArrayBuffer | Uint8Array>();

  putArtifact(hash: string, content: string | ArrayBuffer | Uint8Array) {
    this.artifacts.set(hash, content);
    return Promise.resolve({ hash });
  }

  get(hash: string) {
    return this.artifacts.get(hash);
  }
}
