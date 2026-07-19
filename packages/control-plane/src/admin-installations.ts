import type { D1DatabaseLike } from "./storage.js";

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

export function createD1AdminInstallationDetailStore(
  db: D1DatabaseLike
): AdminInstallationDetailStore {
  return { readInstallation: (request) => readInstallation(db, request) };
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
        "WHERE t.id = ?1 AND t.app_id = ?2 AND i.id = ?3"
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
