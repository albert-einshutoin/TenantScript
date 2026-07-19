import type { D1DatabaseLike } from "./storage.js";
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
  options: { auditId?: () => string; now?: () => Date } = {}
): AdminApprovalDecisionStore {
  return {
    decide: (request) => decide(db, request, options)
  };
}

async function decide(
  db: D1DatabaseLike,
  request: AdminApprovalDecisionRequest,
  options: { auditId?: () => string; now?: () => Date }
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

  try {
    // The trigger applies the state transition before this INSERT commits. Keeping the mutation
    // and its audit in one statement prevents concurrent managers from both receiving success.
    await db
      .prepare(
        [
          "INSERT INTO approval_audit_events",
          "(id, approval_id, tenant_id, app_id, plugin_id, actor, actor_role, decision, reason, created_at)",
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ].join(" ")
      )
      .bind(
        auditId,
        request.approvalId,
        request.tenantId,
        request.appId,
        approval.pluginId,
        request.actor,
        request.actorRole,
        request.decision,
        request.reason ?? null,
        decidedAt
      )
      .run();
  } catch (error) {
    const current = await readApproval(db, request);
    if (current !== null && current.state !== "pending") {
      throw new AdminApprovalDecisionError(409, "approval_already_decided");
    }
    throw error;
  }

  return { approvalId: request.approvalId, state: request.decision, auditId, decidedAt };
}

function canDecideApproval(actorRole: string, requiredRole: string): boolean {
  if (!canRolePerform(actorRole, "approval:decide")) return false;
  // Existing rows require the Phase 1 `manager` role. The RBAC matrix supersedes that claim,
  // while future explicit role requirements remain exact to avoid silently widening authority.
  return (
    requiredRole === "manager" || normalizeRbacRole(actorRole) === normalizeRbacRole(requiredRole)
  );
}

async function readApproval(
  db: D1DatabaseLike,
  request: Pick<AdminApprovalDecisionRequest, "appId" | "tenantId" | "approvalId">
): Promise<ApprovalDecisionRow | null> {
  const row = await db
    .prepare(
      [
        "SELECT a.plugin_id, a.role, a.state, a.expires_at",
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
    typeof row.expires_at !== "string"
  ) {
    throw new Error("invalid approval decision row");
  }
  return {
    pluginId: row.plugin_id,
    role: row.role,
    state: row.state,
    expiresAt: row.expires_at
  };
}

interface ApprovalDecisionRow {
  pluginId: string;
  role: string;
  state: string;
  expiresAt: string;
}
