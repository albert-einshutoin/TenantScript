import { describe, expect, it, vi } from "vitest";
import {
  AdminInstallFlowError,
  createD1AdminInstallFlowStore,
  type D1DatabaseLike,
  type D1PreparedStatementLike
} from "../src/index.js";
import type { TenantScriptManifest } from "@tenantscript/manifest";

describe("D1 Admin install flow adapter", () => {
  it("projects nested capability references and allowlisted egress without manifest defaults", async () => {
    const db = database(versionRow(allowlistedManifest));
    const flow = createD1AdminInstallFlowStore(db);

    await expect(flow.readVersion({ appId: "app_1", versionId: "version_1" })).resolves.toEqual({
      versionId: "version_1",
      pluginKey: "invoice-notify",
      version: "1.0.0",
      configFields: [
        { name: "channel", type: "string", required: true, hasDefault: false },
        { name: "threshold", type: "number", required: false, hasDefault: true }
      ],
      capabilities: [
        {
          name: "invoice.read",
          scopeKeys: ["filters"],
          configReferences: ["channel", "threshold"]
        }
      ],
      egress: { mode: "allowlist", allowlistedHostCount: 2 }
    });
    expect(
      JSON.stringify(await flow.readVersion({ appId: "app_1", versionId: "version_1" }))
    ).not.toContain("manifest-default-secret");
  });

  it("returns null for an unavailable version and rejects corrupt stored manifests", async () => {
    const missing = createD1AdminInstallFlowStore(database(null));
    await expect(missing.readVersion({ appId: "app_1", versionId: "missing" })).resolves.toBeNull();

    const corrupt = createD1AdminInstallFlowStore(
      database({ ...versionRow(allowlistedManifest), manifest_json: "{" })
    );
    await expect(corrupt.readVersion({ appId: "app_1", versionId: "version_1" })).rejects.toThrow(
      "invalid plugin version manifest"
    );
  });

  it("validates confirmation and config before batching value-bearing installation with safe audit", async () => {
    const db = database(versionRow(configurableManifest));
    const flow = createD1AdminInstallFlowStore(db, {
      installationId: () => "installation_new",
      auditId: () => "audit_new",
      now: () => new Date("2026-07-19T00:00:00.000Z")
    });

    await expect(
      flow.install({
        appId: "app_1",
        tenantId: "tenant_1",
        actor: "manager",
        versionId: "version_1",
        config: { channel: "C123" },
        confirmedCapabilities: ["slack.send"],
        enabled: false,
        priority: 7
      })
    ).resolves.toEqual({
      id: "installation_new",
      pluginKey: "invoice-notify",
      version: "1.0.0",
      enabled: false,
      priority: 7,
      revision: 0
    });

    expect(db.batch).toHaveBeenCalledTimes(1);
    const statements = db.batch.mock.calls[0]?.[0] ?? [];
    const installationBindings = statementBindings(statements[0]);
    const auditBindings = statementBindings(statements[1]);
    expect(installationBindings).toContain(JSON.stringify({ channel: "C123", retries: 3 }));
    expect(installationBindings).toContain(JSON.stringify({ "slack.send": { channel: "C123" } }));
    expect(auditBindings).toContain(
      JSON.stringify({
        enabled: false,
        priority: 7,
        revision: 0,
        configFields: ["channel", "retries"],
        capabilities: ["slack.send"]
      })
    );
    expect(JSON.stringify(auditBindings)).not.toContain("C123");
  });

  it.each([
    ["missing confirmation", [], { channel: "C123" }, "capability_confirmation_mismatch"],
    [
      "duplicate confirmation",
      ["slack.send", "slack.send"],
      { channel: "C123" },
      "capability_confirmation_mismatch"
    ],
    ["missing required config", ["slack.send"], {}, "invalid_config"],
    ["wrong config type", ["slack.send"], { channel: 123 }, "invalid_config"]
  ])("rejects %s without a write", async (_label, confirmedCapabilities, config, code) => {
    const db = database(versionRow(configurableManifest));
    const flow = createD1AdminInstallFlowStore(db);

    await expect(
      flow.install({
        appId: "app_1",
        tenantId: "tenant_1",
        actor: "manager",
        versionId: "version_1",
        config,
        confirmedCapabilities,
        enabled: false,
        priority: 10
      })
    ).rejects.toEqual(new AdminInstallFlowError(code as AdminInstallFlowError["code"]));
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("returns null for a tenant/version mismatch and fails closed without D1 batch", async () => {
    const missing = createD1AdminInstallFlowStore(database(null));
    await expect(
      missing.install({
        appId: "app_1",
        tenantId: "tenant_other",
        actor: "manager",
        versionId: "version_1",
        config: {},
        confirmedCapabilities: [],
        enabled: false,
        priority: 10
      })
    ).resolves.toBeNull();

    const db = database(versionRow(emptyManifest));
    delete (db as Partial<typeof db>).batch;
    await expect(
      createD1AdminInstallFlowStore(db).install({
        appId: "app_1",
        tenantId: "tenant_1",
        actor: "manager",
        versionId: "version_1",
        config: {},
        confirmedCapabilities: [],
        enabled: false,
        priority: 10
      })
    ).rejects.toThrow("D1 batch is unavailable");
  });
});

function database(row: VersionRow | null): D1DatabaseLike & {
  batch: ReturnType<typeof vi.fn<(statements: D1PreparedStatementLike[]) => Promise<unknown>>>;
} {
  const batch = vi
    .fn<(statements: D1PreparedStatementLike[]) => Promise<unknown>>()
    .mockResolvedValue([]);
  return {
    prepare: (query) => new Statement(query, row),
    batch
  };
}

class Statement implements D1PreparedStatementLike {
  readonly bindings: unknown[];

  constructor(
    readonly query: string,
    private readonly row: VersionRow | null,
    bindings: unknown[] = []
  ) {
    this.bindings = bindings;
  }

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new Statement(this.query, this.row, values);
  }

  run(): Promise<unknown> {
    return Promise.resolve({ success: true });
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve(this.row as T | null);
  }

  all(): Promise<{ results: unknown[] }> {
    return Promise.resolve({ results: [] });
  }
}

function statementBindings(statement: D1PreparedStatementLike | undefined): unknown[] {
  if (!(statement instanceof Statement)) throw new Error("expected fake statement");
  return statement.bindings;
}

interface VersionRow {
  id: string;
  plugin_id: string;
  plugin_key: string;
  version: string;
  manifest_json: string;
}

function versionRow(manifest: TenantScriptManifest): VersionRow {
  return {
    id: "version_1",
    plugin_id: "plugin_1",
    plugin_key: "invoice-notify",
    version: "1.0.0",
    manifest_json: JSON.stringify(manifest)
  };
}

const baseManifest = {
  name: "invoice-notify",
  version: "1.0.0",
  hooks: [{ name: "invoice.created", type: "event", timeoutMs: 250 }],
  egress: { mode: "deny" },
  limits: { cpuMs: 50, timeoutMs: 500 }
} satisfies Omit<TenantScriptManifest, "capabilities" | "configSchema">;

const configurableManifest = {
  ...baseManifest,
  capabilities: { "slack.send": { channel: "$config.channel" } },
  configSchema: {
    properties: {
      channel: { type: "string" },
      retries: { type: "number", default: 3 }
    },
    required: ["channel"]
  }
} satisfies TenantScriptManifest;

const allowlistedManifest = {
  ...baseManifest,
  capabilities: {
    "invoice.read": { filters: ["$config.channel", { minimum: "$config.threshold" }] }
  },
  configSchema: {
    properties: {
      channel: { type: "string" },
      threshold: { type: "number", default: 100 }
    },
    required: ["channel"]
  },
  egress: { mode: "allowlist", hosts: ["api.example.com", "hooks.example.com"] }
} satisfies TenantScriptManifest;

const emptyManifest = {
  ...baseManifest,
  capabilities: {},
  configSchema: { properties: {}, required: [] }
} satisfies TenantScriptManifest;
