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
