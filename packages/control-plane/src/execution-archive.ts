import type { CapabilityCallRecord, ExecutionRecord, ExecutionStatus } from "./index.js";
import type { D1DatabaseLike, D1PreparedStatementLike, R2BucketLike } from "./storage.js";

const DEFAULT_ARCHIVE_BATCH_SIZE = 100;
const MILLISECONDS_PER_DAY = 86_400_000;

export interface ExecutionArchiveScope {
  appId: string;
  tenantId: string;
}

export interface ArchiveExpiredExecutionsRequest extends ExecutionArchiveScope {
  now: Date;
}

export interface ExecutionArchiveSearchQuery extends ExecutionArchiveScope {
  pluginId?: string;
  hookName?: string;
  status?: ExecutionStatus;
  from?: Date;
  to?: Date;
}

export interface ExecutionArchiveManifest extends ExecutionArchiveScope {
  id: string;
  objectKey: string;
  from: Date;
  to: Date;
  eventCount: number;
  contentHash: string;
  createdAt: Date;
}

export interface ExecutionArchiveStore {
  archiveExpired: (
    request: ArchiveExpiredExecutionsRequest
  ) => Promise<ExecutionArchiveManifest | null>;
  search: (query: ExecutionArchiveSearchQuery) => Promise<readonly ExecutionRecord[]>;
}

export interface ExecutionArchiveStoreOptions {
  hotRetentionDays: number;
  batchSize?: number;
  archiveId?: () => string;
}

interface ExecutionRow {
  id: string;
  tenant_id: string;
  plugin_id: string;
  hook_name: string;
  version: string;
  status: ExecutionStatus;
  duration_ms: number;
  error: string | null;
  capability_calls_json: string;
  created_at: string;
}

interface ArchiveRow {
  id: string;
  tenant_id: string;
  app_id: string;
  object_key: string;
  from_at: string;
  to_at: string;
  event_count: number;
  content_hash: string;
  created_at: string;
}

interface ArchivedExecutionJson {
  id: string;
  tenantId: string;
  pluginId: string;
  hookName: string;
  version: string;
  status: ExecutionStatus;
  durationMs: number;
  error: string | null;
  capabilityCalls: readonly CapabilityCallRecord[];
  createdAt: string;
}

export function createD1R2ExecutionArchiveStore(
  db: D1DatabaseLike,
  bucket: R2BucketLike,
  options: ExecutionArchiveStoreOptions
): ExecutionArchiveStore {
  validateOptions(options);
  const batchSize = options.batchSize ?? DEFAULT_ARCHIVE_BATCH_SIZE;
  const archiveId = options.archiveId ?? (() => crypto.randomUUID());

  return {
    archiveExpired: async (request) => {
      validateScope(request);
      validateDate(request.now, "now");
      const cutoff = new Date(
        request.now.getTime() - options.hotRetentionDays * MILLISECONDS_PER_DAY
      );
      const expired = await readExpiredExecutions(db, request, cutoff, batchSize);
      if (expired.length === 0) return null;

      const records = expired.map(executionFromRow);
      const content = serializeExecutions(records);
      const contentHash = await sha256(content);
      const id = archiveId();
      if (id.trim().length === 0) throw new TypeError("execution archive id must not be empty");
      const objectKey = archiveObjectKey(request, contentHash);
      if ((await bucket.head(objectKey)) === null) await bucket.put(objectKey, content);

      const manifest: ExecutionArchiveManifest = {
        id,
        ...request,
        objectKey,
        from: records[0]?.createdAt ?? cutoff,
        to: records.at(-1)?.createdAt ?? cutoff,
        eventCount: records.length,
        contentHash,
        createdAt: new Date(request.now)
      };
      const statements = [
        insertManifestStatement(db, manifest),
        ...records.map((record) =>
          db
            .prepare("DELETE FROM executions WHERE id = ? AND tenant_id = ?")
            .bind(record.id, request.tenantId)
        )
      ];
      // R2 is written first because D1 batch can roll back metadata and deletes atomically. A
      // failed batch may leave an unreferenced content-addressed object, but never loses hot data.
      await requireBatch(db)(statements);
      return manifest;
    },
    search: async (query) => {
      validateSearchQuery(query);
      const [hot, archives] = await Promise.all([
        readHotExecutions(db, query),
        readArchiveManifests(db, query)
      ]);
      const archived: ExecutionRecord[] = [];
      for (const manifest of archives) {
        const object = await bucket.get(manifest.objectKey);
        if (object === null) throw new Error(`execution archive object is missing: ${manifest.id}`);
        const content = new TextDecoder().decode(await object.arrayBuffer());
        if ((await sha256(content)) !== manifest.contentHash) {
          throw new Error(`execution archive integrity check failed: ${manifest.id}`);
        }
        const records = parseExecutions(content);
        if (records.length !== manifest.eventCount) {
          throw new Error(`execution archive event count mismatch: ${manifest.id}`);
        }
        archived.push(...records);
      }

      const byId = new Map<string, ExecutionRecord>();
      for (const record of [...archived, ...hot]) {
        if (matchesQuery(record, query)) byId.set(record.id, record);
      }
      return [...byId.values()].sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)
      );
    }
  };
}

async function readExpiredExecutions(
  db: D1DatabaseLike,
  scope: ExecutionArchiveScope,
  cutoff: Date,
  limit: number
): Promise<ExecutionRow[]> {
  const rows = await db
    .prepare(
      `SELECT e.id, e.tenant_id, e.plugin_id, e.hook_name, e.version, e.status, e.duration_ms,
              e.error, e.capability_calls_json, e.created_at
       FROM executions e
       JOIN tenants t ON t.id = e.tenant_id
       WHERE e.tenant_id = ? AND t.app_id = ? AND e.created_at < ?
       ORDER BY e.created_at ASC, e.id ASC
       LIMIT ?`
    )
    .bind(scope.tenantId, scope.appId, cutoff.toISOString(), limit)
    .all();
  return rows.results as ExecutionRow[];
}

async function readHotExecutions(
  db: D1DatabaseLike,
  query: ExecutionArchiveSearchQuery
): Promise<ExecutionRecord[]> {
  const rows = await db
    .prepare(
      `SELECT e.id, e.tenant_id, e.plugin_id, e.hook_name, e.version, e.status, e.duration_ms,
              e.error, e.capability_calls_json, e.created_at
       FROM executions e
       JOIN tenants t ON t.id = e.tenant_id
       WHERE e.tenant_id = ?1 AND t.app_id = ?2
         AND (?3 IS NULL OR e.created_at >= ?3)
         AND (?4 IS NULL OR e.created_at <= ?4)
       ORDER BY e.created_at ASC, e.id ASC`
    )
    .bind(
      query.tenantId,
      query.appId,
      query.from?.toISOString() ?? null,
      query.to?.toISOString() ?? null
    )
    .all();
  return (rows.results as ExecutionRow[]).map(executionFromRow);
}

async function readArchiveManifests(
  db: D1DatabaseLike,
  query: ExecutionArchiveSearchQuery
): Promise<ExecutionArchiveManifest[]> {
  const rows = await db
    .prepare(
      `SELECT id, tenant_id, app_id, object_key, from_at, to_at, event_count, content_hash, created_at
       FROM execution_archives
       WHERE tenant_id = ?1 AND app_id = ?2
         AND (?3 IS NULL OR to_at >= ?3)
         AND (?4 IS NULL OR from_at <= ?4)
       ORDER BY from_at ASC, id ASC`
    )
    .bind(
      query.tenantId,
      query.appId,
      query.from?.toISOString() ?? null,
      query.to?.toISOString() ?? null
    )
    .all();
  return (rows.results as ArchiveRow[]).map(manifestFromRow);
}

function insertManifestStatement(
  db: D1DatabaseLike,
  manifest: ExecutionArchiveManifest
): D1PreparedStatementLike {
  return db
    .prepare(
      `INSERT INTO execution_archives
        (id, tenant_id, app_id, object_key, from_at, to_at, event_count, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      manifest.id,
      manifest.tenantId,
      manifest.appId,
      manifest.objectKey,
      manifest.from.toISOString(),
      manifest.to.toISOString(),
      manifest.eventCount,
      manifest.contentHash,
      manifest.createdAt.toISOString()
    );
}

function executionFromRow(row: ExecutionRow): ExecutionRecord {
  const base: ExecutionRecord = {
    id: row.id,
    tenantId: row.tenant_id,
    pluginId: row.plugin_id,
    hookName: row.hook_name,
    version: row.version,
    status: row.status,
    durationMs: row.duration_ms,
    capabilityCalls: JSON.parse(row.capability_calls_json) as CapabilityCallRecord[],
    createdAt: new Date(row.created_at)
  };
  return row.error === null ? base : { ...base, error: row.error };
}

function manifestFromRow(row: ArchiveRow): ExecutionArchiveManifest {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    appId: row.app_id,
    objectKey: row.object_key,
    from: new Date(row.from_at),
    to: new Date(row.to_at),
    eventCount: row.event_count,
    contentHash: row.content_hash,
    createdAt: new Date(row.created_at)
  };
}

function serializeExecutions(records: readonly ExecutionRecord[]): string {
  return `${records
    .map((record) =>
      JSON.stringify({
        id: record.id,
        tenantId: record.tenantId,
        pluginId: record.pluginId,
        hookName: record.hookName,
        version: record.version,
        status: record.status,
        durationMs: record.durationMs,
        error: record.error ?? null,
        capabilityCalls: record.capabilityCalls,
        createdAt: record.createdAt.toISOString()
      } satisfies ArchivedExecutionJson)
    )
    .join("\n")}\n`;
}

function parseExecutions(content: string): ExecutionRecord[] {
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => archivedExecutionFromJson(JSON.parse(line) as unknown));
}

function archivedExecutionFromJson(value: unknown): ExecutionRecord {
  if (!isArchivedExecutionJson(value)) throw new Error("invalid execution archive record");
  const base: ExecutionRecord = {
    id: value.id,
    tenantId: value.tenantId,
    pluginId: value.pluginId,
    hookName: value.hookName,
    version: value.version,
    status: value.status,
    durationMs: value.durationMs,
    capabilityCalls: value.capabilityCalls.map((call) => ({ ...call })),
    createdAt: new Date(value.createdAt)
  };
  return value.error === null ? base : { ...base, error: value.error };
}

function isArchivedExecutionJson(value: unknown): value is ArchivedExecutionJson {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.tenantId === "string" &&
    typeof value.pluginId === "string" &&
    typeof value.hookName === "string" &&
    typeof value.version === "string" &&
    isExecutionStatus(value.status) &&
    Number.isSafeInteger(value.durationMs) &&
    (value.error === null || typeof value.error === "string") &&
    Array.isArray(value.capabilityCalls) &&
    value.capabilityCalls.every(isCapabilityCall) &&
    typeof value.createdAt === "string" &&
    !Number.isNaN(new Date(value.createdAt).getTime())
  );
}

function matchesQuery(record: ExecutionRecord, query: ExecutionArchiveSearchQuery): boolean {
  return (
    record.tenantId === query.tenantId &&
    (query.pluginId === undefined || record.pluginId === query.pluginId) &&
    (query.hookName === undefined || record.hookName === query.hookName) &&
    (query.status === undefined || record.status === query.status) &&
    (query.from === undefined || record.createdAt >= query.from) &&
    (query.to === undefined || record.createdAt <= query.to)
  );
}

function archiveObjectKey(scope: ExecutionArchiveScope, contentHash: string): string {
  // A content-addressed key makes concurrent jobs converge on one R2 object. The manifest UNIQUE
  // constraint then rejects a duplicate D1 commit without deleting hot rows in the losing batch.
  return `execution-archives/v1/${encodeURIComponent(scope.appId)}/${encodeURIComponent(scope.tenantId)}/${contentHash}.ndjson`;
}

async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateOptions(options: ExecutionArchiveStoreOptions): void {
  if (!Number.isSafeInteger(options.hotRetentionDays) || options.hotRetentionDays <= 0) {
    throw new TypeError("hotRetentionDays must be a positive integer");
  }
  if (
    options.batchSize !== undefined &&
    (!Number.isSafeInteger(options.batchSize) || options.batchSize <= 0)
  ) {
    throw new TypeError("batchSize must be a positive integer");
  }
}

function validateScope(scope: ExecutionArchiveScope): void {
  if (scope.appId.trim().length === 0 || scope.tenantId.trim().length === 0) {
    throw new TypeError("execution archive scope must not be empty");
  }
}

function validateSearchQuery(query: ExecutionArchiveSearchQuery): void {
  validateScope(query);
  if (query.from !== undefined) validateDate(query.from, "from");
  if (query.to !== undefined) validateDate(query.to, "to");
  if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
    throw new TypeError("execution archive search range is invalid");
  }
}

function validateDate(value: Date, field: string): void {
  if (Number.isNaN(value.getTime())) throw new TypeError(`${field} must be a valid date`);
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

function isCapabilityCall(value: unknown): value is CapabilityCallRecord {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    (value.status === "success" || value.status === "denied" || value.status === "error")
  );
}

function isExecutionStatus(value: unknown): value is ExecutionStatus {
  return (
    value === "success" ||
    value === "error" ||
    value === "timeout" ||
    value === "egress_denied" ||
    value === "budget_exceeded"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
