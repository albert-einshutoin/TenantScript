import {
  AdminInstallFlowError,
  resolveAdminInstallProposal,
  type AdminInstallRequest
} from "./admin-install-flow.js";
import { adminIdempotencyExpiry, adminRequestFingerprint } from "./admin-idempotency.js";
import type { D1DatabaseLike, D1PreparedStatementLike } from "./storage.js";

export interface AdminInstallRequestResult {
  approvalId: string;
  state: "pending";
  pluginKey: string;
  version: string;
  capabilities: readonly string[];
  expiresAt: string;
}

export interface AdminInstallRequestStore {
  requestInstallation(request: AdminInstallRequest): Promise<AdminInstallRequestResult | null>;
}

export function createD1AdminInstallRequestStore(
  db: D1DatabaseLike,
  options: {
    approvalId?: () => string;
    installationId?: () => string;
    auditId?: () => string;
    now?: () => Date;
  } = {}
): AdminInstallRequestStore {
  return {
    requestInstallation: (request) => requestInstallation(db, request, options)
  };
}

async function requestInstallation(
  db: D1DatabaseLike,
  request: AdminInstallRequest,
  options: {
    approvalId?: () => string;
    installationId?: () => string;
    auditId?: () => string;
    now?: () => Date;
  }
): Promise<AdminInstallRequestResult | null> {
  const now = options.now?.() ?? new Date();
  const requestHash = await installationRequestHash(request);
  const replay = await readIdempotencyRecord(db, request, now);
  if (replay !== null) return resolveReplay(replay, requestHash);
  const proposal = await resolveAdminInstallProposal(db, request);
  if (proposal === null) return null;

  const approvalId = options.approvalId?.() ?? `installation-approval-${crypto.randomUUID()}`;
  const installationId =
    options.installationId?.() ?? `approved-installation-${crypto.randomUUID()}`;
  const auditId = options.auditId?.() ?? `installation-request-${crypto.randomUUID()}`;
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const result: AdminInstallRequestResult = {
    approvalId,
    state: "pending",
    pluginKey: proposal.pluginKey,
    version: proposal.version,
    capabilities: proposal.capabilities,
    expiresAt
  };
  const capabilitiesJson = JSON.stringify(proposal.capabilities);
  const statements = [
    db
      .prepare(
        `DELETE FROM installation_request_idempotency
          WHERE app_id = ? AND tenant_id = ? AND idempotency_key = ? AND expires_at <= ?`
      )
      .bind(request.appId, request.tenantId, request.idempotencyKey, createdAt),
    db
      .prepare(
        `INSERT INTO approvals
          (id, tenant_id, plugin_id, role, subject_json, resume_hook, state, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        approvalId,
        request.tenantId,
        proposal.pluginId,
        "admin",
        JSON.stringify({
          kind: "installation",
          versionId: proposal.versionId,
          capabilities: proposal.capabilities
        }),
        "installation.request",
        "pending",
        expiresAt,
        createdAt
      ),
    db
      .prepare(
        `INSERT INTO installation_grant_requests
          (approval_id, app_id, tenant_id, plugin_id, version_id, installation_id,
           requested_by, config_json, grants_json, capabilities_json, enabled, priority, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        approvalId,
        request.appId,
        request.tenantId,
        proposal.pluginId,
        proposal.versionId,
        installationId,
        request.actor,
        JSON.stringify(proposal.config),
        JSON.stringify(proposal.grants),
        capabilitiesJson,
        request.enabled ? 1 : 0,
        request.priority,
        createdAt
      ),
    db
      .prepare(
        `INSERT INTO installation_request_audit_events
          (id, approval_id, app_id, tenant_id, plugin_id, version_id, actor,
           capabilities_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        auditId,
        approvalId,
        request.appId,
        request.tenantId,
        proposal.pluginId,
        proposal.versionId,
        request.actor,
        capabilitiesJson,
        createdAt
      ),
    db
      .prepare(
        `INSERT INTO installation_request_idempotency
          (app_id, tenant_id, idempotency_key, actor, request_hash, result_json,
           created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        request.appId,
        request.tenantId,
        request.idempotencyKey,
        request.actor,
        requestHash,
        JSON.stringify(result),
        createdAt,
        adminIdempotencyExpiry(now)
      )
  ];

  try {
    // Approval, normalized grants, safe audit metadata, and idempotency evidence are one unit.
    // A partial request could otherwise be approved without the exact grant proposal reviewed.
    await requireBatch(db)(statements);
    return result;
  } catch (error) {
    const winner = await readIdempotencyRecord(db, request, now);
    if (winner !== null) return resolveReplay(winner, requestHash);
    throw error;
  }
}

interface RequestIdempotencyRow {
  request_hash: string;
  result_json: string;
  expires_at: string;
}

async function readIdempotencyRecord(
  db: D1DatabaseLike,
  request: AdminInstallRequest,
  now: Date
): Promise<RequestIdempotencyRow | null> {
  const row = await db
    .prepare(
      `SELECT request_hash, result_json, expires_at
         FROM installation_request_idempotency
        WHERE app_id = ? AND tenant_id = ? AND idempotency_key = ?`
    )
    .bind(request.appId, request.tenantId, request.idempotencyKey)
    .first<RequestIdempotencyRow>();
  return row !== null && Date.parse(row.expires_at) > now.getTime() ? row : null;
}

function resolveReplay(row: RequestIdempotencyRow, requestHash: string): AdminInstallRequestResult {
  if (row.request_hash !== requestHash) {
    throw new AdminInstallFlowError("idempotency_key_reused");
  }
  const result: unknown = JSON.parse(row.result_json);
  if (!isRequestResult(result)) throw new Error("invalid installation request idempotency record");
  return result;
}

async function installationRequestHash(request: AdminInstallRequest): Promise<string> {
  return adminRequestFingerprint({
    versionId: request.versionId,
    config: Object.fromEntries(
      Object.entries(request.config).sort(([left], [right]) => left.localeCompare(right))
    ),
    confirmedCapabilities: [...request.confirmedCapabilities].sort(),
    enabled: request.enabled,
    priority: request.priority
  });
}

function isRequestResult(value: unknown): value is AdminInstallRequestResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Partial<AdminInstallRequestResult>;
  return (
    Object.keys(value).length === 6 &&
    typeof result.approvalId === "string" &&
    result.state === "pending" &&
    typeof result.pluginKey === "string" &&
    typeof result.version === "string" &&
    Array.isArray(result.capabilities) &&
    result.capabilities.every((capability) => typeof capability === "string") &&
    typeof result.expiresAt === "string" &&
    Number.isFinite(Date.parse(result.expiresAt))
  );
}

function requireBatch(
  db: D1DatabaseLike
): (statements: D1PreparedStatementLike[]) => Promise<unknown> {
  const candidate = db as D1DatabaseLike & {
    batch?: (statements: D1PreparedStatementLike[]) => Promise<unknown>;
  };
  if (candidate.batch === undefined) throw new Error("D1 batch is unavailable");
  return candidate.batch.bind(candidate);
}
