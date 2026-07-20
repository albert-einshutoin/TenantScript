CREATE TABLE usage_daily_summaries (
  tenant_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  executions INTEGER NOT NULL DEFAULT 0 CHECK (executions >= 0),
  cpu_ms REAL NOT NULL DEFAULT 0 CHECK (cpu_ms >= 0),
  subrequests INTEGER NOT NULL DEFAULT 0 CHECK (subrequests >= 0),
  workflow_runs INTEGER NOT NULL DEFAULT 0 CHECK (workflow_runs >= 0),
  PRIMARY KEY (tenant_id, plugin_id, usage_date)
);

CREATE INDEX idx_usage_daily_summaries_tenant_date_plugin
  ON usage_daily_summaries (tenant_id, usage_date, plugin_id);
