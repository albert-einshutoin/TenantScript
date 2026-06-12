import type { Installation } from "@tenantscript/host-sdk";
import type { TenantScriptManifest } from "@tenantscript/manifest";
import type {
  ApprovalDecision,
  ApprovalRecord,
  CapabilityCallRecord,
  ExecutionRecord,
  ExecutionSearchQuery,
  ExecutionStatus
} from "./index.js";

export interface D1DatabaseLike {
  prepare: (query: string) => D1PreparedStatementLike;
}

export interface D1PreparedStatementLike {
  bind: (...values: unknown[]) => D1PreparedStatementLike;
  run: () => Promise<unknown>;
  first: <T = unknown>() => Promise<T | null>;
  all: () => Promise<{ results: unknown[] }>;
}

export interface R2BucketLike {
  head: (key: string) => Promise<object | null>;
  put: (key: string, value: string | ArrayBuffer | Uint8Array) => Promise<unknown>;
  get: (key: string) => Promise<R2ObjectBodyLike | null>;
}

export interface R2ObjectBodyLike {
  arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface AppRecord {
  id: string;
  name: string;
}

export interface TenantRecord {
  id: string;
  appId: string;
  name: string;
}

export interface PluginRecord {
  id: string;
  appId: string;
  key: string;
}

export interface PluginVersionRecord {
  id: string;
  pluginId: string;
  version: string;
  artifactHash: string;
  manifest: TenantScriptManifest;
}

export interface InstallationRecord {
  id: string;
  tenantId: string;
  pluginVersionId: string;
  enabled: boolean;
  priority: number;
  config: Record<string, unknown>;
  grants: Record<string, unknown>;
}

export interface ResolvedInstallation extends Installation {
  tenantId: string;
  pluginVersionId: string;
  version: string;
  config: Record<string, unknown>;
  grants: Record<string, unknown>;
  manifest: TenantScriptManifest;
}

export class ArtifactAlreadyExistsError extends Error {
  override readonly name = "ArtifactAlreadyExistsError";
}

export function createD1ControlPlaneStore(db: D1DatabaseLike) {
  return {
    createApp: createAppWriter(db),
    findAppById: createAppByIdFinder(db),
    createTenant: createTenantWriter(db),
    findTenantById: createTenantByIdFinder(db),
    createPlugin: createPluginWriter(db),
    findPluginByKey: createPluginByKeyFinder(db),
    createPluginVersion: createPluginVersionWriter(db),
    findPluginVersionById: createPluginVersionByIdFinder(db),
    findPluginVersion: createPluginVersionFinder(db),
    listPluginVersions: createPluginVersionLister(db),
    createInstallation: createInstallationWriter(db),
    findInstallationById: createInstallationByIdFinder(db),
    updateInstallationConfig: createInstallationConfigUpdater(db),
    setInstallationEnabled: createInstallationEnabledUpdater(db),
    updateInstallationPriority: createInstallationPriorityUpdater(db),
    updateInstallationVersion: createInstallationVersionUpdater(db),
    findApprovalById: createApprovalByIdFinder(db),
    decideApproval: createApprovalDecisionUpdater(db),
    writeExecution: createExecutionWriter(db),
    searchExecutions: createExecutionSearcher(db),
    resolveInstallationsForHook: createInstallationResolver(db)
  };
}

function createAppWriter(db: D1DatabaseLike) {
  return async (record: AppRecord) => {
    await db
      .prepare("INSERT INTO apps (id, name) VALUES (?, ?)")
      .bind(record.id, record.name)
      .run();
    return record;
  };
}

function createAppByIdFinder(db: D1DatabaseLike) {
  return async (id: string) => {
    const row = await db.prepare("SELECT id, name FROM apps WHERE id = ?").bind(id).first<AppRow>();

    return row === null ? null : appFromRow(row);
  };
}

function createTenantWriter(db: D1DatabaseLike) {
  return async (record: TenantRecord) => {
    await db
      .prepare("INSERT INTO tenants (id, app_id, name) VALUES (?, ?, ?)")
      .bind(record.id, record.appId, record.name)
      .run();
    return record;
  };
}

function createTenantByIdFinder(db: D1DatabaseLike) {
  return async (id: string) => {
    const row = await db
      .prepare("SELECT id, app_id, name FROM tenants WHERE id = ?")
      .bind(id)
      .first<TenantRow>();

    return row === null ? null : tenantFromRow(row);
  };
}

function createPluginWriter(db: D1DatabaseLike) {
  return async (record: PluginRecord) => {
    await db
      .prepare("INSERT INTO plugins (id, app_id, key) VALUES (?, ?, ?)")
      .bind(record.id, record.appId, record.key)
      .run();
    return record;
  };
}

function createPluginByKeyFinder(db: D1DatabaseLike) {
  return async (query: { appId: string; key: string }) => {
    const row = await db
      .prepare("SELECT id, app_id, key FROM plugins WHERE app_id = ? AND key = ?")
      .bind(query.appId, query.key)
      .first<PluginRow>();

    return row === null ? null : pluginFromRow(row);
  };
}

function createPluginVersionWriter(db: D1DatabaseLike) {
  return async (record: PluginVersionRecord) => {
    await db
      .prepare(
        [
          "INSERT INTO plugin_versions",
          "(id, plugin_id, version, artifact_hash, manifest_json)",
          "VALUES (?, ?, ?, ?, ?)"
        ].join(" ")
      )
      .bind(
        record.id,
        record.pluginId,
        record.version,
        record.artifactHash,
        JSON.stringify(record.manifest)
      )
      .run();
    return record;
  };
}

function createPluginVersionFinder(db: D1DatabaseLike) {
  return async (query: { pluginId: string; version: string }) => {
    const row = await db
      .prepare(
        [
          "SELECT id, plugin_id, version, artifact_hash, manifest_json FROM plugin_versions",
          "WHERE plugin_id = ? AND version = ?"
        ].join(" ")
      )
      .bind(query.pluginId, query.version)
      .first<PluginVersionRow>();

    return row === null ? null : pluginVersionFromRow(row);
  };
}

function createPluginVersionByIdFinder(db: D1DatabaseLike) {
  return async (id: string) => {
    const row = await db
      .prepare(
        "SELECT id, plugin_id, version, artifact_hash, manifest_json FROM plugin_versions WHERE id = ?"
      )
      .bind(id)
      .first<PluginVersionRow>();

    return row === null ? null : pluginVersionFromRow(row);
  };
}

function createPluginVersionLister(db: D1DatabaseLike) {
  return async (query: { pluginId: string }) => {
    const rows = await db
      .prepare(
        [
          "SELECT id, plugin_id, version, artifact_hash, manifest_json FROM plugin_versions",
          "WHERE plugin_id = ?",
          "ORDER BY created_at ASC, version ASC"
        ].join(" ")
      )
      .bind(query.pluginId)
      .all();

    return (rows.results as PluginVersionRow[]).map(pluginVersionFromRow);
  };
}

function createInstallationWriter(db: D1DatabaseLike) {
  return async (record: InstallationRecord) => {
    await db
      .prepare(
        [
          "INSERT INTO installations",
          "(id, tenant_id, plugin_version_id, enabled, priority, config_json, grants_json)",
          "VALUES (?, ?, ?, ?, ?, ?, ?)"
        ].join(" ")
      )
      .bind(
        record.id,
        record.tenantId,
        record.pluginVersionId,
        record.enabled ? 1 : 0,
        record.priority,
        JSON.stringify(record.config),
        JSON.stringify(record.grants)
      )
      .run();
    return record;
  };
}

function createInstallationByIdFinder(db: D1DatabaseLike) {
  return async (id: string) => {
    const row = await db
      .prepare(
        [
          "SELECT id, tenant_id, plugin_version_id, enabled, priority, config_json, grants_json",
          "FROM installations WHERE id = ?"
        ].join(" ")
      )
      .bind(id)
      .first<InstallationRow>();

    return row === null ? null : installationFromRow(row);
  };
}

function createInstallationConfigUpdater(db: D1DatabaseLike) {
  return async (request: {
    id: string;
    config: Record<string, unknown>;
    grants: Record<string, unknown>;
  }) => {
    await db
      .prepare("UPDATE installations SET config_json = ?, grants_json = ? WHERE id = ?")
      .bind(JSON.stringify(request.config), JSON.stringify(request.grants), request.id)
      .run();
    const updated = await createInstallationByIdFinder(db)(request.id);
    if (updated === null) {
      throw new Error(`installation ${request.id} was not found after config update`);
    }
    return updated;
  };
}

function createInstallationEnabledUpdater(db: D1DatabaseLike) {
  return async (request: { id: string; enabled: boolean }) => {
    await db
      .prepare("UPDATE installations SET enabled = ? WHERE id = ?")
      .bind(request.enabled ? 1 : 0, request.id)
      .run();
    const updated = await createInstallationByIdFinder(db)(request.id);
    if (updated === null) {
      throw new Error(`installation ${request.id} was not found after enabled update`);
    }
    return updated;
  };
}

function createInstallationPriorityUpdater(db: D1DatabaseLike) {
  return async (request: { id: string; priority: number }) => {
    await db
      .prepare("UPDATE installations SET priority = ? WHERE id = ?")
      .bind(request.priority, request.id)
      .run();
    const updated = await createInstallationByIdFinder(db)(request.id);
    if (updated === null) {
      throw new Error(`installation ${request.id} was not found after priority update`);
    }
    return updated;
  };
}

function createInstallationVersionUpdater(db: D1DatabaseLike) {
  return async (request: { id: string; pluginVersionId: string }) => {
    await db
      .prepare("UPDATE installations SET plugin_version_id = ? WHERE id = ?")
      .bind(request.pluginVersionId, request.id)
      .run();
    const updated = await createInstallationByIdFinder(db)(request.id);
    if (updated === null) {
      throw new Error(`installation ${request.id} was not found after version update`);
    }
    return updated;
  };
}

function createApprovalByIdFinder(db: D1DatabaseLike) {
  return async (id: string) => {
    const row = await db
      .prepare(
        [
          "SELECT id, tenant_id, plugin_id, role, subject_json, resume_hook, state,",
          "expires_at, created_at, decided_by, decision_reason, decided_at",
          "FROM approvals WHERE id = ?"
        ].join(" ")
      )
      .bind(id)
      .first<ApprovalRow>();

    return row === null ? null : approvalFromRow(row);
  };
}

function createApprovalDecisionUpdater(db: D1DatabaseLike) {
  return async (request: {
    id: string;
    decision: ApprovalDecision;
    decidedBy: string;
    decisionReason?: string;
    decidedAt: Date;
  }) => {
    await db
      .prepare(
        [
          "UPDATE approvals SET state = ?, decided_by = ?, decision_reason = ?, decided_at = ?",
          "WHERE id = ?"
        ].join(" ")
      )
      .bind(
        request.decision,
        request.decidedBy,
        request.decisionReason ?? null,
        request.decidedAt.toISOString(),
        request.id
      )
      .run();
    const updated = await createApprovalByIdFinder(db)(request.id);
    if (updated === null) {
      throw new Error(`approval ${request.id} was not found after decision update`);
    }
    return updated;
  };
}

function createExecutionWriter(db: D1DatabaseLike) {
  return async (record: ExecutionRecord) => {
    await db
      .prepare(
        [
          "INSERT INTO executions",
          "(id, tenant_id, plugin_id, hook_name, version, status, duration_ms, error, capability_calls_json, created_at)",
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ].join(" ")
      )
      .bind(
        record.id,
        record.tenantId,
        record.pluginId,
        record.hookName,
        record.version,
        record.status,
        record.durationMs,
        record.error ?? null,
        JSON.stringify(record.capabilityCalls),
        record.createdAt.toISOString()
      )
      .run();
    return record;
  };
}

function createExecutionSearcher(db: D1DatabaseLike) {
  return async (query: ExecutionSearchQuery) => {
    const rows = await db
      .prepare(
        [
          "SELECT id, tenant_id, plugin_id, hook_name, version, status, duration_ms, error,",
          "capability_calls_json, created_at FROM executions",
          "WHERE (?1 IS NULL OR tenant_id = ?1)",
          "AND (?2 IS NULL OR plugin_id = ?2)",
          "AND (?3 IS NULL OR hook_name = ?3)",
          "AND (?4 IS NULL OR status = ?4)",
          "ORDER BY created_at ASC"
        ].join(" ")
      )
      .bind(
        query.tenantId ?? null,
        query.pluginId ?? null,
        query.hookName ?? null,
        query.status ?? null
      )
      .all();

    return (rows.results as ExecutionRow[]).map(executionFromRow);
  };
}

function createInstallationResolver(db: D1DatabaseLike) {
  return async (params: { tenantId: string; hookName: string }) => {
    const rows = await db
      .prepare(
        [
          "SELECT i.id AS installation_id, i.tenant_id, i.plugin_version_id, i.enabled, i.priority,",
          "i.config_json, i.grants_json, pv.version, pv.manifest_json, p.id AS plugin_id",
          "FROM installations i",
          "LEFT JOIN plugin_versions pv ON pv.id = i.plugin_version_id",
          "LEFT JOIN plugins p ON p.id = pv.plugin_id",
          "WHERE i.tenant_id = ? AND i.enabled = 1",
          "ORDER BY i.priority ASC"
        ].join(" ")
      )
      .bind(params.tenantId)
      .all();

    return (rows.results as ResolvedInstallationRow[])
      .map(resolvedInstallationFromRow)
      .filter((installation) => installation.hooks.includes(params.hookName));
  };
}

export function createR2ArtifactStore(bucket: R2BucketLike) {
  return {
    putArtifact: async (hash: string, content: string | ArrayBuffer | Uint8Array) => {
      if ((await bucket.head(hash)) !== null) {
        throw new ArtifactAlreadyExistsError(`artifact ${hash} already exists`);
      }

      await bucket.put(hash, content);
      return { hash };
    },
    getArtifact: async (hash: string) => {
      const object = await bucket.get(hash);
      if (object === null) {
        return null;
      }

      return object.arrayBuffer();
    }
  };
}

interface ExecutionRow {
  id: string;
  tenant_id: string;
  plugin_id: string;
  hook_name: string;
  version: string;
  status: ExecutionStatus;
  duration_ms: number;
  error: string | null;
  capability_calls_json: string;
  created_at: string;
}

interface PluginRow {
  id: string;
  app_id: string;
  key: string;
}

interface AppRow {
  id: string;
  name: string;
}

interface TenantRow {
  id: string;
  app_id: string;
  name: string;
}

interface PluginVersionRow {
  id: string;
  plugin_id: string;
  version: string;
  artifact_hash: string;
  manifest_json: string;
}

interface InstallationRow {
  id: string;
  tenant_id: string;
  plugin_version_id: string;
  enabled: number;
  priority: number;
  config_json: string;
  grants_json: string;
}

interface ApprovalRow {
  id: string;
  tenant_id: string;
  plugin_id: string;
  role: string;
  subject_json: string;
  resume_hook: string;
  state: ApprovalRecord["state"];
  expires_at: string;
  created_at: string;
  decided_by: string | null;
  decision_reason: string | null;
  decided_at: string | null;
}

interface ResolvedInstallationRow {
  installation_id: string;
  tenant_id: string;
  plugin_version_id: string;
  enabled: number;
  priority: number;
  config_json: string;
  grants_json: string;
  version: string | null;
  manifest_json: string | null;
  plugin_id: string | null;
}

function appFromRow(row: AppRow): AppRecord {
  return {
    id: row.id,
    name: row.name
  };
}

function tenantFromRow(row: TenantRow): TenantRecord {
  return {
    id: row.id,
    appId: row.app_id,
    name: row.name
  };
}

function pluginFromRow(row: PluginRow): PluginRecord {
  return {
    id: row.id,
    appId: row.app_id,
    key: row.key
  };
}

function pluginVersionFromRow(row: PluginVersionRow): PluginVersionRecord {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    version: row.version,
    artifactHash: row.artifact_hash,
    manifest: JSON.parse(row.manifest_json) as TenantScriptManifest
  };
}

function installationFromRow(row: InstallationRow): InstallationRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    pluginVersionId: row.plugin_version_id,
    enabled: row.enabled === 1,
    priority: row.priority,
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    grants: JSON.parse(row.grants_json) as Record<string, unknown>
  };
}

function approvalFromRow(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    pluginId: row.plugin_id,
    role: row.role,
    subject: JSON.parse(row.subject_json) as Record<string, unknown>,
    resumeHook: row.resume_hook,
    state: row.state,
    expiresAt: new Date(row.expires_at),
    createdAt: new Date(row.created_at),
    ...(row.decided_by === null ? {} : { decidedBy: row.decided_by }),
    ...(row.decision_reason === null ? {} : { decisionReason: row.decision_reason }),
    ...(row.decided_at === null ? {} : { decidedAt: new Date(row.decided_at) })
  };
}

function executionFromRow(row: ExecutionRow): ExecutionRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    pluginId: row.plugin_id,
    hookName: row.hook_name,
    version: row.version,
    status: row.status,
    durationMs: row.duration_ms,
    ...(row.error === null ? {} : { error: row.error }),
    capabilityCalls: JSON.parse(row.capability_calls_json) as CapabilityCallRecord[],
    createdAt: new Date(row.created_at)
  };
}

function resolvedInstallationFromRow(row: ResolvedInstallationRow): ResolvedInstallation {
  assertPinnedVersionResolved(row);
  const manifest = JSON.parse(row.manifest_json) as TenantScriptManifest;
  return {
    id: row.installation_id,
    tenantId: row.tenant_id,
    pluginId: row.plugin_id,
    pluginVersionId: row.plugin_version_id,
    enabled: row.enabled === 1,
    priority: row.priority,
    hooks: manifest.hooks.map((hook) => hook.name),
    version: row.version,
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    grants: JSON.parse(row.grants_json) as Record<string, unknown>,
    manifest
  };
}

function assertPinnedVersionResolved(
  row: ResolvedInstallationRow
): asserts row is ResolvedInstallationRow & {
  version: string;
  manifest_json: string;
  plugin_id: string;
} {
  if (row.version === null || row.manifest_json === null || row.plugin_id === null) {
    throw new Error(
      `installation ${row.installation_id} references missing pinned version ${row.plugin_version_id}`
    );
  }
}
