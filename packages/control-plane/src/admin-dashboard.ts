import type { D1DatabaseLike } from "./storage.js";
import {
  createD1SchemaMigrationTracker,
  type PublishedHookSchemaCatalog,
  type SchemaMigrationStatus
} from "./schema-migrations.js";

export type AdminDashboardSection =
  | "installations"
  | "pluginVersions"
  | "approvals"
  | "executions"
  | "auditEvents";

export interface AdminDashboardScope {
  appId: string;
  tenantId: string;
}

export interface AdminInstallationSummary {
  id: string;
  pluginKey: string;
  version: string;
  enabled: boolean;
  priority: number;
  revision: number;
}

export interface AdminPluginVersionSummary {
  id: string;
  pluginId: string;
  pluginKey: string;
  version: string;
  artifactHash: string;
  createdAt: string;
}

export interface AdminApprovalSummary {
  id: string;
  pluginId: string;
  role: string;
  resumeHook: string;
  state: "pending" | "approved" | "rejected" | "expired";
  expiresAt: string;
  createdAt: string;
}

export interface AdminExecutionSummary {
  id: string;
  pluginId: string;
  hookName: string;
  version: string;
  status: "success" | "error" | "timeout" | "egress_denied" | "budget_exceeded";
  durationMs: number;
  capabilityNames: readonly string[];
  createdAt: string;
}

export interface AdminExecutionFilters {
  pluginId?: string;
  hookName?: string;
  status?: AdminExecutionSummary["status"];
}

export interface AdminUsageSummary {
  date: string;
  executions: number;
  runtimeMs: number;
}

export interface AdminOperationalHealthSummary {
  date: string;
  totalExecutions: number;
  failedExecutions: number;
  failureRateBps: number;
  timeoutExecutions: number;
  egressDeniedExecutions: number;
  budgetExceededExecutions: number;
}

export interface AdminAuditStateSummary {
  enabled?: boolean;
  priority?: number;
  revision?: number;
  version?: string;
}

export interface AdminAuditEventSummary {
  id: string;
  installationId: string;
  pluginId: string;
  revision: number;
  actor: string;
  action: string;
  before: AdminAuditStateSummary;
  after: AdminAuditStateSummary;
  createdAt: string;
}

export type AdminDashboardSectionPage =
  | AdminSectionPage<"installations", AdminInstallationSummary>
  | AdminSectionPage<"pluginVersions", AdminPluginVersionSummary>
  | AdminSectionPage<"approvals", AdminApprovalSummary>
  | AdminSectionPage<"executions", AdminExecutionSummary>
  | AdminSectionPage<"auditEvents", AdminAuditEventSummary>;

interface AdminSectionPage<TSection extends AdminDashboardSection, TItem> {
  section: TSection;
  items: readonly TItem[];
  nextPosition?: string;
}

export interface AdminDashboardStore {
  readSection: (request: {
    appId: string;
    tenantId: string;
    section: AdminDashboardSection;
    limit: number;
    position?: string;
    filters?: AdminExecutionFilters;
  }) => Promise<AdminDashboardSectionPage>;
  readUsageSummary: (request: {
    appId: string;
    tenantId: string;
    date: string;
  }) => Promise<AdminUsageSummary>;
  readOperationalHealth?: (request: {
    appId: string;
    tenantId: string;
    date: string;
  }) => Promise<AdminOperationalHealthSummary>;
  readSchemaMigrations?: (request: { appId: string }) => Promise<readonly SchemaMigrationStatus[]>;
}

export interface AdminCursorPayload extends AdminDashboardScope {
  section: AdminDashboardSection;
  position: string;
  query?: string;
}

export interface AdminCursorCodec {
  encode: (payload: AdminCursorPayload) => Promise<string>;
  decode: (cursor: string) => Promise<AdminCursorPayload>;
}

export function createD1AdminDashboardStore(
  db: D1DatabaseLike,
  schemaCatalog: PublishedHookSchemaCatalog = {}
): AdminDashboardStore {
  const schemaMigrations = createD1SchemaMigrationTracker(db, schemaCatalog);
  return {
    readSection: (request) => {
      switch (request.section) {
        case "installations":
          return readInstallations(db, request);
        case "pluginVersions":
          return readPluginVersions(db, request);
        case "approvals":
          return readApprovals(db, request);
        case "executions":
          return readExecutions(db, request);
        case "auditEvents":
          return readAuditEvents(db, request);
      }
    },
    readUsageSummary: (request) => readUsageSummary(db, request),
    readOperationalHealth: (request) => readOperationalHealth(db, request),
    readSchemaMigrations: (request) => schemaMigrations.readStatus(request)
  };
}

async function readInstallations(
  db: D1DatabaseLike,
  request: SectionReadRequest
): Promise<AdminDashboardSectionPage> {
  const rows = await db
    .prepare(
      [
        "SELECT i.id, p.key AS plugin_key, pv.version, i.enabled, i.priority, i.revision",
        "FROM installations i",
        "JOIN tenants t ON t.id = i.tenant_id",
        "JOIN plugin_versions pv ON pv.id = i.plugin_version_id",
        "JOIN plugins p ON p.id = pv.plugin_id",
        "WHERE t.id = ?1 AND t.app_id = ?2 AND p.app_id = t.app_id",
        "AND (?3 IS NULL OR i.id > ?3)",
        "ORDER BY i.id ASC LIMIT ?4"
      ].join(" ")
    )
    .bind(request.tenantId, request.appId, request.position ?? null, request.limit + 1)
    .all();
  const page = keysetPage(rows.results as InstallationSummaryRow[], request.limit, (row) => row.id);
  return {
    section: "installations",
    items: page.rows.map((row) => ({
      id: row.id,
      pluginKey: row.plugin_key,
      version: row.version,
      enabled: row.enabled === 1,
      priority: safeInteger(row.priority, "invalid installation priority"),
      revision: safeInteger(row.revision, "invalid installation revision")
    })),
    ...(page.nextPosition === undefined ? {} : { nextPosition: page.nextPosition })
  };
}

async function readPluginVersions(
  db: D1DatabaseLike,
  request: SectionReadRequest
): Promise<AdminDashboardSectionPage> {
  const rows = await db
    .prepare(
      [
        "SELECT pv.id, pv.plugin_id, p.key AS plugin_key, pv.version, pv.artifact_hash, pv.created_at",
        "FROM plugin_versions pv",
        "JOIN plugins p ON p.id = pv.plugin_id",
        "JOIN tenants t ON t.id = ?1 AND t.app_id = p.app_id",
        "WHERE p.app_id = ?2",
        "AND (?3 IS NULL OR pv.id > ?3)",
        "ORDER BY pv.id ASC LIMIT ?4"
      ].join(" ")
    )
    .bind(request.tenantId, request.appId, request.position ?? null, request.limit + 1)
    .all();
  const page = keysetPage(
    rows.results as PluginVersionSummaryRow[],
    request.limit,
    (row) => row.id
  );
  return {
    section: "pluginVersions",
    items: page.rows.map((row) => ({
      id: row.id,
      pluginId: row.plugin_id,
      pluginKey: row.plugin_key,
      version: row.version,
      artifactHash: row.artifact_hash,
      createdAt: row.created_at
    })),
    ...(page.nextPosition === undefined ? {} : { nextPosition: page.nextPosition })
  };
}

async function readApprovals(
  db: D1DatabaseLike,
  request: SectionReadRequest
): Promise<AdminDashboardSectionPage> {
  const rows = await db
    .prepare(
      [
        "SELECT a.id, a.plugin_id, a.role, a.resume_hook, a.state, a.expires_at, a.created_at",
        "FROM approvals a JOIN tenants t ON t.id = a.tenant_id",
        "WHERE t.id = ?1 AND t.app_id = ?2",
        "AND (?3 IS NULL OR a.id > ?3)",
        "ORDER BY a.id ASC LIMIT ?4"
      ].join(" ")
    )
    .bind(request.tenantId, request.appId, request.position ?? null, request.limit + 1)
    .all();
  const page = keysetPage(rows.results as ApprovalSummaryRow[], request.limit, (row) => row.id);
  return {
    section: "approvals",
    items: page.rows.map((row) => ({
      id: row.id,
      pluginId: row.plugin_id,
      role: row.role,
      resumeHook: row.resume_hook,
      state: approvalState(row.state),
      expiresAt: row.expires_at,
      createdAt: row.created_at
    })),
    ...(page.nextPosition === undefined ? {} : { nextPosition: page.nextPosition })
  };
}

async function readExecutions(
  db: D1DatabaseLike,
  request: SectionReadRequest
): Promise<AdminDashboardSectionPage> {
  const cursor = executionCursor(request.position);
  const rows = await db
    .prepare(
      [
        "SELECT e.id, e.plugin_id, e.hook_name, e.version, e.status, e.duration_ms,",
        "e.capability_calls_json, e.created_at",
        "FROM executions e JOIN tenants t ON t.id = e.tenant_id",
        "WHERE t.id = ?1 AND t.app_id = ?2",
        "AND (?3 IS NULL OR e.created_at < ?3 OR (e.created_at = ?3 AND e.id < ?4))",
        "AND (?5 IS NULL OR e.plugin_id = ?5)",
        "AND (?6 IS NULL OR e.hook_name = ?6)",
        "AND (?7 IS NULL OR e.status = ?7)",
        "ORDER BY e.created_at DESC, e.id DESC LIMIT ?8"
      ].join(" ")
    )
    .bind(
      request.tenantId,
      request.appId,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      request.filters?.pluginId ?? null,
      request.filters?.hookName ?? null,
      request.filters?.status ?? null,
      request.limit + 1
    )
    .all();
  const page = keysetPage(rows.results as ExecutionSummaryRow[], request.limit, (row) =>
    executionPosition(row.created_at, row.id)
  );
  return {
    section: "executions",
    items: page.rows.map((row) => ({
      id: row.id,
      pluginId: row.plugin_id,
      hookName: row.hook_name,
      version: row.version,
      status: executionStatus(row.status),
      durationMs: row.duration_ms,
      capabilityNames: capabilityNames(row.capability_calls_json),
      createdAt: row.created_at
    })),
    ...(page.nextPosition === undefined ? {} : { nextPosition: page.nextPosition })
  };
}

async function readAuditEvents(
  db: D1DatabaseLike,
  request: SectionReadRequest
): Promise<AdminDashboardSectionPage> {
  const cursor = auditCursor(request.position);
  // Audit IDs are not time ordered. Pairing created_at with id keeps pagination stable when several
  // mutations share a timestamp, while every ownership relation is checked inside the SQL boundary.
  const rows = await db
    .prepare(
      [
        "SELECT a.id, a.installation_id, a.plugin_id, a.revision, a.actor, a.action,",
        "a.before_json, a.after_json, a.created_at",
        "FROM admin_audit_events a",
        "JOIN tenants t ON t.id = a.tenant_id AND t.app_id = a.app_id",
        "JOIN installations i ON i.id = a.installation_id AND i.tenant_id = a.tenant_id",
        "JOIN plugins p ON p.id = a.plugin_id AND p.app_id = a.app_id",
        "WHERE a.tenant_id = ?1 AND a.app_id = ?2",
        "AND (?3 IS NULL OR a.created_at < ?3 OR (a.created_at = ?3 AND a.id < ?4))",
        "ORDER BY a.created_at DESC, a.id DESC LIMIT ?5"
      ].join(" ")
    )
    .bind(
      request.tenantId,
      request.appId,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      request.limit + 1
    )
    .all();
  const page = keysetPage(rows.results as AuditEventSummaryRow[], request.limit, (row) =>
    auditPosition(row.created_at, row.id)
  );
  return {
    section: "auditEvents",
    items: page.rows.map((row) => ({
      id: row.id,
      installationId: row.installation_id,
      pluginId: row.plugin_id,
      revision: safeInteger(row.revision, "invalid audit revision"),
      actor: row.actor,
      action: row.action,
      before: auditState(row.before_json),
      after: auditState(row.after_json),
      createdAt: row.created_at
    })),
    ...(page.nextPosition === undefined ? {} : { nextPosition: page.nextPosition })
  };
}

async function readUsageSummary(
  db: D1DatabaseLike,
  request: { appId: string; tenantId: string; date: string }
): Promise<AdminUsageSummary> {
  const nextDate = nextIsoDate(request.date);
  const row = await db
    .prepare(
      [
        "SELECT COUNT(e.id) AS executions, COALESCE(SUM(e.duration_ms), 0) AS runtime_ms",
        "FROM executions e JOIN tenants t ON t.id = e.tenant_id",
        "WHERE t.id = ?1 AND t.app_id = ?2 AND e.created_at >= ?3 AND e.created_at < ?4"
      ].join(" ")
    )
    .bind(
      request.tenantId,
      request.appId,
      `${request.date}T00:00:00.000Z`,
      `${nextDate}T00:00:00.000Z`
    )
    .first<UsageSummaryRow>();
  return {
    date: request.date,
    executions: row?.executions ?? 0,
    runtimeMs: row?.runtime_ms ?? 0
  };
}

async function readOperationalHealth(
  db: D1DatabaseLike,
  request: { appId: string; tenantId: string; date: string }
): Promise<AdminOperationalHealthSummary> {
  const nextDate = nextIsoDate(request.date);
  const row = await db
    .prepare(
      [
        "SELECT COUNT(e.id) AS total_executions,",
        "COALESCE(SUM(CASE WHEN e.status <> 'success' THEN 1 ELSE 0 END), 0) AS failed_executions,",
        "COALESCE(SUM(CASE WHEN e.status = 'timeout' THEN 1 ELSE 0 END), 0) AS timeout_executions,",
        "COALESCE(SUM(CASE WHEN e.status = 'egress_denied' THEN 1 ELSE 0 END), 0) AS egress_denied_executions,",
        "COALESCE(SUM(CASE WHEN e.status = 'budget_exceeded' THEN 1 ELSE 0 END), 0) AS budget_exceeded_executions",
        "FROM executions e JOIN tenants t ON t.id = e.tenant_id",
        "WHERE t.id = ?1 AND t.app_id = ?2 AND e.created_at >= ?3 AND e.created_at < ?4"
      ].join(" ")
    )
    .bind(
      request.tenantId,
      request.appId,
      `${request.date}T00:00:00.000Z`,
      `${nextDate}T00:00:00.000Z`
    )
    .first<OperationalHealthRow>();
  const totalExecutions = nonNegativeSafeInteger(
    row?.total_executions ?? 0,
    "invalid operational total"
  );
  const failedExecutions = nonNegativeSafeInteger(
    row?.failed_executions ?? 0,
    "invalid operational failure count"
  );
  // Basis points keep the public response deterministic across JavaScript and SQL runtimes.
  const failureRateBps =
    totalExecutions === 0 ? 0 : Math.round((failedExecutions / totalExecutions) * 10_000);
  return {
    date: request.date,
    totalExecutions,
    failedExecutions,
    failureRateBps,
    timeoutExecutions: nonNegativeSafeInteger(
      row?.timeout_executions ?? 0,
      "invalid operational timeout count"
    ),
    egressDeniedExecutions: nonNegativeSafeInteger(
      row?.egress_denied_executions ?? 0,
      "invalid operational egress denial count"
    ),
    budgetExceededExecutions: nonNegativeSafeInteger(
      row?.budget_exceeded_executions ?? 0,
      "invalid operational budget count"
    )
  };
}

interface SectionReadRequest extends AdminDashboardScope {
  section: AdminDashboardSection;
  limit: number;
  position?: string;
  filters?: AdminExecutionFilters;
}

function keysetPage<TRow>(
  rows: readonly TRow[],
  limit: number,
  position: (row: TRow) => string
): { rows: readonly TRow[]; nextPosition?: string } {
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    rows: pageRows,
    ...(rows.length > limit && last !== undefined ? { nextPosition: position(last) } : {})
  };
}

function executionPosition(createdAt: string, id: string): string {
  return `${createdAt}\t${id}`;
}

function executionCursor(position: string | undefined): { createdAt: string; id: string } | null {
  if (position === undefined) {
    return null;
  }
  const separator = position.indexOf("\t");
  if (separator <= 0 || separator === position.length - 1) {
    throw new Error("invalid execution cursor position");
  }
  return { createdAt: position.slice(0, separator), id: position.slice(separator + 1) };
}

function auditPosition(createdAt: string, id: string): string {
  return `${createdAt}\t${id}`;
}

function auditCursor(position: string | undefined): { createdAt: string; id: string } | null {
  if (position === undefined) return null;
  const separator = position.indexOf("\t");
  if (separator <= 0 || separator === position.length - 1) {
    throw new Error("invalid audit cursor position");
  }
  return { createdAt: position.slice(0, separator), id: position.slice(separator + 1) };
}

function auditState(serialized: string): AdminAuditStateSummary {
  const parsed: unknown = JSON.parse(serialized);
  if (!isRecord(parsed)) throw new Error("invalid audit state summary");
  return {
    ...(parsed.enabled === undefined
      ? {}
      : { enabled: requiredBoolean(parsed.enabled, "invalid audit enabled state") }),
    ...(parsed.priority === undefined
      ? {}
      : { priority: requiredSafeInteger(parsed.priority, "invalid audit priority state") }),
    ...(parsed.revision === undefined
      ? {}
      : { revision: requiredSafeInteger(parsed.revision, "invalid audit revision state") }),
    ...(parsed.version === undefined
      ? {}
      : { version: requiredNonEmptyString(parsed.version, "invalid audit version state") })
  };
}

function requiredBoolean(value: unknown, error: string): boolean {
  if (typeof value !== "boolean") throw new Error(error);
  return value;
}

function requiredSafeInteger(value: unknown, error: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(error);
  return value;
}

function requiredNonEmptyString(value: unknown, error: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(error);
  return value;
}

function capabilityNames(serialized: string): readonly string[] {
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new Error("invalid capability call summary");
  }
  return parsed.map((call) => {
    if (!isRecord(call) || typeof call.name !== "string") {
      throw new Error("invalid capability call summary");
    }
    return call.name;
  });
}

function approvalState(value: string): AdminApprovalSummary["state"] {
  if (value === "pending" || value === "approved" || value === "rejected" || value === "expired") {
    return value;
  }
  throw new Error("invalid approval state");
}

function executionStatus(value: string): AdminExecutionSummary["status"] {
  if (
    value === "success" ||
    value === "error" ||
    value === "timeout" ||
    value === "egress_denied" ||
    value === "budget_exceeded"
  ) {
    return value;
  }
  throw new Error("invalid execution status");
}

function nextIsoDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new Error("invalid usage summary date");
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("invalid usage summary date");
  }
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function safeInteger(value: number, error: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(error);
  return value;
}

function nonNegativeSafeInteger(value: number, error: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(error);
  return value;
}

interface InstallationSummaryRow {
  id: string;
  plugin_key: string;
  version: string;
  enabled: number;
  priority: number;
  revision: number;
}

interface PluginVersionSummaryRow {
  id: string;
  plugin_id: string;
  plugin_key: string;
  version: string;
  artifact_hash: string;
  created_at: string;
}

interface ApprovalSummaryRow {
  id: string;
  plugin_id: string;
  role: string;
  resume_hook: string;
  state: string;
  expires_at: string;
  created_at: string;
}

interface ExecutionSummaryRow {
  id: string;
  plugin_id: string;
  hook_name: string;
  version: string;
  status: string;
  duration_ms: number;
  capability_calls_json: string;
  created_at: string;
}

interface AuditEventSummaryRow {
  id: string;
  installation_id: string;
  plugin_id: string;
  revision: number;
  actor: string;
  action: string;
  before_json: string;
  after_json: string;
  created_at: string;
}

interface UsageSummaryRow {
  executions: number;
  runtime_ms: number;
}

interface OperationalHealthRow {
  total_executions: number;
  failed_executions: number;
  timeout_executions: number;
  egress_denied_executions: number;
  budget_exceeded_executions: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createAdminCursorCodec(secret: string): AdminCursorCodec {
  const secretBytes = encoder.encode(secret);
  if (secretBytes.byteLength < 32) {
    throw new Error("Admin cursor secret must contain at least 32 bytes");
  }

  const key = crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );

  return {
    encode: async (payload) => {
      const payloadBytes = encoder.encode(JSON.stringify({ version: 1, ...payload }));
      const signature = await crypto.subtle.sign("HMAC", await key, payloadBytes);
      return `${base64UrlEncode(payloadBytes)}.${base64UrlEncode(new Uint8Array(signature))}`;
    },
    decode: async (cursor) => {
      try {
        const parts = cursor.split(".");
        if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
          throw new Error("malformed cursor");
        }
        const payloadBytes = base64UrlDecode(parts[0]);
        const signature = base64UrlDecode(parts[1]);
        const valid = await crypto.subtle.verify("HMAC", await key, signature, payloadBytes);
        if (!valid) {
          throw new Error("invalid signature");
        }
        const parsed: unknown = JSON.parse(decoder.decode(payloadBytes));
        if (!isCursorPayload(parsed)) {
          throw new Error("invalid payload");
        }
        return {
          appId: parsed.appId,
          tenantId: parsed.tenantId,
          section: parsed.section,
          position: parsed.position,
          ...(parsed.query === undefined ? {} : { query: parsed.query })
        };
      } catch {
        throw new Error("invalid Admin dashboard cursor");
      }
    }
  };
}

function isCursorPayload(value: unknown): value is AdminCursorPayload & { version: 1 } {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.version === 1 &&
    isNonEmptyString(value.appId) &&
    isNonEmptyString(value.tenantId) &&
    isDashboardSection(value.section) &&
    isNonEmptyString(value.position) &&
    (value.query === undefined || isNonEmptyString(value.query))
  );
}

function isDashboardSection(value: unknown): value is AdminDashboardSection {
  return (
    value === "installations" ||
    value === "pluginVersions" ||
    value === "approvals" ||
    value === "executions" ||
    value === "auditEvents"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
