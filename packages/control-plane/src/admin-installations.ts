import type { D1DatabaseLike, D1PreparedStatementLike } from "./storage.js";

export interface AdminInstallationDetail {
  id: string;
  pluginKey: string;
  version: string;
  enabled: boolean;
  priority: number;
  configFields: readonly AdminConfigFieldMetadata[];
  capabilities: readonly AdminCapabilityMetadata[];
  egress: AdminEgressMetadata;
}

export interface AdminConfigFieldMetadata {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  configured: boolean;
  hasDefault: boolean;
}

export interface AdminCapabilityMetadata {
  name: string;
  status: "granted" | "missing";
  scopeKeys: readonly string[];
  configReferences: readonly string[];
}

export interface AdminEgressMetadata {
  mode: "deny" | "allowlist";
  allowlistedHostCount: number;
}

export interface AdminInstallationDetailStore {
  readInstallation: (request: {
    appId: string;
    tenantId: string;
    id: string;
  }) => Promise<AdminInstallationDetail | null>;
}

export interface AdminInstallationCommandStore {
  updateInstallation: (request: {
    appId: string;
    tenantId: string;
    actor: string;
    id: string;
    enabled?: boolean;
    priority?: number;
  }) => Promise<AdminInstallationCommandResult | null>;
}

export interface AdminInstallationCommandResult {
  id: string;
  enabled: boolean;
  priority: number;
  /** Internal store-only signal: HTTP intentionally returns the same safe DTO for a no-op. */
  changed: boolean;
}

export interface D1AdminInstallationCommandStoreOptions {
  /** Test seam for a deterministic D1 constraint failure; production IDs use Web Crypto. */
  auditId?: () => string;
}

export function createD1AdminInstallationDetailStore(
  db: D1DatabaseLike
): AdminInstallationDetailStore {
  return { readInstallation: (request) => readInstallation(db, request) };
}

export function createD1AdminInstallationCommandStore(
  db: D1DatabaseLike,
  options: D1AdminInstallationCommandStoreOptions = {}
): AdminInstallationCommandStore {
  const transactionalDb = asBatchDatabase(db);
  return {
    updateInstallation: (request) => updateInstallation(transactionalDb, request, options)
  };
}

async function updateInstallation(
  db: D1BatchDatabase,
  request: {
    appId: string;
    tenantId: string;
    actor: string;
    id: string;
    enabled?: boolean;
    priority?: number;
  },
  options: D1AdminInstallationCommandStoreOptions
): Promise<AdminInstallationCommandResult | null> {
  const current = await db
    .prepare(
      [
        "SELECT i.id, i.enabled, i.priority, i.tenant_id, pv.plugin_id",
        "FROM installations i",
        "JOIN tenants t ON t.id = i.tenant_id",
        "JOIN plugin_versions pv ON pv.id = i.plugin_version_id",
        "JOIN plugins p ON p.id = pv.plugin_id",
        "WHERE t.id = ?1 AND t.app_id = ?2 AND p.app_id = t.app_id AND i.id = ?3"
      ].join(" ")
    )
    .bind(request.tenantId, request.appId, request.id)
    .first<InstallationCommandRow>();
  if (current === null) return null;

  const before = commandState(current);
  const after = {
    enabled: request.enabled ?? before.enabled,
    priority: request.priority ?? before.priority
  };
  if (after.enabled === before.enabled && after.priority === before.priority) {
    return { id: requiredString(current.id, "invalid installation row"), ...after, changed: false };
  }

  const auditId = options.auditId?.() ?? `installation-command-${crypto.randomUUID()}`;
  // D1 batch executes both statements as one transaction. This keeps a successful control-plane
  // mutation from becoming unauditable when the execution-log insert rejects (for example, a
  // unique-ID conflict), while keeping raw config/grant/manifest data out of the audit payload.
  await db.batch([
    db
      .prepare(
        [
          "UPDATE installations SET enabled = ?1, priority = ?2",
          "WHERE id = ?3 AND EXISTS (",
          "SELECT 1 FROM tenants t",
          "JOIN plugin_versions pv ON pv.id = installations.plugin_version_id",
          "JOIN plugins p ON p.id = pv.plugin_id",
          "WHERE t.id = installations.tenant_id AND t.id = ?4 AND t.app_id = ?5 AND p.app_id = t.app_id",
          ")"
        ].join(" ")
      )
      .bind(after.enabled ? 1 : 0, after.priority, request.id, request.tenantId, request.appId),
    db
      .prepare(
        [
          "INSERT INTO executions",
          "(id, tenant_id, plugin_id, hook_name, version, status, duration_ms, error, capability_calls_json, created_at)",
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ].join(" ")
      )
      .bind(
        auditId,
        requiredString(current.tenant_id, "invalid installation row"),
        requiredString(current.plugin_id, "invalid installation row"),
        "installation.command",
        "",
        "success",
        0,
        commandAuditMessage(request.actor, before, after),
        '[{"name":"installations.command","status":"success"}]',
        new Date().toISOString()
      )
  ]);
  return { id: requiredString(current.id, "invalid installation row"), ...after, changed: true };
}

function commandState(row: InstallationCommandRow): { enabled: boolean; priority: number } {
  if (row.enabled !== 0 && row.enabled !== 1) throw new Error("invalid installation row");
  return {
    enabled: row.enabled === 1,
    priority: requiredNumber(row.priority, "invalid installation row")
  };
}

function commandAuditMessage(
  actor: string,
  before: { enabled: boolean; priority: number },
  after: { enabled: boolean; priority: number }
): string {
  return `actor=${actor} old_enabled=${String(before.enabled)} old_priority=${String(before.priority)} new_enabled=${String(after.enabled)} new_priority=${String(after.priority)}`;
}

interface D1BatchDatabase extends D1DatabaseLike {
  batch: (statements: readonly D1PreparedStatementLike[]) => Promise<readonly unknown[]>;
}

function asBatchDatabase(db: D1DatabaseLike): D1BatchDatabase {
  const candidate = db as Partial<D1BatchDatabase>;
  if (typeof candidate.batch !== "function") {
    throw new Error("D1 batch is required for installation command audit atomicity");
  }
  return candidate as D1BatchDatabase;
}

async function readInstallation(
  db: D1DatabaseLike,
  request: { appId: string; tenantId: string; id: string }
): Promise<AdminInstallationDetail | null> {
  const row = await db
    .prepare(
      [
        "SELECT i.id, p.key AS plugin_key, pv.version, i.enabled, i.priority,",
        "i.config_json, i.grants_json, pv.manifest_json",
        "FROM installations i",
        "JOIN tenants t ON t.id = i.tenant_id",
        "JOIN plugin_versions pv ON pv.id = i.plugin_version_id",
        "JOIN plugins p ON p.id = pv.plugin_id",
        // Tenant and plugin ownership are both checked because the schema has independent FKs
        // but cannot express that both sides of an installation belong to the same app.
        "WHERE t.id = ?1 AND t.app_id = ?2 AND p.app_id = t.app_id AND i.id = ?3"
      ].join(" ")
    )
    .bind(request.tenantId, request.appId, request.id)
    .first<InstallationDetailRow>();
  if (row === null) {
    return null;
  }

  const config = parseRecord(row.config_json, "invalid installation config");
  const grants = parseRecord(row.grants_json, "invalid installation grants");
  const manifest = parseRecord(row.manifest_json, "invalid installation manifest");
  const configSchema = requiredRecord(manifest.configSchema, "invalid installation manifest");
  const properties = requiredRecord(configSchema.properties, "invalid installation manifest");
  const required = requiredStringArray(configSchema.required, "invalid installation manifest");
  const capabilities = requiredRecord(manifest.capabilities, "invalid installation manifest");

  // This is deliberately a projection rather than reusing the mutation store: it keeps values
  // such as config, grants and manifests at the D1 boundary, where accidental UI exposure is harder.
  return {
    id: requiredString(row.id, "invalid installation row"),
    pluginKey: requiredString(row.plugin_key, "invalid installation row"),
    version: requiredString(row.version, "invalid installation row"),
    enabled: row.enabled === 1,
    priority: requiredNumber(row.priority, "invalid installation row"),
    configFields: Object.entries(properties)
      .map(([name, value]) => configField(name, value, required, config))
      .sort((left, right) => left.name.localeCompare(right.name)),
    capabilities: Object.entries(capabilities)
      .map(([name, value]) => capability(name, value, grants))
      .sort((left, right) => left.name.localeCompare(right.name)),
    egress: egressMetadata(manifest.egress)
  };
}

function configField(
  name: string,
  value: unknown,
  required: readonly string[],
  config: Record<string, unknown>
): AdminConfigFieldMetadata {
  const field = requiredRecord(value, "invalid installation manifest");
  const type = field.type;
  if (type !== "string" && type !== "number" && type !== "boolean") {
    throw new Error("invalid installation manifest");
  }
  return {
    name,
    type,
    required: required.includes(name),
    configured: Object.hasOwn(config, name),
    hasDefault: Object.hasOwn(field, "default")
  };
}

function capability(
  name: string,
  value: unknown,
  grants: Record<string, unknown>
): AdminCapabilityMetadata {
  const requestedScope = requiredRecord(value, "invalid installation manifest");
  return {
    name,
    status: Object.hasOwn(grants, name) ? "granted" : "missing",
    scopeKeys: Object.keys(requestedScope).sort(),
    configReferences: findConfigReferences(requestedScope)
  };
}

function egressMetadata(value: unknown): AdminEgressMetadata {
  const egress = requiredRecord(value, "invalid installation manifest");
  if (egress.mode === "deny") {
    return { mode: "deny", allowlistedHostCount: 0 };
  }
  if (egress.mode === "allowlist") {
    return {
      mode: "allowlist",
      allowlistedHostCount: requiredStringArray(egress.hosts, "invalid installation manifest")
        .length
    };
  }
  throw new Error("invalid installation manifest");
}

function findConfigReferences(value: unknown): string[] {
  const found = new Set<string>();
  visit(value, found);
  return [...found].sort();
}

function visit(value: unknown, found: Set<string>): void {
  if (typeof value === "string") {
    const match = /^\$config\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
    if (match?.[1] !== undefined) found.add(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => {
      visit(item, found);
    });
  } else if (isRecord(value)) {
    Object.values(value).forEach((item) => {
      visit(item, found);
    });
  }
}

function parseRecord(value: string, error: string): Record<string, unknown> {
  try {
    return requiredRecord(JSON.parse(value), error);
  } catch {
    throw new Error(error);
  }
}

function requiredRecord(value: unknown, error: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(error);
  return value;
}

function requiredStringArray(value: unknown, error: string): string[] {
  if (!Array.isArray(value)) throw new Error(error);
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error(error);
    strings.push(item);
  }
  return strings;
}

function requiredString(value: unknown, error: string): string {
  if (typeof value !== "string") throw new Error(error);
  return value;
}

function requiredNumber(value: unknown, error: string): number {
  if (typeof value !== "number") throw new Error(error);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface InstallationDetailRow {
  id: unknown;
  plugin_key: unknown;
  version: unknown;
  enabled: unknown;
  priority: unknown;
  config_json: string;
  grants_json: string;
  manifest_json: string;
}

interface InstallationCommandRow {
  id: unknown;
  enabled: unknown;
  priority: unknown;
  tenant_id: unknown;
  plugin_id: unknown;
}
