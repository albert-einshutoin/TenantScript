import type { TenantScriptManifest } from "@tenantscript/manifest";
import { parseManifest } from "@tenantscript/manifest";
import type { PluginRecord, PluginVersionRecord } from "./storage.js";

export interface ControlPlaneStore {
  createPlugin: (record: PluginRecord) => Promise<PluginRecord>;
  findPluginByKey: (query: { appId: string; key: string }) => Promise<PluginRecord | null>;
  createPluginVersion: (record: PluginVersionRecord) => Promise<PluginVersionRecord>;
  findPluginVersion: (query: {
    pluginId: string;
    version: string;
  }) => Promise<PluginVersionRecord | null>;
  listPluginVersions: (query: { pluginId: string }) => Promise<readonly PluginVersionRecord[]>;
}

export interface ArtifactStore {
  putArtifact: (
    hash: string,
    content: string | ArrayBuffer | Uint8Array
  ) => Promise<{ hash: string }>;
}

export interface ControlPlaneApi {
  registerPlugin: (request: RegisterPluginRequest) => Promise<PluginRecord>;
  registerPluginVersion: (request: RegisterPluginVersionRequest) => Promise<PluginVersionRecord>;
  listPluginVersions: (
    request: ListPluginVersionsRequest
  ) => Promise<readonly PluginVersionRecord[]>;
}

export interface RegisterPluginRequest {
  appId: string;
  key: string;
}

export interface RegisterPluginVersionRequest {
  appId: string;
  pluginKey: string;
  version: string;
  manifest: unknown;
  artifactHash: string;
  artifact: string | ArrayBuffer | Uint8Array;
}

export interface ListPluginVersionsRequest {
  appId: string;
  pluginKey: string;
}

export class ControlPlaneApiError extends Error {
  override readonly name = "ControlPlaneApiError";

  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function createControlPlaneApi(params: {
  store: ControlPlaneStore;
  artifacts: ArtifactStore;
}): ControlPlaneApi {
  return {
    registerPlugin: (request) => registerPlugin(params.store, request),
    registerPluginVersion: (request) =>
      registerPluginVersion(params.store, params.artifacts, request),
    listPluginVersions: (request) => listPluginVersions(params.store, request)
  };
}

async function registerPlugin(
  store: ControlPlaneStore,
  request: RegisterPluginRequest
): Promise<PluginRecord> {
  const existing = await store.findPluginByKey({ appId: request.appId, key: request.key });
  if (existing !== null) {
    return existing;
  }

  return store.createPlugin({
    id: pluginIdFor(request.appId, request.key),
    appId: request.appId,
    key: request.key
  });
}

async function registerPluginVersion(
  store: ControlPlaneStore,
  artifacts: ArtifactStore,
  request: RegisterPluginVersionRequest
): Promise<PluginVersionRecord> {
  const plugin = await requirePlugin(store, request.appId, request.pluginKey);
  const manifest = parseVersionManifest(request.manifest, request.version);
  const existing = await store.findPluginVersion({
    pluginId: plugin.id,
    version: request.version
  });

  if (existing !== null) {
    throw new ControlPlaneApiError(
      409,
      "plugin_version_already_exists",
      `plugin version ${request.pluginKey}@${request.version} already exists`
    );
  }

  await artifacts.putArtifact(request.artifactHash, request.artifact);

  return store.createPluginVersion({
    id: pluginVersionIdFor(plugin.id, request.version),
    pluginId: plugin.id,
    version: request.version,
    artifactHash: request.artifactHash,
    manifest
  });
}

async function listPluginVersions(
  store: ControlPlaneStore,
  request: ListPluginVersionsRequest
): Promise<readonly PluginVersionRecord[]> {
  const plugin = await requirePlugin(store, request.appId, request.pluginKey);
  return store.listPluginVersions({ pluginId: plugin.id });
}

async function requirePlugin(
  store: ControlPlaneStore,
  appId: string,
  key: string
): Promise<PluginRecord> {
  const plugin = await store.findPluginByKey({ appId, key });
  if (plugin === null) {
    throw new ControlPlaneApiError(404, "plugin_not_found", `plugin ${key} was not found`);
  }

  return plugin;
}

function parseVersionManifest(input: unknown, version: string): TenantScriptManifest {
  const parsed = parseManifest(input);
  if (!parsed.ok) {
    throw new ControlPlaneApiError(400, "invalid_manifest", "manifest validation failed");
  }

  if (parsed.value.version !== version) {
    throw new ControlPlaneApiError(
      400,
      "version_mismatch",
      `manifest version ${parsed.value.version} does not match ${version}`
    );
  }

  return parsed.value;
}

function pluginIdFor(appId: string, key: string): string {
  return stableId("plugin", appId, key);
}

function pluginVersionIdFor(pluginId: string, version: string): string {
  return stableId("plugin-version", pluginId, version);
}

function stableId(...parts: readonly string[]): string {
  return parts.map(escapeStableIdPart).join(":");
}

function escapeStableIdPart(part: string): string {
  return part.replaceAll("%", "%25").replaceAll(":", "%3A");
}
