import { describe, expect, it } from "vitest";
import {
  ArtifactAlreadyExistsError,
  createD1ControlPlaneStore,
  createR2ArtifactStore,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type R2BucketLike
} from "../src/index.js";
import type { TenantScriptManifest } from "@tenantscript/manifest";

const manifest = {
  name: "large-invoice-notify",
  version: "1.0.0",
  hooks: [{ name: "invoice.created", type: "event", timeoutMs: 250 }],
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
    await expect(store.listPluginVersions({ pluginId: "plugin_1" })).resolves.toEqual([
      expect.objectContaining({ id: "version_1", version: "1.0.0" })
    ]);
    await expect(store.findPluginByKey({ appId: "app_1", key: "missing" })).resolves.toBeNull();
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
    private readonly pluginVersionRows: unknown[] = []
  ) {}

  prepare(query: string): D1PreparedStatementLike {
    return new FakeD1Statement(this, query);
  }

  executeRun() {
    this.runCount += 1;
  }

  executeAll(query: string) {
    if (query.includes("FROM installations")) {
      return { results: this.installationRows };
    }
    if (query.includes("FROM plugin_versions")) {
      return { results: this.pluginVersionRows };
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
      return (
        this.pluginVersionRows.find(
          (row) => isRecord(row) && row.plugin_id === values[0] && row.version === values[1]
        ) ?? null
      );
    }
    return null;
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
    this.db.executeRun();
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
