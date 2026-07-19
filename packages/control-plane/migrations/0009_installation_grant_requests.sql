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
