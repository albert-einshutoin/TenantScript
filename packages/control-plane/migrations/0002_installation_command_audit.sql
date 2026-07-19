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
