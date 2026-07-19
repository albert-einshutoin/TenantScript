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
