DROP TRIGGER IF EXISTS approval_audit_events_apply_decision;

-- Keep the database authorization boundary aligned with the runtime RBAC evaluator. The
-- Phase 1 `manager` requirement accepts every role that owns approval:decide, while future
-- canonical role requirements stay exact after normalizing the compatibility alias.
CREATE TRIGGER approval_audit_events_apply_decision
BEFORE INSERT ON approval_audit_events
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM approvals a
    JOIN tenants t ON t.id = a.tenant_id
    JOIN plugins p ON p.id = a.plugin_id
    WHERE a.id = NEW.approval_id
      AND a.tenant_id = NEW.tenant_id
      AND t.app_id = NEW.app_id
      AND p.app_id = t.app_id
      AND p.id = NEW.plugin_id
      AND a.state = 'pending'
      AND NEW.actor_role IN ('owner', 'admin', 'tenant-admin', 'manager')
      AND (
        a.role = 'manager'
        OR CASE WHEN NEW.actor_role = 'manager' THEN 'admin' ELSE NEW.actor_role END
           = CASE WHEN a.role = 'manager' THEN 'admin' ELSE a.role END
      )
      AND a.expires_at > NEW.created_at
  ) THEN RAISE(ABORT, 'approval decision conflict') END;

  UPDATE approvals
  SET state = NEW.decision,
      decided_by = NEW.actor,
      decision_reason = NEW.reason,
      decided_at = NEW.created_at
  WHERE id = NEW.approval_id
    AND tenant_id = NEW.tenant_id
    AND plugin_id = NEW.plugin_id
    AND state = 'pending'
    AND EXISTS (
      SELECT 1
      FROM tenants t
      JOIN plugins p ON p.id = approvals.plugin_id
      WHERE t.id = approvals.tenant_id
        AND t.app_id = NEW.app_id
        AND p.app_id = t.app_id
        AND NEW.actor_role IN ('owner', 'admin', 'tenant-admin', 'manager')
        AND (
          approvals.role = 'manager'
          OR CASE WHEN NEW.actor_role = 'manager' THEN 'admin' ELSE NEW.actor_role END
             = CASE WHEN approvals.role = 'manager' THEN 'admin' ELSE approvals.role END
        )
    )
    AND expires_at > NEW.created_at;

  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'approval decision conflict') END;
END;
