import type { D1DatabaseLike, D1PreparedStatementLike } from "./storage.js";
import { canRolePerform, normalizeRbacRole } from "./rbac.js";

export interface AdminApprovalDecisionRequest {
  appId: string;
  tenantId: string;
  actor: string;
  actorRole: string;
  approvalId: string;
  decision: "approved" | "rejected";
  reason?: string;
}

export interface AdminApprovalDecisionResult {
  approvalId: string;
  state: "approved" | "rejected";
  auditId: string;
  decidedAt: string;
  installation?: {
    id: string;
    versionId: string;
    pluginKey: string;
    version: string;
    enabled: boolean;
    priority: number;
    revision: 0;
  };
}

export interface AdminApprovalDecisionStore {
  decide: (request: AdminApprovalDecisionRequest) => Promise<AdminApprovalDecisionResult>;
}

export class AdminApprovalDecisionError extends Error {
  override readonly name = "AdminApprovalDecisionError";

  constructor(
    readonly status: 403 | 404 | 409,
    readonly code:
      | "approval_not_found"
      | "approval_role_forbidden"
      | "approval_expired"
      | "approval_already_decided"
  ) {
    super(code);
  }
}

export function createD1AdminApprovalDecisionStore(
  db: D1DatabaseLike,
  options: { auditId?: () => string; installationAuditId?: () => string; now?: () => Date } = {}
): AdminApprovalDecisionStore {
  return {
    decide: (request) => decide(db, request, options)
  };
}

async function decide(
  db: D1DatabaseLike,
  request: AdminApprovalDecisionRequest,
  options: { auditId?: () => string; installationAuditId?: () => string; now?: () => Date }
): Promise<AdminApprovalDecisionResult> {
  const approval = await readApproval(db, request);
  if (approval === null) throw new AdminApprovalDecisionError(404, "approval_not_found");
  if (!canDecideApproval(request.actorRole, approval.role)) {
    throw new AdminApprovalDecisionError(403, "approval_role_forbidden");
  }
  if (approval.state !== "pending") {
    throw new AdminApprovalDecisionError(409, "approval_already_decided");
  }
  const decidedAt = (options.now?.() ?? new Date()).toISOString();
  if (approval.expiresAt <= decidedAt) {
    throw new AdminApprovalDecisionError(409, "approval_expired");
  }
  const auditId = options.auditId?.() ?? `approval-decision-${crypto.randomUUID()}`;
  const installationRequest =
    request.decision === "approved" && approval.resumeHook === "installation.request"
      ? await readInstallationRequest(db, request)
      : null;
  if (
    request.decision === "approved" &&
    approval.resumeHook === "installation.request" &&
    installationRequest === null
  ) {
    throw new Error("installation approval request unavailable");
  }

  try {
    const approvalAudit = approvalAuditStatement(
      db,
      request,
      approval.pluginId,
      auditId,
      decidedAt
    );
    if (installationRequest === null) {
      // The trigger applies the state transition before this INSERT commits. Keeping the mutation
      // and its audit in one statement prevents concurrent managers from both receiving success.
      await approvalAudit.run();
    } else {
      const installationAuditId =
        options.installationAuditId?.() ?? `approved-installation-${crypto.randomUUID()}`;
      const statements = approvedInstallationStatements(
        db,
        request,
        installationRequest,
        installationAuditId,
        decidedAt,
        approvalAudit
      );
      // D1 batch makes the reviewed grant, installation, installation audit, and approval audit
      // indivisible. A raced or failed approval cannot leave an unapproved capability grant live.
      await requireBatch(db)(statements);
    }
  } catch (error) {
    const current = await readApproval(db, request);
    if (current !== null && current.state !== "pending") {
      throw new AdminApprovalDecisionError(409, "approval_already_decided");
    }
    throw error;
  }

  return {
    approvalId: request.approvalId,
    state: request.decision,
    auditId,
    decidedAt,
    ...(installationRequest === null
      ? {}
      : {
          installation: {
            id: installationRequest.installationId,
            versionId: installationRequest.versionId,
            pluginKey: installationRequest.pluginKey,
            version: installationRequest.version,
            enabled: installationRequest.enabled,
            priority: installationRequest.priority,
            revision: 0 as const
          }
        })
  };
}

function approvalAuditStatement(
  db: D1DatabaseLike,
  request: AdminApprovalDecisionRequest,
  pluginId: string,
  auditId: string,
  decidedAt: string
): D1PreparedStatementLike {
  return db
    .prepare(
      `INSERT INTO approval_audit_events
        (id, approval_id, tenant_id, app_id, plugin_id, actor, actor_role,
         decision, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      auditId,
      request.approvalId,
      request.tenantId,
      request.appId,
      pluginId,
      request.actor,
      request.actorRole,
      request.decision,
      request.reason ?? null,
      decidedAt
    );
}

function approvedInstallationStatements(
  db: D1DatabaseLike,
  request: AdminApprovalDecisionRequest,
  installation: InstallationRequestRow,
  auditId: string,
  decidedAt: string,
  approvalAudit: D1PreparedStatementLike
): D1PreparedStatementLike[] {
  return [
    db
      .prepare(
        `INSERT INTO installations
          (id, tenant_id, plugin_version_id, enabled, priority, config_json, grants_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        installation.installationId,
        request.tenantId,
        installation.versionId,
        installation.enabled ? 1 : 0,
        installation.priority,
        JSON.stringify(installation.config),
        JSON.stringify(installation.grants)
      ),
    db
      .prepare(
        `INSERT INTO admin_audit_events
          (id, installation_id, tenant_id, app_id, plugin_id, revision, actor,
           action, before_json, after_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        auditId,
        installation.installationId,
        request.tenantId,
        request.appId,
        installation.pluginId,
        0,
        request.actor,
        "installation.install.approved",
        "{}",
        JSON.stringify({
          enabled: installation.enabled,
          priority: installation.priority,
          revision: 0,
          configFields: Object.keys(installation.config).sort(),
          capabilities: installation.capabilities
        }),
        decidedAt
      ),
    approvalAudit
  ];
}

function canDecideApproval(actorRole: string, requiredRole: string): boolean {
  if (!canRolePerform(actorRole, "approval:decide")) return false;
  // `manager` and canonical `admin` represent the grant-approval threshold, not an exact claim.
  // Tenant scope is already identity-derived, so owner/admin/tenant-admin can satisfy it while
  // narrower or specialized future requirements remain exact after alias normalization.
  const required = normalizeRbacRole(requiredRole);
  return required === "admin" || normalizeRbacRole(actorRole) === required;
}

async function readApproval(
  db: D1DatabaseLike,
  request: Pick<AdminApprovalDecisionRequest, "appId" | "tenantId" | "approvalId">
): Promise<ApprovalDecisionRow | null> {
  const row = await db
    .prepare(
      [
        "SELECT a.plugin_id, a.role, a.state, a.expires_at, a.resume_hook",
        "FROM approvals a",
        "JOIN tenants t ON t.id = a.tenant_id",
        "JOIN plugins p ON p.id = a.plugin_id",
        "WHERE a.id = ?1 AND a.tenant_id = ?2 AND t.app_id = ?3 AND p.app_id = t.app_id"
      ].join(" ")
    )
    .bind(request.approvalId, request.tenantId, request.appId)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  if (
    typeof row.plugin_id !== "string" ||
    typeof row.role !== "string" ||
    typeof row.state !== "string" ||
    typeof row.expires_at !== "string" ||
    typeof row.resume_hook !== "string"
  ) {
    throw new Error("invalid approval decision row");
  }
  return {
    pluginId: row.plugin_id,
    role: row.role,
    state: row.state,
    expiresAt: row.expires_at,
    resumeHook: row.resume_hook
  };
}

interface ApprovalDecisionRow {
  pluginId: string;
  role: string;
  state: string;
  expiresAt: string;
  resumeHook: string;
}

interface InstallationRequestRow {
  installationId: string;
  pluginId: string;
  versionId: string;
  pluginKey: string;
  version: string;
  config: Record<string, unknown>;
  grants: Record<string, unknown>;
  capabilities: string[];
  enabled: boolean;
  priority: number;
}

async function readInstallationRequest(
  db: D1DatabaseLike,
  request: Pick<AdminApprovalDecisionRequest, "appId" | "tenantId" | "approvalId">
): Promise<InstallationRequestRow | null> {
  const row = await db
    .prepare(
      `SELECT r.installation_id, r.plugin_id, r.version_id, r.config_json, r.grants_json,
              r.capabilities_json, r.enabled, r.priority, p.key AS plugin_key, pv.version
         FROM installation_grant_requests r
         JOIN tenants t ON t.id = r.tenant_id AND t.app_id = r.app_id
         JOIN plugins p ON p.id = r.plugin_id AND p.app_id = r.app_id
         JOIN plugin_versions pv ON pv.id = r.version_id AND pv.plugin_id = r.plugin_id
        WHERE r.approval_id = ? AND r.app_id = ? AND r.tenant_id = ?`
    )
    .bind(request.approvalId, request.appId, request.tenantId)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  let config: unknown;
  let grants: unknown;
  let capabilities: unknown;
  try {
    config = typeof row.config_json === "string" ? JSON.parse(row.config_json) : null;
    grants = typeof row.grants_json === "string" ? JSON.parse(row.grants_json) : null;
    capabilities =
      typeof row.capabilities_json === "string" ? JSON.parse(row.capabilities_json) : null;
  } catch {
    throw new Error("invalid installation approval request");
  }
  if (
    typeof row.installation_id !== "string" ||
    typeof row.plugin_id !== "string" ||
    typeof row.version_id !== "string" ||
    typeof row.plugin_key !== "string" ||
    typeof row.version !== "string" ||
    !isRecord(config) ||
    !isRecord(grants) ||
    !Array.isArray(capabilities) ||
    !capabilities.every((value) => typeof value === "string") ||
    (row.enabled !== 0 && row.enabled !== 1) ||
    !Number.isSafeInteger(row.priority)
  ) {
    throw new Error("invalid installation approval request");
  }
  return {
    installationId: row.installation_id,
    pluginId: row.plugin_id,
    versionId: row.version_id,
    pluginKey: row.plugin_key,
    version: row.version,
    config,
    grants,
    capabilities,
    enabled: row.enabled === 1,
    priority: row.priority as number
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
