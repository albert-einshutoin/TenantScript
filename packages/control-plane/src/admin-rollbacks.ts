import type { D1DatabaseLike } from "./storage.js";
import { adminIdempotencyExpiry, adminRequestFingerprint } from "./admin-idempotency.js";

export interface AdminRollbackRequest {
  appId: string;
  tenantId: string;
  actor: string;
  idempotencyKey: string;
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

export class AdminRollbackError extends Error {
  override readonly name = "AdminRollbackError";

  constructor(readonly code: "idempotency_key_reused") {
    super(code);
  }
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
  const now = options.now?.() ?? new Date();
  const requestHash = await rollbackRequestHash(request);
  const replay = await readIdempotencyRecord(db, request, now);
  if (replay !== null) return resolveReplay(replay, requestHash);

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
  const completedAt = now.toISOString();
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
    const result: Extract<AdminRollbackResult, { outcome: "rolled_back" }> = {
      outcome: "rolled_back",
      installationId,
      pluginKey: requiredString(current.plugin_key),
      fromVersion: before.version,
      toVersion: after.version,
      revision: nextRevision,
      auditId,
      completedAt
    };
    await requireBatch(db)([
      db
        .prepare(
          "DELETE FROM admin_rollback_idempotency WHERE app_id = ?1 AND tenant_id = ?2 AND idempotency_key = ?3 AND expires_at <= ?4"
        )
        .bind(request.appId, request.tenantId, request.idempotencyKey, completedAt),
      db
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
        ),
      db
        .prepare(
          [
            "INSERT INTO admin_rollback_idempotency",
            "(app_id, tenant_id, idempotency_key, installation_id, actor, request_hash, result_json, created_at, expires_at)",
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ].join(" ")
        )
        .bind(
          request.appId,
          request.tenantId,
          request.idempotencyKey,
          installationId,
          request.actor,
          requestHash,
          JSON.stringify(result),
          completedAt,
          adminIdempotencyExpiry(now)
        )
    ]);
    return result;
  } catch (error) {
    const winner = await readIdempotencyRecord(db, request, now);
    if (winner !== null) return resolveReplay(winner, requestHash);
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

  throw new Error("unreachable rollback outcome");
}

interface RollbackIdempotencyRow {
  request_hash: string;
  result_json: string;
  expires_at: string;
}

async function readIdempotencyRecord(
  db: D1DatabaseLike,
  request: AdminRollbackRequest,
  now: Date
): Promise<RollbackIdempotencyRow | null> {
  const row = await db
    .prepare(
      "SELECT request_hash, result_json, expires_at FROM admin_rollback_idempotency WHERE app_id = ?1 AND tenant_id = ?2 AND idempotency_key = ?3"
    )
    .bind(request.appId, request.tenantId, request.idempotencyKey)
    .first<RollbackIdempotencyRow>();
  return row !== null && Date.parse(row.expires_at) > now.getTime() ? row : null;
}

function resolveReplay(row: RollbackIdempotencyRow, requestHash: string): AdminRollbackResult {
  if (row.request_hash !== requestHash) throw new AdminRollbackError("idempotency_key_reused");
  const result: unknown = JSON.parse(row.result_json);
  if (!isRolledBackResult(result)) throw new Error("invalid rollback idempotency record");
  return result;
}

async function rollbackRequestHash(request: AdminRollbackRequest): Promise<string> {
  return adminRequestFingerprint({
    installationId: request.installationId,
    targetVersionId: request.targetVersionId,
    expectedRevision: request.expectedRevision
  });
}

function isRolledBackResult(
  value: unknown
): value is Extract<AdminRollbackResult, { outcome: "rolled_back" }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Partial<Extract<AdminRollbackResult, { outcome: "rolled_back" }>>;
  return (
    Object.keys(value).length === 8 &&
    Object.keys(value).every((key) =>
      [
        "outcome",
        "installationId",
        "pluginKey",
        "fromVersion",
        "toVersion",
        "revision",
        "auditId",
        "completedAt"
      ].includes(key)
    ) &&
    result.outcome === "rolled_back" &&
    typeof result.installationId === "string" &&
    typeof result.pluginKey === "string" &&
    typeof result.fromVersion === "string" &&
    typeof result.toVersion === "string" &&
    Number.isSafeInteger(result.revision) &&
    typeof result.auditId === "string" &&
    typeof result.completedAt === "string"
  );
}

function requireBatch(db: D1DatabaseLike) {
  const candidate = db as D1DatabaseLike & {
    batch?: (statements: ReturnType<D1DatabaseLike["prepare"]>[]) => Promise<unknown>;
  };
  if (candidate.batch === undefined) throw new Error("D1 batch is unavailable");
  return candidate.batch.bind(candidate);
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
