import type { D1DatabaseLike } from "./storage.js";

export interface AdminRollbackRequest {
  appId: string;
  tenantId: string;
  actor: string;
  installationId: string;
  targetVersionId: string;
  expectedRevision: number;
}

export type AdminRollbackResult =
  | {
      outcome: "rolled_back";
      installationId: string;
      pluginKey: string;
      fromVersion: string;
      toVersion: string;
      revision: number;
      auditId: string;
      completedAt: string;
    }
  | { outcome: "conflict"; installationId: string; revision: number }
  | { outcome: "same_version"; installationId: string; revision: number };

export interface AdminRollbackStore {
  rollback: (request: AdminRollbackRequest) => Promise<AdminRollbackResult | null>;
}

export interface D1AdminRollbackStoreOptions {
  auditId?: () => string;
  now?: () => Date;
  beforeWrite?: () => unknown;
}

export function createD1AdminRollbackStore(
  db: D1DatabaseLike,
  options: D1AdminRollbackStoreOptions = {}
): AdminRollbackStore {
  return { rollback: (request) => rollback(db, request, options) };
}

async function rollback(
  db: D1DatabaseLike,
  request: AdminRollbackRequest,
  options: D1AdminRollbackStoreOptions
): Promise<AdminRollbackResult | null> {
  const current = await readRollbackRow(db, request);
  if (current === null) return null;

  const installationId = requiredString(current.installation_id);
  const revision = requiredSafeInteger(current.revision);
  if (request.expectedRevision !== revision) {
    return { outcome: "conflict", installationId, revision };
  }
  if (current.current_version_id === current.target_version_id) {
    return { outcome: "same_version", installationId, revision };
  }

  const auditId = options.auditId?.() ?? `installation-rollback-${crypto.randomUUID()}`;
  const completedAt = (options.now?.() ?? new Date()).toISOString();
  const nextRevision = revision + 1;
  const before = {
    versionId: requiredString(current.current_version_id),
    version: requiredString(current.current_version),
    revision
  };
  const after = {
    versionId: requiredString(current.target_version_id),
    version: requiredString(current.target_version),
    revision: nextRevision
  };
  await options.beforeWrite?.();
  try {
    // The migration trigger applies the version pin CAS within this audit INSERT. D1 has no
    // interactive transaction here, so a single statement is required to prevent false audits.
    await db
      .prepare(
        [
          "INSERT INTO admin_audit_events",
          "(id, installation_id, tenant_id, app_id, plugin_id, revision, actor, action, before_json, after_json, created_at)",
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ].join(" ")
      )
      .bind(
        auditId,
        installationId,
        requiredString(current.tenant_id),
        request.appId,
        requiredString(current.plugin_id),
        nextRevision,
        request.actor,
        "installation.rollback",
        JSON.stringify(before),
        JSON.stringify(after),
        completedAt
      )
      .run();
  } catch (error) {
    const latest = await readRollbackRow(db, request);
    if (latest !== null && requiredSafeInteger(latest.revision) !== request.expectedRevision) {
      return {
        outcome: "conflict",
        installationId: requiredString(latest.installation_id),
        revision: requiredSafeInteger(latest.revision)
      };
    }
    throw error;
  }

  return {
    outcome: "rolled_back",
    installationId,
    pluginKey: requiredString(current.plugin_key),
    fromVersion: before.version,
    toVersion: after.version,
    revision: nextRevision,
    auditId,
    completedAt
  };
}

function readRollbackRow(
  db: D1DatabaseLike,
  request: Pick<AdminRollbackRequest, "appId" | "tenantId" | "installationId" | "targetVersionId">
): Promise<RollbackRow | null> {
  return db
    .prepare(
      [
        "SELECT i.id AS installation_id, i.tenant_id, p.id AS plugin_id, p.key AS plugin_key,",
        "current.id AS current_version_id, current.version AS current_version,",
        "target.id AS target_version_id, target.version AS target_version, i.revision",
        "FROM installations i",
        "JOIN tenants t ON t.id = i.tenant_id",
        "JOIN plugin_versions current ON current.id = i.plugin_version_id",
        "JOIN plugins p ON p.id = current.plugin_id",
        "JOIN plugin_versions target ON target.id = ?4 AND target.plugin_id = p.id",
        "WHERE t.id = ?1 AND t.app_id = ?2 AND p.app_id = t.app_id AND i.id = ?3"
      ].join(" ")
    )
    .bind(request.tenantId, request.appId, request.installationId, request.targetVersionId)
    .first<RollbackRow>();
}

interface RollbackRow {
  installation_id: unknown;
  tenant_id: unknown;
  plugin_id: unknown;
  plugin_key: unknown;
  current_version_id: unknown;
  current_version: unknown;
  target_version_id: unknown;
  target_version: unknown;
  revision: unknown;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("invalid rollback row");
  return value;
}

function requiredSafeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid rollback row");
  }
  return value;
}
