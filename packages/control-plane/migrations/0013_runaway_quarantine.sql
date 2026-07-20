CREATE TABLE IF NOT EXISTS installation_runaway_states (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  consecutive_timeouts INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_timeouts >= 0),
  quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0, 1)),
  quarantine_reason TEXT CHECK (
    quarantine_reason IS NULL OR
    quarantine_reason IN ('consecutive_failures', 'consecutive_timeouts')
  ),
  updated_at TEXT NOT NULL
);

-- State transition and installation disable share one SQLite statement through the trigger. This
-- prevents concurrent execution completions from emitting multiple quarantine transitions.
CREATE TRIGGER IF NOT EXISTS installation_runaway_quarantine
AFTER UPDATE OF quarantined ON installation_runaway_states
WHEN NEW.quarantined = 1 AND OLD.quarantined = 0
BEGIN
  UPDATE installations
  SET enabled = 0,
      revision = revision + 1
  WHERE id = NEW.installation_id
    AND enabled = 1;
END;

-- Recovery is explicit and atomic with re-enabling, so stale counters cannot immediately
-- quarantine a manually recovered installation again.
CREATE TRIGGER IF NOT EXISTS installation_runaway_recovery
AFTER UPDATE OF quarantined ON installation_runaway_states
WHEN NEW.quarantined = 0 AND OLD.quarantined = 1
BEGIN
  UPDATE installations
  SET enabled = 1,
      revision = revision + 1
  WHERE id = NEW.installation_id
    AND enabled = 0;
END;
