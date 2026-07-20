-- Immutable synthetic baseline for Issue #231.
-- This snapshot represents migrations 0001 through 0010 as deployed before the
-- pre-v1 upgrade contract was introduced. Do not edit it when adding migrations;
-- create a new versioned baseline after a real release instead.
-- Snapshot source: 0001_initial.sql
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(app_id, key)
);

CREATE TABLE IF NOT EXISTS plugin_versions (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(plugin_id, version)
);

CREATE TABLE IF NOT EXISTS installations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plugin_version_id TEXT NOT NULL REFERENCES plugin_versions(id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  config_json TEXT NOT NULL,
  grants_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_installations_tenant_enabled
  ON installations(tenant_id, enabled, priority);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  subject_json TEXT NOT NULL,
  resume_hook TEXT NOT NULL,
  state TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decision_reason TEXT,
  decided_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_tenant_state
  ON approvals(tenant_id, state, expires_at);

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  hook_name TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  error TEXT,
  capability_calls_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_executions_search
  ON executions(tenant_id, plugin_id, hook_name, status, created_at);

CREATE TABLE IF NOT EXISTS slack_connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  workspace_name TEXT,
  bot_user_id TEXT,
  secret_ref_json TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  UNIQUE(tenant_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_connections_tenant
  ON slack_connections(tenant_id, workspace_id);

-- Snapshot source: 0002_installation_command_audit.sql
ALTER TABLE installations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS admin_audit_events (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE RESTRICT,
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(installation_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_events_tenant_created
  ON admin_audit_events(tenant_id, created_at);

-- The audit INSERT is the command's single D1 statement. Applying its CAS here keeps the
-- installation mutation and audit record atomic even if another existing writer runs after
-- the command's pre-read; a zero-row update aborts the INSERT instead of creating false history.
CREATE TRIGGER IF NOT EXISTS admin_audit_events_apply_installation_command
BEFORE INSERT ON admin_audit_events
WHEN NEW.action = 'installation.command'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM installations i
    JOIN tenants t ON t.id = i.tenant_id
    JOIN plugin_versions pv ON pv.id = i.plugin_version_id
    JOIN plugins p ON p.id = pv.plugin_id
    WHERE i.id = NEW.installation_id
      AND i.tenant_id = NEW.tenant_id
      AND t.app_id = NEW.app_id
      AND p.app_id = t.app_id
      AND pv.plugin_id = NEW.plugin_id
      AND i.revision = NEW.revision - 1
      AND i.enabled = CAST(json_extract(NEW.before_json, '$.enabled') AS INTEGER)
      AND i.priority = json_extract(NEW.before_json, '$.priority')
      AND i.revision = json_extract(NEW.before_json, '$.revision')
      AND NEW.revision = json_extract(NEW.after_json, '$.revision')
  ) THEN RAISE(ABORT, 'installation command conflict') END;

  UPDATE installations
  SET enabled = CAST(json_extract(NEW.after_json, '$.enabled') AS INTEGER),
      priority = json_extract(NEW.after_json, '$.priority'),
      revision = NEW.revision
  WHERE id = NEW.installation_id
    AND tenant_id = NEW.tenant_id
    AND revision = NEW.revision - 1
    AND enabled = CAST(json_extract(NEW.before_json, '$.enabled') AS INTEGER)
    AND priority = json_extract(NEW.before_json, '$.priority')
    AND EXISTS (
      SELECT 1
      FROM tenants t
      JOIN plugin_versions pv ON pv.id = installations.plugin_version_id
      JOIN plugins p ON p.id = pv.plugin_id
      WHERE t.id = installations.tenant_id
        AND t.app_id = NEW.app_id
        AND p.app_id = t.app_id
        AND pv.plugin_id = NEW.plugin_id
    );

  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'installation command conflict') END;
END;

-- Snapshot source: 0003_installation_rollback_audit.sql
-- Rollback uses the audit INSERT as its transaction boundary. This trigger validates the
-- tenant/app/plugin relation and revision CAS before moving the version pin atomically.
CREATE TRIGGER IF NOT EXISTS admin_audit_events_apply_installation_rollback
BEFORE INSERT ON admin_audit_events
WHEN NEW.action = 'installation.rollback'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM installations i
    JOIN tenants t ON t.id = i.tenant_id
    JOIN plugin_versions current ON current.id = i.plugin_version_id
    JOIN plugins p ON p.id = current.plugin_id
    JOIN plugin_versions target
      ON target.id = json_extract(NEW.after_json, '$.versionId')
     AND target.plugin_id = p.id
    WHERE i.id = NEW.installation_id
      AND i.tenant_id = NEW.tenant_id
      AND t.app_id = NEW.app_id
      AND p.app_id = t.app_id
      AND p.id = NEW.plugin_id
      AND current.id = json_extract(NEW.before_json, '$.versionId')
      AND current.version = json_extract(NEW.before_json, '$.version')
      AND target.version = json_extract(NEW.after_json, '$.version')
      AND i.revision = NEW.revision - 1
      AND i.revision = json_extract(NEW.before_json, '$.revision')
      AND NEW.revision = json_extract(NEW.after_json, '$.revision')
      AND current.id != target.id
  ) THEN RAISE(ABORT, 'installation rollback conflict') END;

  UPDATE installations
  SET plugin_version_id = json_extract(NEW.after_json, '$.versionId'),
      revision = NEW.revision
  WHERE id = NEW.installation_id
    AND tenant_id = NEW.tenant_id
    AND plugin_version_id = json_extract(NEW.before_json, '$.versionId')
    AND revision = NEW.revision - 1;

  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'installation rollback conflict') END;
END;

-- Snapshot source: 0004_approval_decision_audit.sql
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

-- Snapshot source: 0005_install_idempotency.sql
CREATE TABLE IF NOT EXISTS admin_install_idempotency (
  app_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  actor TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (app_id, tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_install_idempotency_expiry
  ON admin_install_idempotency(expires_at);

-- Snapshot source: 0006_rollback_idempotency.sql
CREATE TABLE IF NOT EXISTS admin_rollback_idempotency (
  app_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (app_id, tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (installation_id) REFERENCES installations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_rollback_idempotency_expiry
  ON admin_rollback_idempotency(expires_at);

-- Snapshot source: 0007_service_tokens.sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_id_app
  ON tenants(id, app_id);

CREATE TABLE IF NOT EXISTS service_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE
    CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 128),
  role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'operator', 'viewer', 'tenant-admin')),
  app_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK(expires_at > created_at),
  revoked_at TEXT CHECK(revoked_at IS NULL OR revoked_at >= created_at),
  revoked_by TEXT,
  CHECK((revoked_at IS NULL) = (revoked_by IS NULL)),
  FOREIGN KEY (tenant_id, app_id) REFERENCES tenants(id, app_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_service_tokens_scope
  ON service_tokens(app_id, tenant_id, id);

-- Snapshot source: 0008_rbac_approval_trigger.sql
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

-- Snapshot source: 0009_installation_grant_requests.sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugins_id_app
  ON plugins(id, app_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_versions_id_plugin
  ON plugin_versions(id, plugin_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_id_tenant_plugin
  ON approvals(id, tenant_id, plugin_id);

CREATE TABLE IF NOT EXISTS installation_grant_requests (
  approval_id TEXT PRIMARY KEY REFERENCES approvals(id) ON DELETE RESTRICT,
  app_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  installation_id TEXT NOT NULL UNIQUE,
  requested_by TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK(json_valid(config_json) AND json_type(config_json) = 'object'),
  grants_json TEXT NOT NULL CHECK(json_valid(grants_json) AND json_type(grants_json) = 'object'),
  capabilities_json TEXT NOT NULL
    CHECK(json_valid(capabilities_json) AND json_type(capabilities_json) = 'array'),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  priority INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES tenants(id, app_id) ON DELETE RESTRICT,
  FOREIGN KEY (plugin_id, app_id) REFERENCES plugins(id, app_id) ON DELETE RESTRICT,
  FOREIGN KEY (version_id, plugin_id) REFERENCES plugin_versions(id, plugin_id) ON DELETE RESTRICT,
  FOREIGN KEY (approval_id, tenant_id, plugin_id)
    REFERENCES approvals(id, tenant_id, plugin_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_installation_grant_requests_scope
  ON installation_grant_requests(app_id, tenant_id, approval_id);

CREATE TABLE IF NOT EXISTS installation_request_audit_events (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL UNIQUE
    REFERENCES installation_grant_requests(approval_id) ON DELETE RESTRICT,
  app_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  capabilities_json TEXT NOT NULL
    CHECK(json_valid(capabilities_json) AND json_type(capabilities_json) = 'array'),
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES tenants(id, app_id) ON DELETE RESTRICT,
  FOREIGN KEY (plugin_id, app_id) REFERENCES plugins(id, app_id) ON DELETE RESTRICT,
  FOREIGN KEY (version_id, plugin_id) REFERENCES plugin_versions(id, plugin_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS installation_request_idempotency (
  app_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  actor TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK(expires_at > created_at),
  PRIMARY KEY (app_id, tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, app_id) REFERENCES tenants(id, app_id) ON DELETE CASCADE
);

-- Snapshot source: 0010_admin_approval_threshold.sql
DROP TRIGGER IF EXISTS approval_audit_events_apply_decision;

-- `admin` is a minimum grant-approval threshold. Every tenant-scoped role with
-- approval:decide may satisfy it; operator/viewer remain denied at the database boundary.
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
        a.role IN ('manager', 'admin')
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
          approvals.role IN ('manager', 'admin')
          OR CASE WHEN NEW.actor_role = 'manager' THEN 'admin' ELSE NEW.actor_role END
             = CASE WHEN approvals.role = 'manager' THEN 'admin' ELSE approvals.role END
        )
    )
    AND expires_at > NEW.created_at;

  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'approval decision conflict') END;
END;

