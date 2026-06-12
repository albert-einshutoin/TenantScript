import type { GrantMap, InstallationConfig, TenantScriptManifest } from "@tenantscript/manifest";
import { parseManifest, resolveGrants, validateConfig } from "@tenantscript/manifest";
import type {
  AppRecord,
  InstallationRecord,
  PluginRecord,
  PluginVersionRecord,
  TenantRecord
} from "./storage.js";

export interface ControlPlaneStore {
  createApp: (record: AppRecord) => Promise<AppRecord>;
  findAppById: (id: string) => Promise<AppRecord | null>;
  createTenant: (record: TenantRecord) => Promise<TenantRecord>;
  findTenantById: (id: string) => Promise<TenantRecord | null>;
  createPlugin: (record: PluginRecord) => Promise<PluginRecord>;
  findPluginByKey: (query: { appId: string; key: string }) => Promise<PluginRecord | null>;
  createPluginVersion: (record: PluginVersionRecord) => Promise<PluginVersionRecord>;
  findPluginVersionById: (id: string) => Promise<PluginVersionRecord | null>;
  findPluginVersion: (query: {
    pluginId: string;
    version: string;
  }) => Promise<PluginVersionRecord | null>;
  listPluginVersions: (query: { pluginId: string }) => Promise<readonly PluginVersionRecord[]>;
  createInstallation: (record: InstallationRecord) => Promise<InstallationRecord>;
  findInstallationById: (id: string) => Promise<InstallationRecord | null>;
  updateInstallationConfig: (request: {
    id: string;
    config: Record<string, unknown>;
    grants: Record<string, unknown>;
  }) => Promise<InstallationRecord>;
  setInstallationEnabled: (request: {
    id: string;
    enabled: boolean;
  }) => Promise<InstallationRecord>;
  updateInstallationPriority: (request: {
    id: string;
    priority: number;
  }) => Promise<InstallationRecord>;
}

export interface ArtifactStore {
  putArtifact: (
    hash: string,
    content: string | ArrayBuffer | Uint8Array
  ) => Promise<{ hash: string }>;
}

export interface ControlPlaneApi {
  createApp: (request: CreateAppRequest) => Promise<AppRecord>;
  createTenant: (request: CreateTenantRequest) => Promise<TenantRecord>;
  registerPlugin: (request: RegisterPluginRequest) => Promise<PluginRecord>;
  registerPluginVersion: (request: RegisterPluginVersionRequest) => Promise<PluginVersionRecord>;
  listPluginVersions: (
    request: ListPluginVersionsRequest
  ) => Promise<readonly PluginVersionRecord[]>;
  installPlugin: (request: InstallPluginRequest) => Promise<InstallationRecord>;
  updateInstallationConfig: (
    request: UpdateInstallationConfigRequest
  ) => Promise<InstallationRecord>;
  setInstallationEnabled: (request: SetInstallationEnabledRequest) => Promise<InstallationRecord>;
  updateInstallationPriority: (
    request: UpdateInstallationPriorityRequest
  ) => Promise<InstallationRecord>;
}

export interface CreateAppRequest {
  id: string;
  name: string;
}

export interface CreateTenantRequest {
  id: string;
  appId: string;
  name: string;
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

export interface InstallPluginRequest {
  id: string;
  appId: string;
  tenantId: string;
  pluginKey: string;
  version: string;
  config: Record<string, unknown>;
  grants: Record<string, unknown>;
  priority: number;
  enabled?: boolean;
}

export interface UpdateInstallationConfigRequest {
  id: string;
  config: Record<string, unknown>;
}

export interface SetInstallationEnabledRequest {
  id: string;
  enabled: boolean;
}

export interface UpdateInstallationPriorityRequest {
  id: string;
  priority: number;
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
    createApp: (request) => params.store.createApp(request),
    createTenant: (request) => createTenant(params.store, request),
    registerPlugin: (request) => registerPlugin(params.store, request),
    registerPluginVersion: (request) =>
      registerPluginVersion(params.store, params.artifacts, request),
    listPluginVersions: (request) => listPluginVersions(params.store, request),
    installPlugin: (request) => installPlugin(params.store, request),
    updateInstallationConfig: (request) => updateInstallationConfig(params.store, request),
    setInstallationEnabled: (request) => setInstallationEnabled(params.store, request),
    updateInstallationPriority: (request) => updateInstallationPriority(params.store, request)
  };
}

async function createTenant(
  store: ControlPlaneStore,
  request: CreateTenantRequest
): Promise<TenantRecord> {
  await requireApp(store, request.appId);
  return store.createTenant(request);
}

async function registerPlugin(
  store: ControlPlaneStore,
  request: RegisterPluginRequest
): Promise<PluginRecord> {
  await requireApp(store, request.appId);
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

async function installPlugin(
  store: ControlPlaneStore,
  request: InstallPluginRequest
): Promise<InstallationRecord> {
  const plugin = await requirePlugin(store, request.appId, request.pluginKey);
  const version = await requirePluginVersion(store, plugin.id, request.version);
  await requireTenantInApp(store, request.tenantId, request.appId);
  const grants = validateInstallationGrants(version.manifest, request.config, request.grants);

  return store.createInstallation({
    id: request.id,
    tenantId: request.tenantId,
    pluginVersionId: version.id,
    enabled: request.enabled ?? true,
    priority: request.priority,
    config: grants.config,
    grants: grants.resolvedGrants
  });
}

async function updateInstallationConfig(
  store: ControlPlaneStore,
  request: UpdateInstallationConfigRequest
): Promise<InstallationRecord> {
  const installation = await requireInstallation(store, request.id);
  const version = await requirePluginVersionById(store, installation.pluginVersionId);
  const config = validateInstallationConfig(version.manifest, request.config);
  const grants = resolveRequiredGrants(version.manifest, config);

  return store.updateInstallationConfig({
    id: request.id,
    config,
    grants
  });
}

async function setInstallationEnabled(
  store: ControlPlaneStore,
  request: SetInstallationEnabledRequest
): Promise<InstallationRecord> {
  await requireInstallation(store, request.id);
  return store.setInstallationEnabled(request);
}

async function updateInstallationPriority(
  store: ControlPlaneStore,
  request: UpdateInstallationPriorityRequest
): Promise<InstallationRecord> {
  await requireInstallation(store, request.id);
  return store.updateInstallationPriority(request);
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

async function requireApp(store: ControlPlaneStore, appId: string): Promise<AppRecord> {
  const app = await store.findAppById(appId);
  if (app === null) {
    throw new ControlPlaneApiError(404, "app_not_found", `app ${appId} was not found`);
  }

  return app;
}

async function requireTenantInApp(
  store: ControlPlaneStore,
  tenantId: string,
  appId: string
): Promise<TenantRecord> {
  const tenant = await store.findTenantById(tenantId);
  if (tenant === null || tenant.appId !== appId) {
    throw new ControlPlaneApiError(404, "tenant_not_found", `tenant ${tenantId} was not found`);
  }

  return tenant;
}

async function requirePluginVersion(
  store: ControlPlaneStore,
  pluginId: string,
  version: string
): Promise<PluginVersionRecord> {
  const pluginVersion = await store.findPluginVersion({ pluginId, version });
  if (pluginVersion === null) {
    throw new ControlPlaneApiError(
      404,
      "plugin_version_not_found",
      `plugin version ${version} was not found`
    );
  }

  return pluginVersion;
}

async function requirePluginVersionById(
  store: ControlPlaneStore,
  pluginVersionId: string
): Promise<PluginVersionRecord> {
  const pluginVersion = await store.findPluginVersionById(pluginVersionId);
  if (pluginVersion === null) {
    throw new ControlPlaneApiError(
      404,
      "plugin_version_not_found",
      `plugin version ${pluginVersionId} was not found`
    );
  }

  return pluginVersion;
}

async function requireInstallation(
  store: ControlPlaneStore,
  id: string
): Promise<InstallationRecord> {
  const installation = await store.findInstallationById(id);
  if (installation === null) {
    throw new ControlPlaneApiError(
      404,
      "installation_not_found",
      `installation ${id} was not found`
    );
  }

  return installation;
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

function validateInstallationGrants(
  manifest: TenantScriptManifest,
  configInput: Record<string, unknown>,
  grantInput: Record<string, unknown>
): { config: InstallationConfig; resolvedGrants: GrantMap } {
  const config = validateInstallationConfig(manifest, configInput);
  const resolvedGrants = resolveRequiredGrants(manifest, config);
  if (!deepEqual(resolvedGrants, grantInput)) {
    throw new ControlPlaneApiError(
      400,
      "invalid_grants",
      "installation grants do not match manifest capability requirements"
    );
  }

  return { config, resolvedGrants };
}

function validateInstallationConfig(
  manifest: TenantScriptManifest,
  configInput: Record<string, unknown>
): InstallationConfig {
  const config = validateConfig(manifest.configSchema, configInput);
  if (!config.ok) {
    throw new ControlPlaneApiError(400, "invalid_config", "installation config validation failed");
  }

  return config.value;
}

function resolveRequiredGrants(
  manifest: TenantScriptManifest,
  config: InstallationConfig
): GrantMap {
  const grants = resolveGrants(manifest.capabilities, config);
  if (!grants.ok) {
    throw new ControlPlaneApiError(400, "invalid_grants", "manifest capability grants are invalid");
  }

  return grants.value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
