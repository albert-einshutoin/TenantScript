import { describe, expect, it } from "vitest";
import {
  ControlPlaneApiError,
  createControlPlaneApi,
  type ArtifactStore,
  type ControlPlaneStore,
  type PluginRecord,
  type PluginVersionRecord
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

describe("createControlPlaneApi plugin/version registration", () => {
  it("registers a plugin version and lists versions for the plugin", async () => {
    const store = new InMemoryControlPlaneStore();
    const artifacts = new InMemoryArtifactStore();
    const api = createControlPlaneApi({ store, artifacts });

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

    const first = await api.registerPlugin({ appId: "app_1", key: "large-invoice-notify" });
    const second = await api.registerPlugin({ appId: "app_1", key: "large-invoice-notify" });

    expect(second).toBe(first);
  });

  it("rejects duplicate plugin version registration as immutable", async () => {
    const api = createControlPlaneApi({
      store: new InMemoryControlPlaneStore(),
      artifacts: new InMemoryArtifactStore()
    });
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
});

class InMemoryControlPlaneStore implements ControlPlaneStore {
  private readonly plugins = new Map<string, PluginRecord>();
  private readonly versions = new Map<string, PluginVersionRecord>();

  createPlugin(record: PluginRecord) {
    this.plugins.set(record.id, record);
    return Promise.resolve(record);
  }

  findPluginByKey(query: { appId: string; key: string }) {
    return Promise.resolve(
      [...this.plugins.values()].find(
        (plugin) => plugin.appId === query.appId && plugin.key === query.key
      ) ?? null
    );
  }

  createPluginVersion(record: PluginVersionRecord) {
    this.versions.set(record.id, record);
    return Promise.resolve(record);
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
