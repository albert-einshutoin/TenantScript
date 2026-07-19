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
