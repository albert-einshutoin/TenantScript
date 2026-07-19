CREATE TABLE IF NOT EXISTS approval_audit_events (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE RESTRICT,
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE RESTRICT,
  actor TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(approval_id)
);

CREATE INDEX IF NOT EXISTS idx_approval_audit_events_tenant_created
  ON approval_audit_events(tenant_id, created_at);

-- The audit INSERT is the transaction boundary. Validation and the pending -> decided
-- transition happen in this trigger so a concurrent decision can never create false history.
CREATE TRIGGER IF NOT EXISTS approval_audit_events_apply_decision
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
      AND a.role = NEW.actor_role
      AND NEW.actor_role = 'manager'
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
    AND role = NEW.actor_role
    AND expires_at > NEW.created_at;

  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'approval decision conflict') END;
END;
