ALTER TABLE installations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS admin_audit_events (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
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
