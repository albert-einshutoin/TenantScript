CREATE TABLE IF NOT EXISTS execution_archives (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  from_at TEXT NOT NULL,
  to_at TEXT NOT NULL CHECK(to_at >= from_at),
  event_count INTEGER NOT NULL CHECK(event_count > 0),
  content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES tenants(id, app_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_execution_archives_scope_range
  ON execution_archives(tenant_id, app_id, from_at, to_at);

CREATE TRIGGER IF NOT EXISTS execution_archives_reject_update
BEFORE UPDATE ON execution_archives
BEGIN
  SELECT RAISE(ABORT, 'immutable execution archive');
END;

CREATE TRIGGER IF NOT EXISTS execution_archives_reject_delete
BEFORE DELETE ON execution_archives
BEGIN
  SELECT RAISE(ABORT, 'immutable execution archive');
END;
