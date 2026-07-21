import { describe, expect, it } from "vitest";
import {
  ArtifactAlreadyExistsError,
  createD1ControlPlaneStore,
  createD1SlackConnectionStore,
  createR2ArtifactStore,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type R2BucketLike
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

describe("createD1ControlPlaneStore", () => {
  it("writes core records and maps execution search rows", async () => {
    const db = new FakeD1Database([
      {
        id: "exec_1",
        tenant_id: "tenant_1",
        plugin_id: "plugin_1",
        hook_name: "invoice.created",
        version: "1.0.0",
        status: "success",
        duration_ms: 12,
        error: null,
        capability_calls_json: JSON.stringify([{ name: "slack.send", status: "success" }]),
        created_at: "2026-06-12T00:00:00.000Z"
      }
    ]);
    const store = createD1ControlPlaneStore(db);

    await seedStore(store);
    const executions = await store.searchExecutions({ tenantId: "tenant_1" });

    expect(db.runCount).toBe(6);
    expect(executions).toEqual([
      {
        id: "exec_1",
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        hookName: "invoice.created",
        version: "1.0.0",
        status: "success",
        durationMs: 12,
        capabilityCalls: [{ name: "slack.send", status: "success" }],
        createdAt: new Date("2026-06-12T00:00:00.000Z")
      }
    ]);
  });

  it("maps nullable execution errors only when present", async () => {
    const db = new FakeD1Database([
      {
        id: "exec_1",
        tenant_id: "tenant_1",
        plugin_id: "plugin_1",
        hook_name: "invoice.created",
        version: "1.0.0",
        status: "error",
        duration_ms: 12,
        error: "boom",
        capability_calls_json: "[]",
        created_at: "2026-06-12T00:00:00.000Z"
      }
    ]);

    await expect(
      createD1ControlPlaneStore(db).searchExecutions({ status: "error" })
    ).resolves.toEqual([expect.objectContaining({ error: "boom" })]);
  });

  it("resolves only installations whose manifest includes the requested hook", async () => {
    const db = new FakeD1Database(
      [],
      [
        {
          installation_id: "inst_1",
          tenant_id: "tenant_1",
          plugin_version_id: "version_1",
          enabled: 1,
          priority: 10,
          config_json: JSON.stringify({ notifyChannel: "C123" }),
          grants_json: JSON.stringify({ "slack.send": { channel: "C123" } }),
          version: "1.0.0",
          manifest_json: JSON.stringify(manifest),
          plugin_id: "plugin_1"
        }
      ]
    );

    await expect(
      createD1ControlPlaneStore(db).resolveInstallationsForHook({
        tenantId: "tenant_1",
        hookName: "invoice.created"
      })
    ).resolves.toEqual([
      expect.objectContaining({
        id: "inst_1",
        pluginId: "plugin_1",
        pluginVersionId: "version_1",
        version: "1.0.0",
        hooks: ["invoice.created"],
        config: { notifyChannel: "C123" }
      })
    ]);

    await expect(
      createD1ControlPlaneStore(db).resolveInstallationsForHook({
        tenantId: "tenant_1",
        hookName: "unmatched.hook"
      })
    ).resolves.toEqual([]);
  });

  it("fails when an enabled installation points at a missing pinned version", async () => {
    const db = new FakeD1Database(
      [],
      [
        {
          installation_id: "inst_orphaned",
          tenant_id: "tenant_1",
          plugin_version_id: "missing_version",
          enabled: 1,
          priority: 10,
          config_json: "{}",
          grants_json: "{}",
          version: null,
          manifest_json: null,
          plugin_id: null
        }
      ]
    );

    await expect(
      createD1ControlPlaneStore(db).resolveInstallationsForHook({
        tenantId: "tenant_1",
        hookName: "invoice.created"
      })
    ).rejects.toThrow(
      "installation inst_orphaned references missing pinned version missing_version"
    );
  });

  it("finds plugins and versions through first/list queries", async () => {
    const db = new FakeD1Database(
      [],
      [],
      [{ id: "plugin_1", app_id: "app_1", key: "large-invoice-notify" }],
      [
        {
          id: "version_1",
          plugin_id: "plugin_1",
          version: "1.0.0",
          artifact_hash: "hash_1",
          manifest_json: JSON.stringify(manifest)
        }
      ]
    );
    const store = createD1ControlPlaneStore(db);

    await expect(
      store.findPluginByKey({ appId: "app_1", key: "large-invoice-notify" })
    ).resolves.toEqual({
      id: "plugin_1",
      appId: "app_1",
      key: "large-invoice-notify"
    });
    await expect(
      store.findPluginVersion({ pluginId: "plugin_1", version: "1.0.0" })
    ).resolves.toEqual(expect.objectContaining({ id: "version_1", artifactHash: "hash_1" }));
    await expect(store.findPluginVersionById("version_1")).resolves.toEqual(
      expect.objectContaining({ id: "version_1", artifactHash: "hash_1" })
    );
    await expect(store.listPluginVersions({ pluginId: "plugin_1" })).resolves.toEqual([
      expect.objectContaining({ id: "version_1", version: "1.0.0" })
    ]);
    await expect(store.findPluginByKey({ appId: "app_1", key: "missing" })).resolves.toBeNull();
  });

  it("finds and updates installation config, enabled state, and priority", async () => {
    const installationRow = {
      id: "inst_1",
      tenant_id: "tenant_1",
      plugin_version_id: "version_1",
      enabled: 1,
      priority: 10,
      config_json: JSON.stringify({ notifyChannel: "C123" }),
      grants_json: JSON.stringify({ "slack.send": { channel: "C123" } })
    };
    const store = createD1ControlPlaneStore(new FakeD1Database([], [installationRow]));

    await expect(store.findInstallationById("inst_1")).resolves.toEqual({
      id: "inst_1",
      tenantId: "tenant_1",
      pluginVersionId: "version_1",
      enabled: true,
      priority: 10,
      config: { notifyChannel: "C123" },
      grants: { "slack.send": { channel: "C123" } }
    });
    await expect(
      store.updateInstallationConfig({
        id: "inst_1",
        config: { notifyChannel: "C456" },
        grants: { "slack.send": { channel: "C456" } }
      })
    ).resolves.toEqual(expect.objectContaining({ config: { notifyChannel: "C456" } }));
    await expect(store.setInstallationEnabled({ id: "inst_1", enabled: false })).resolves.toEqual(
      expect.objectContaining({ enabled: false })
    );
    await expect(store.updateInstallationPriority({ id: "inst_1", priority: 1 })).resolves.toEqual(
      expect.objectContaining({ priority: 1 })
    );
    await expect(
      store.updateInstallationVersion({ id: "inst_1", pluginVersionId: "version_0" })
    ).resolves.toEqual(expect.objectContaining({ pluginVersionId: "version_0" }));
  });

  it("rejects installation updates when the row disappears", async () => {
    const store = createD1ControlPlaneStore(new FakeD1Database());

    await expect(
      store.updateInstallationConfig({ id: "missing", config: {}, grants: {} })
    ).rejects.toThrow("installation missing was not found after config update");
    await expect(store.setInstallationEnabled({ id: "missing", enabled: false })).rejects.toThrow(
      "installation missing was not found after enabled update"
    );
    await expect(store.updateInstallationPriority({ id: "missing", priority: 1 })).rejects.toThrow(
      "installation missing was not found after priority update"
    );
    await expect(
      store.updateInstallationVersion({ id: "missing", pluginVersionId: "version_0" })
    ).rejects.toThrow("installation missing was not found after version update");
  });

  it("finds and decides approvals", async () => {
    const approvalRow = {
      id: "approval_1",
      tenant_id: "tenant_1",
      plugin_id: "plugin_1",
      role: "manager",
      subject_json: JSON.stringify({ invoiceId: "inv_1" }),
      resume_hook: "onInvoiceApprovalDecided",
      state: "pending",
      expires_at: "2026-06-14T01:00:00.000Z",
      created_at: "2026-06-13T01:00:00.000Z",
      decided_by: null,
      decision_reason: null,
      decided_at: null
    };
    const store = createD1ControlPlaneStore(new FakeD1Database([], [], [], [], [approvalRow]));

    await expect(
      store.createApproval({
        id: "approval_2",
        tenantId: "tenant_1",
        pluginId: "plugin_1",
        role: "manager",
        subject: { invoiceId: "inv_2" },
        resumeHook: "onInvoiceApprovalDecided",
        state: "pending",
        expiresAt: new Date("2026-06-14T01:00:00.000Z"),
        createdAt: new Date("2026-06-13T01:00:00.000Z")
      })
    ).resolves.toEqual(expect.objectContaining({ id: "approval_2", state: "pending" }));
    await expect(store.findApprovalById("approval_1")).resolves.toEqual({
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
      store.decideApproval({
        id: "approval_1",
        decision: "approved",
        decidedBy: "manager@example.com",
        decisionReason: "valid invoice",
        decidedAt: new Date("2026-06-13T01:15:00.000Z")
      })
    ).resolves.toEqual(
      expect.objectContaining({
        state: "approved",
        decidedBy: "manager@example.com",
        decisionReason: "valid invoice",
        decidedAt: new Date("2026-06-13T01:15:00.000Z")
      })
    );
  });

  it("stores Slack connection metadata in D1 without raw tokens", async () => {
    const rawToken = "xoxb-token-that-must-not-enter-d1";
    const db = new FakeD1Database();
    const store = createD1SlackConnectionStore(db);

    await expect(
      store.upsertSlackConnection({
        id: "slack:tenant_1:T123",
        tenantId: "tenant_1",
        workspaceId: "T123",
        workspaceName: "Acme Workspace",
        botUserId: "B123",
        secretRef: {
          provider: "slack",
          appId: "app_1",
          tenantId: "tenant_1",
          secretId: "slack:T123"
        },
        connectedAt: new Date("2026-06-13T01:00:00.000Z")
      })
    ).resolves.toMatchObject({ id: "slack:tenant_1:T123" });
    await expect(
      store.findSlackConnection({ tenantId: "tenant_1", workspaceId: "T123" })
    ).resolves.toEqual({
      id: "slack:tenant_1:T123",
      tenantId: "tenant_1",
      workspaceId: "T123",
      workspaceName: "Acme Workspace",
      botUserId: "B123",
      secretRef: {
        provider: "slack",
        appId: "app_1",
        tenantId: "tenant_1",
        secretId: "slack:T123"
      },
      connectedAt: new Date("2026-06-13T01:00:00.000Z")
    });
    expect(JSON.stringify(db.dumpRows())).not.toContain(rawToken);
  });
});

describe("createR2ArtifactStore", () => {
  it("round-trips immutable artifacts", async () => {
    const store = createR2ArtifactStore(new FakeR2Bucket());
    await store.putArtifact("hash_1", "bundle-code");

    const content = await store.getArtifact("hash_1");
    expect(new TextDecoder().decode(content ?? new ArrayBuffer(0))).toBe("bundle-code");
    await expect(store.putArtifact("hash_1", "replacement")).rejects.toThrow(
      ArtifactAlreadyExistsError
    );
    await expect(store.getArtifact("missing")).resolves.toBeNull();
  });
});

async function seedStore(store: ReturnType<typeof createD1ControlPlaneStore>) {
  await store.createApp({ id: "app_1", name: "Example SaaS" });
  await store.createTenant({ id: "tenant_1", appId: "app_1", name: "Acme" });
  await store.createPlugin({ id: "plugin_1", appId: "app_1", key: "large-invoice-notify" });
  await store.createPluginVersion({
    id: "version_1",
    pluginId: "plugin_1",
    version: "1.0.0",
    artifactHash: "hash_1",
    manifest
  });
  await store.createInstallation({
    id: "inst_1",
    tenantId: "tenant_1",
    pluginVersionId: "version_1",
    enabled: true,
    priority: 10,
    config: { notifyChannel: "C123" },
    grants: { "slack.send": { channel: "C123" } }
  });
  await store.writeExecution({
    id: "exec_1",
    tenantId: "tenant_1",
    pluginId: "plugin_1",
    hookName: "invoice.created",
    version: "1.0.0",
    status: "success",
    durationMs: 12,
    capabilityCalls: [{ name: "slack.send", status: "success" }],
    createdAt: new Date("2026-06-12T00:00:00.000Z")
  });
}

class FakeD1Database implements D1DatabaseLike {
  runCount = 0;

  constructor(
    private readonly executionRows: unknown[] = [],
    private readonly installationRows: unknown[] = [],
    private readonly pluginRows: unknown[] = [],
    private readonly pluginVersionRows: unknown[] = [],
    private readonly approvalRows: unknown[] = [],
    private readonly slackConnectionRows: unknown[] = []
  ) {}

  prepare(query: string): D1PreparedStatementLike {
    return new FakeD1Statement(this, query);
  }

  executeRun(query: string, values: readonly unknown[]) {
    if (query.includes("UPDATE installations SET config_json")) {
      const row = this.findInstallationRow(values[2]);
      if (row !== undefined) {
        row.config_json = values[0];
        row.grants_json = values[1];
      }
    } else if (query.includes("UPDATE installations SET enabled")) {
      const row = this.findInstallationRow(values[1]);
      if (row !== undefined) {
        row.enabled = values[0];
      }
    } else if (query.includes("UPDATE installations SET priority")) {
      const row = this.findInstallationRow(values[1]);
      if (row !== undefined) {
        row.priority = values[0];
      }
    } else if (query.includes("UPDATE installations SET plugin_version_id")) {
      const row = this.findInstallationRow(values[1]);
      if (row !== undefined) {
        row.plugin_version_id = values[0];
      }
    } else if (query.includes("UPDATE approvals SET state")) {
      const row = this.findApprovalRow(values[4]);
      if (row !== undefined) {
        row.state = values[0];
        row.decided_by = values[1];
        row.decision_reason = values[2];
        row.decided_at = values[3];
      }
    } else if (query.includes("INSERT OR REPLACE INTO slack_connections")) {
      const existing = this.findSlackConnectionRow(values[1], values[2]);
      const row = {
        id: values[0],
        tenant_id: values[1],
        workspace_id: values[2],
        workspace_name: values[3],
        bot_user_id: values[4],
        secret_ref_json: values[5],
        connected_at: values[6]
      };
      if (existing === undefined) {
        this.slackConnectionRows.push(row);
      } else {
        Object.assign(existing, row);
      }
    }
    this.runCount += 1;
  }

  executeAll(query: string) {
    if (query.includes("FROM installations")) {
      return { results: this.installationRows };
    }
    if (query.includes("FROM plugin_versions")) {
      return { results: this.pluginVersionRows };
    }
    if (query.includes("FROM approvals")) {
      return { results: this.approvalRows };
    }
    if (query.includes("FROM slack_connections")) {
      return { results: this.slackConnectionRows };
    }
    return { results: this.executionRows };
  }

  executeFirst(query: string, values: readonly unknown[]) {
    if (query.includes("FROM plugins")) {
      return (
        this.pluginRows.find(
          (row) => isRecord(row) && row.app_id === values[0] && row.key === values[1]
        ) ?? null
      );
    }
    if (query.includes("FROM plugin_versions")) {
      if (query.includes("WHERE id = ?")) {
        return this.pluginVersionRows.find((row) => isRecord(row) && row.id === values[0]) ?? null;
      }
      return (
        this.pluginVersionRows.find(
          (row) => isRecord(row) && row.plugin_id === values[0] && row.version === values[1]
        ) ?? null
      );
    }
    if (query.includes("FROM installations")) {
      return this.findInstallationRow(values[0]) ?? null;
    }
    if (query.includes("FROM approvals")) {
      return this.findApprovalRow(values[0]) ?? null;
    }
    if (query.includes("FROM slack_connections")) {
      return this.findSlackConnectionRow(values[0], values[1]) ?? null;
    }
    return null;
  }

  dumpRows() {
    return {
      executions: this.executionRows,
      installations: this.installationRows,
      plugins: this.pluginRows,
      pluginVersions: this.pluginVersionRows,
      approvals: this.approvalRows,
      slackConnections: this.slackConnectionRows
    };
  }

  private findInstallationRow(id: unknown): Record<string, unknown> | undefined {
    return this.installationRows.find((row) => isRecord(row) && row.id === id) as
      | Record<string, unknown>
      | undefined;
  }

  private findApprovalRow(id: unknown): Record<string, unknown> | undefined {
    return this.approvalRows.find((row) => isRecord(row) && row.id === id) as
      | Record<string, unknown>
      | undefined;
  }

  private findSlackConnectionRow(
    tenantId: unknown,
    workspaceId: unknown
  ): Record<string, unknown> | undefined {
    return this.slackConnectionRows.find(
      (row) => isRecord(row) && row.tenant_id === tenantId && row.workspace_id === workspaceId
    ) as Record<string, unknown> | undefined;
  }
}

class FakeD1Statement implements D1PreparedStatementLike {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeD1Database,
    private readonly query: string
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  run() {
    this.db.executeRun(this.query, this.values);
    return Promise.resolve({});
  }

  first<T = unknown>() {
    return Promise.resolve(this.db.executeFirst(this.query, this.values) as T | null);
  }

  all() {
    return Promise.resolve(this.db.executeAll(this.query));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class FakeR2Bucket implements R2BucketLike {
  private readonly objects = new Map<string, Uint8Array>();

  head(key: string) {
    return Promise.resolve(this.objects.has(key) ? {} : null);
  }

  put(key: string, value: string | ArrayBuffer | Uint8Array) {
    const bytes =
      typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.objects.set(key, bytes);
    return Promise.resolve({});
  }

  get(key: string) {
    const bytes = this.objects.get(key);
    if (bytes === undefined) {
      return Promise.resolve(null);
    }

    return Promise.resolve({
      arrayBuffer() {
        const copy = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(copy).set(bytes);
        return Promise.resolve(copy);
      }
    });
  }
}
