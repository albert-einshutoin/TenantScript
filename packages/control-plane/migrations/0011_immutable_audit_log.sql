CREATE TABLE IF NOT EXISTS audit_chain_heads (
  tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  next_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_sequence >= 1),
  last_event_hash TEXT NOT NULL CHECK(length(last_event_hash) = 64),
  PRIMARY KEY (tenant_id, app_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES tenants(id, app_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object'),
  previous_hash TEXT NOT NULL CHECK(length(previous_hash) = 64),
  event_hash TEXT NOT NULL CHECK(length(event_hash) = 64),
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, app_id, sequence),
  FOREIGN KEY (tenant_id, app_id) REFERENCES tenants(id, app_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_audit_events_scope_created
  ON audit_events(tenant_id, app_id, created_at, sequence);

-- The head is mutable coordination state, not audit evidence. Checking and advancing it inside
-- the INSERT transaction prevents two concurrent writers from creating valid-looking forks.
CREATE TRIGGER IF NOT EXISTS audit_events_validate_chain
BEFORE INSERT ON audit_events
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM audit_chain_heads h
    WHERE h.tenant_id = NEW.tenant_id
      AND h.app_id = NEW.app_id
      AND h.next_sequence = NEW.sequence
      AND h.last_event_hash = NEW.previous_hash
  ) THEN RAISE(ABORT, 'audit chain conflict') END;
END;

CREATE TRIGGER IF NOT EXISTS audit_events_advance_chain
AFTER INSERT ON audit_events
BEGIN
  UPDATE audit_chain_heads
  SET next_sequence = NEW.sequence + 1,
      last_event_hash = NEW.event_hash
  WHERE tenant_id = NEW.tenant_id
    AND app_id = NEW.app_id
    AND next_sequence = NEW.sequence
    AND last_event_hash = NEW.previous_hash;

  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'audit chain conflict') END;
END;

CREATE TRIGGER IF NOT EXISTS audit_events_reject_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'immutable audit event');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_reject_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'immutable audit event');
END;

CREATE TRIGGER IF NOT EXISTS admin_audit_events_reject_update
BEFORE UPDATE ON admin_audit_events
BEGIN
  SELECT RAISE(ABORT, 'immutable audit event');
END;

CREATE TRIGGER IF NOT EXISTS admin_audit_events_reject_delete
BEFORE DELETE ON admin_audit_events
BEGIN
  SELECT RAISE(ABORT, 'immutable audit event');
END;

CREATE TRIGGER IF NOT EXISTS approval_audit_events_reject_update
BEFORE UPDATE ON approval_audit_events
BEGIN
  SELECT RAISE(ABORT, 'immutable audit event');
END;

CREATE TRIGGER IF NOT EXISTS approval_audit_events_reject_delete
BEFORE DELETE ON approval_audit_events
BEGIN
  SELECT RAISE(ABORT, 'immutable audit event');
END;

CREATE TRIGGER IF NOT EXISTS installation_request_audit_events_reject_update
BEFORE UPDATE ON installation_request_audit_events
BEGIN
  SELECT RAISE(ABORT, 'immutable audit event');
END;

CREATE TRIGGER IF NOT EXISTS installation_request_audit_events_reject_delete
BEFORE DELETE ON installation_request_audit_events
BEGIN
  SELECT RAISE(ABORT, 'immutable audit event');
END;
