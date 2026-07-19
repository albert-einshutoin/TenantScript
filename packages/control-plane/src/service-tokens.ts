import type { AuthenticatedIdentity, IdentityResolver } from "./api.js";
import {
  RBAC_OPERATIONS,
  canRolePerform,
  isRbacOperation,
  normalizeRbacRole,
  type RbacOperation,
  type RbacRole
} from "./rbac.js";
import type { D1DatabaseLike } from "./storage.js";

const credentialPrefix = "ts_service_";
const maximumLifetimeMs = 90 * 24 * 60 * 60 * 1000;
const forbiddenMachineScopes = new Set<RbacOperation>([
  "service-token:issue",
  "service-token:revoke",
  "rbac:manage"
]);

export interface ServiceTokenRecord {
  id: string;
  tokenHash: string;
  label: string;
  role: RbacRole;
  appId: string;
  tenantId: string;
  scopes: readonly RbacOperation[];
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedBy?: string;
}

export interface ServiceTokenStore {
  create(record: ServiceTokenRecord): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<ServiceTokenRecord | null>;
  revoke(request: {
    id: string;
    appId: string;
    tenantId: string;
    revokedAt: string;
    revokedBy: string;
  }): Promise<boolean>;
}

export interface ServiceTokenManager {
  issue(request: {
    appId: string;
    tenantId: string;
    actor: string;
    actorRole: string;
    label: string;
    role: RbacRole;
    scopes: readonly RbacOperation[];
    expiresAt: Date;
  }): Promise<{
    id: string;
    token: string;
    label: string;
    role: RbacRole;
    scopes: readonly RbacOperation[];
    createdAt: string;
    expiresAt: string;
  }>;
  revoke(request: {
    id: string;
    appId: string;
    tenantId: string;
    actor: string;
    actorRole: string;
  }): Promise<boolean>;
}

export type ServiceTokenErrorCode =
  | "invalid_service_token"
  | "service_token_role_escalation"
  | "service_token_scope_forbidden"
  | "service_token_revoke_forbidden";

export class ServiceTokenError extends Error {
  override readonly name = "ServiceTokenError";

  constructor(readonly code: ServiceTokenErrorCode) {
    super(code);
  }
}

export function createServiceTokenManager(options: {
  store: ServiceTokenStore;
  now?: () => Date;
  generateId?: () => string;
  generateSecret?: () => string;
}): ServiceTokenManager {
  const now = options.now ?? (() => new Date());
  const generateId = options.generateId ?? (() => `st_${crypto.randomUUID()}`);
  const generateSecret = options.generateSecret ?? randomSecret;

  return {
    async issue(request) {
      const createdAtDate = now();
      assertValidIssue(request, createdAtDate);
      const id = generateId();
      const secret = generateSecret();
      if (!/^st_[A-Za-z0-9_-]{1,128}$/u.test(id) || secret.length < 32) {
        throw new Error("service token generator returned invalid output");
      }
      const token = `${credentialPrefix}${secret}`;
      const record: ServiceTokenRecord = {
        id,
        tokenHash: await hashServiceToken(token),
        label: request.label,
        role: request.role,
        appId: request.appId,
        tenantId: request.tenantId,
        scopes: [...request.scopes],
        createdBy: request.actor,
        createdAt: createdAtDate.toISOString(),
        expiresAt: request.expiresAt.toISOString()
      };
      await options.store.create(record);
      // The raw credential intentionally exists only in this return value. Stores receive a
      // one-way digest so a database disclosure cannot be converted into bearer access.
      return {
        id: record.id,
        token,
        label: record.label,
        role: record.role,
        scopes: record.scopes,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt
      };
    },
    revoke(request) {
      if (!canRolePerform(request.actorRole, "service-token:revoke")) {
        throw new ServiceTokenError("service_token_revoke_forbidden");
      }
      return options.store.revoke({
        id: request.id,
        appId: request.appId,
        tenantId: request.tenantId,
        revokedAt: now().toISOString(),
        revokedBy: request.actor
      });
    }
  };
}

export function createServiceTokenIdentityResolver(
  store: ServiceTokenStore,
  options: { now?: () => Date } = {}
): IdentityResolver {
  const now = options.now ?? (() => new Date());
  return {
    async resolveToken(token) {
      if (!isServiceTokenCredential(token)) return null;
      const record = await store.findByTokenHash(await hashServiceToken(token));
      if (record === null || record.revokedAt !== undefined) return null;
      const currentTime = now().getTime();
      const expiresAt = Date.parse(record.expiresAt);
      if (
        !Number.isFinite(currentTime) ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= currentTime
      ) {
        return null;
      }
      return {
        subject: `service-token:${record.id}`,
        role: record.role,
        appId: record.appId,
        tenantId: record.tenantId,
        allowedOperations: [...record.scopes]
      } satisfies AuthenticatedIdentity;
    }
  };
}

export function createServiceTokenAwareIdentityResolver(options: {
  serviceTokens: IdentityResolver;
  bootstrap?: IdentityResolver;
}): IdentityResolver {
  return {
    resolveToken(token) {
      // A credential in the managed namespace must never fall back to a static bootstrap entry.
      // Otherwise a revoked token accidentally duplicated in configuration could become valid.
      if (isServiceTokenCredential(token)) return options.serviceTokens.resolveToken(token);
      return options.bootstrap?.resolveToken(token) ?? null;
    }
  };
}

export function createD1ServiceTokenStore(db: D1DatabaseLike): ServiceTokenStore {
  return {
    async create(record) {
      await db
        .prepare(
          `INSERT INTO service_tokens
            (id, token_hash, label, role, app_id, tenant_id, scopes_json,
             created_by, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          record.id,
          record.tokenHash,
          record.label,
          record.role,
          record.appId,
          record.tenantId,
          JSON.stringify(record.scopes),
          record.createdBy,
          record.createdAt,
          record.expiresAt
        )
        .run();
    },
    async findByTokenHash(tokenHash) {
      const row = await db
        .prepare(
          `SELECT id, token_hash, label, role, app_id, tenant_id, scopes_json,
                  created_by, created_at, expires_at, revoked_at, revoked_by
             FROM service_tokens
            WHERE token_hash = ?`
        )
        .bind(tokenHash)
        .first<ServiceTokenRow>();
      return row === null ? null : serviceTokenFromRow(row);
    },
    async revoke(request) {
      const existing = await db
        .prepare(
          `SELECT id
             FROM service_tokens
            WHERE id = ? AND app_id = ? AND tenant_id = ?`
        )
        .bind(request.id, request.appId, request.tenantId)
        .first<{ id: unknown }>();
      if (existing === null || existing.id !== request.id) return false;
      await db
        .prepare(
          `UPDATE service_tokens
              SET revoked_at = COALESCE(revoked_at, ?),
                  revoked_by = COALESCE(revoked_by, ?)
            WHERE id = ? AND app_id = ? AND tenant_id = ?`
        )
        .bind(request.revokedAt, request.revokedBy, request.id, request.appId, request.tenantId)
        .run();
      return true;
    }
  };
}

export function isServiceTokenCredential(token: string): boolean {
  return token.startsWith(credentialPrefix);
}

async function hashServiceToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertValidIssue(
  request: Parameters<ServiceTokenManager["issue"]>[0],
  createdAt: Date
): void {
  const createdAtMs = createdAt.getTime();
  const expiresAtMs = request.expiresAt.getTime();
  if (
    !isBoundedText(request.appId, 256) ||
    !isBoundedText(request.tenantId, 256) ||
    !isBoundedText(request.actor, 256) ||
    !isBoundedText(request.label, 128) ||
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= createdAtMs ||
    expiresAtMs - createdAtMs > maximumLifetimeMs ||
    request.scopes.length === 0 ||
    request.scopes.length > RBAC_OPERATIONS.length ||
    new Set(request.scopes).size !== request.scopes.length ||
    !request.scopes.every(isRbacOperation)
  ) {
    throw new ServiceTokenError("invalid_service_token");
  }

  const issuerRole = normalizeRbacRole(request.actorRole);
  if (
    issuerRole === null ||
    !canRolePerform(issuerRole, "service-token:issue") ||
    !RBAC_OPERATIONS.every(
      (operation) =>
        !canRolePerform(request.role, operation) || canRolePerform(issuerRole, operation)
    )
  ) {
    throw new ServiceTokenError("service_token_role_escalation");
  }
  if (
    request.scopes.some(
      (scope) => forbiddenMachineScopes.has(scope) || !canRolePerform(request.role, scope)
    )
  ) {
    throw new ServiceTokenError("service_token_scope_forbidden");
  }
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isBoundedText(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && value.trim() === value;
}

interface ServiceTokenRow {
  id: unknown;
  token_hash: unknown;
  label: unknown;
  role: unknown;
  app_id: unknown;
  tenant_id: unknown;
  scopes_json: unknown;
  created_by: unknown;
  created_at: unknown;
  expires_at: unknown;
  revoked_at: unknown;
  revoked_by: unknown;
}

function serviceTokenFromRow(row: ServiceTokenRow): ServiceTokenRecord {
  let scopes: unknown;
  try {
    scopes = typeof row.scopes_json === "string" ? JSON.parse(row.scopes_json) : null;
  } catch {
    scopes = null;
  }
  const role = typeof row.role === "string" ? normalizeRbacRole(row.role) : null;
  if (
    typeof row.id !== "string" ||
    typeof row.token_hash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.token_hash) ||
    typeof row.label !== "string" ||
    role === null ||
    role !== row.role ||
    typeof row.app_id !== "string" ||
    typeof row.tenant_id !== "string" ||
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    !scopes.every(isRbacOperation) ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => forbiddenMachineScopes.has(scope) || !canRolePerform(role, scope)) ||
    typeof row.created_by !== "string" ||
    typeof row.created_at !== "string" ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    typeof row.expires_at !== "string" ||
    !Number.isFinite(Date.parse(row.expires_at)) ||
    (row.revoked_at !== null &&
      (typeof row.revoked_at !== "string" || !Number.isFinite(Date.parse(row.revoked_at)))) ||
    (row.revoked_by !== null && typeof row.revoked_by !== "string") ||
    (row.revoked_at === null) !== (row.revoked_by === null)
  ) {
    throw new Error("invalid service token row");
  }
  return {
    id: row.id,
    tokenHash: row.token_hash,
    label: row.label,
    role,
    appId: row.app_id,
    tenantId: row.tenant_id,
    scopes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.revoked_at === null
      ? {}
      : { revokedAt: row.revoked_at, revokedBy: row.revoked_by as string })
  };
}
