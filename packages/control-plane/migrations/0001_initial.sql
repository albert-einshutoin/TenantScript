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
