import {
  parseManifest,
  resolveGrants,
  validateConfig,
  type TenantScriptManifest
} from "@tenantscript/manifest";
import type { D1DatabaseLike, D1PreparedStatementLike } from "./storage.js";

export interface AdminInstallPreview {
  versionId: string;
  pluginKey: string;
  version: string;
  configFields: readonly AdminInstallConfigField[];
  capabilities: readonly AdminInstallCapability[];
  egress: { mode: "deny" | "allowlist"; allowlistedHostCount: number };
}

export interface AdminInstallConfigField {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  hasDefault: boolean;
}

export interface AdminInstallCapability {
  name: string;
  scopeKeys: readonly string[];
  configReferences: readonly string[];
}

export interface AdminInstallRequest {
  appId: string;
  tenantId: string;
  actor: string;
  versionId: string;
  config: Record<string, unknown>;
  confirmedCapabilities: readonly string[];
  enabled: boolean;
  priority: number;
}

export interface AdminInstallResult {
  id: string;
  pluginKey: string;
  version: string;
  enabled: boolean;
  priority: number;
  revision: 0;
}

export interface AdminInstallFlowStore {
  readVersion: (request: {
    appId: string;
    versionId: string;
  }) => Promise<AdminInstallPreview | null>;
  install: (request: AdminInstallRequest) => Promise<AdminInstallResult | null>;
}

export class AdminInstallFlowError extends Error {
  override readonly name = "AdminInstallFlowError";

  constructor(readonly code: "invalid_config" | "capability_confirmation_mismatch") {
    super(code);
  }
}

export interface D1AdminInstallFlowStoreOptions {
  installationId?: () => string;
  auditId?: () => string;
  now?: () => Date;
}

export function createD1AdminInstallFlowStore(
  db: D1DatabaseLike,
  options: D1AdminInstallFlowStoreOptions = {}
): AdminInstallFlowStore {
  return {
    readVersion: (request) => readVersion(db, request),
    install: (request) => install(db, request, options)
  };
}

async function readVersion(
  db: D1DatabaseLike,
  request: { appId: string; versionId: string }
): Promise<AdminInstallPreview | null> {
  const row = await readVersionRow(db, request);
  return row === null ? null : preview(row);
}

async function install(
  db: D1DatabaseLike,
  request: AdminInstallRequest,
  options: D1AdminInstallFlowStoreOptions
): Promise<AdminInstallResult | null> {
  const row = await db
    .prepare(
      [
        "SELECT pv.id, pv.version, pv.manifest_json, pv.plugin_id, p.key AS plugin_key",
        "FROM plugin_versions pv",
        "JOIN plugins p ON p.id = pv.plugin_id",
        "JOIN tenants t ON t.id = ?1 AND t.app_id = p.app_id",
        "WHERE pv.id = ?2 AND p.app_id = ?3"
      ].join(" ")
    )
    .bind(request.tenantId, request.versionId, request.appId)
    .first<VersionRow>();
  if (row === null) return null;

  const manifest = manifestFromRow(row);
  const expectedCapabilities = Object.keys(manifest.capabilities).sort();
  const confirmedCapabilities = [...request.confirmedCapabilities].sort();
  if (!sameStrings(expectedCapabilities, confirmedCapabilities)) {
    throw new AdminInstallFlowError("capability_confirmation_mismatch");
  }
  const validatedConfig = validateConfig(manifest.configSchema, request.config);
  if (!validatedConfig.ok) throw new AdminInstallFlowError("invalid_config");
  const grants = resolveGrants(manifest.capabilities, validatedConfig.value);
  if (!grants.ok) throw new AdminInstallFlowError("invalid_config");

  const id = options.installationId?.() ?? `installation-${crypto.randomUUID()}`;
  const auditId = options.auditId?.() ?? `installation-install-${crypto.randomUUID()}`;
  const configFields = Object.keys(validatedConfig.value).sort();
  const after = {
    enabled: request.enabled,
    priority: request.priority,
    revision: 0,
    configFields,
    capabilities: expectedCapabilities
  };
  const statements = [
    db
      .prepare(
        [
          "INSERT INTO installations",
          "(id, tenant_id, plugin_version_id, enabled, priority, config_json, grants_json)",
          "VALUES (?, ?, ?, ?, ?, ?, ?)"
        ].join(" ")
      )
      .bind(
        id,
        request.tenantId,
        request.versionId,
        request.enabled ? 1 : 0,
        request.priority,
        JSON.stringify(validatedConfig.value),
        JSON.stringify(grants.value)
      ),
    db
      .prepare(
        [
          "INSERT INTO admin_audit_events",
          "(id, installation_id, tenant_id, app_id, plugin_id, revision, actor, action, before_json, after_json, created_at)",
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ].join(" ")
      )
      .bind(
        auditId,
        id,
        request.tenantId,
        request.appId,
        row.plugin_id,
        0,
        request.actor,
        "installation.install",
        "{}",
        JSON.stringify(after),
        (options.now?.() ?? new Date()).toISOString()
      )
  ];

  // D1 batch is a database transaction. The installation must never survive without its audit,
  // so fail closed when a non-D1 adapter lacks this atomic primitive instead of doing two writes.
  await requireBatch(db)(statements);
  return {
    id,
    pluginKey: row.plugin_key,
    version: row.version,
    enabled: request.enabled,
    priority: request.priority,
    revision: 0
  };
}

async function readVersionRow(
  db: D1DatabaseLike,
  request: { appId: string; versionId: string }
): Promise<VersionRow | null> {
  return db
    .prepare(
      [
        "SELECT pv.id, pv.version, pv.manifest_json, pv.plugin_id, p.key AS plugin_key",
        "FROM plugin_versions pv JOIN plugins p ON p.id = pv.plugin_id",
        "WHERE pv.id = ?1 AND p.app_id = ?2"
      ].join(" ")
    )
    .bind(request.versionId, request.appId)
    .first<VersionRow>();
}

function preview(row: VersionRow): AdminInstallPreview {
  const manifest = manifestFromRow(row);
  return {
    versionId: row.id,
    pluginKey: row.plugin_key,
    version: row.version,
    configFields: Object.entries(manifest.configSchema.properties)
      .map(([name, field]) => ({
        name,
        type: field.type,
        required: manifest.configSchema.required.includes(name),
        hasDefault: field.default !== undefined
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    capabilities: Object.entries(manifest.capabilities)
      .map(([name, scope]) => ({
        name,
        scopeKeys: Object.keys(scope).sort(),
        configReferences: findConfigReferences(scope)
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    egress:
      manifest.egress.mode === "deny"
        ? { mode: "deny", allowlistedHostCount: 0 }
        : { mode: "allowlist", allowlistedHostCount: manifest.egress.hosts.length }
  };
}

function manifestFromRow(row: VersionRow): TenantScriptManifest {
  try {
    const parsed = parseManifest(JSON.parse(row.manifest_json));
    if (!parsed.ok) throw new Error("invalid manifest");
    return parsed.value;
  } catch {
    throw new Error("invalid plugin version manifest");
  }
}

function findConfigReferences(value: unknown): string[] {
  const found = new Set<string>();
  visit(value, found);
  return [...found].sort();
}

function visit(value: unknown, found: Set<string>): void {
  if (typeof value === "string") {
    const match = /^\$config\.([A-Za-z_][A-Za-z0-9_]*)$/u.exec(value);
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

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireBatch(
  db: D1DatabaseLike
): (statements: D1PreparedStatementLike[]) => Promise<unknown> {
  const candidate = db as D1DatabaseLike & {
    batch?: (statements: D1PreparedStatementLike[]) => Promise<unknown>;
  };
  if (candidate.batch === undefined) throw new Error("D1 batch is unavailable");
  return candidate.batch.bind(candidate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface VersionRow {
  id: string;
  plugin_id: string;
  plugin_key: string;
  version: string;
  manifest_json: string;
}
