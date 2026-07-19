import type { D1DatabaseLike } from "./storage.js";

const GENESIS_HASH = "0".repeat(64);
const MAX_APPEND_ATTEMPTS = 3;

export type AuditValue =
  | null
  | boolean
  | number
  | string
  | readonly AuditValue[]
  | { readonly [key: string]: AuditValue };

export interface AppendAuditEvent {
  id: string;
  tenantId: string;
  appId: string;
  category: string;
  action: string;
  actor: string;
  resourceType: string;
  resourceId: string;
  payload: Readonly<Record<string, AuditValue>>;
  createdAt: Date;
}

export interface AuditEvent extends AppendAuditEvent {
  sequence: number;
  previousHash: string;
  eventHash: string;
}

export interface AuditScope {
  tenantId: string;
  appId: string;
}

export type AuditVerificationResult =
  | { valid: true; eventCount: number; lastEventHash: string }
  | {
      valid: false;
      eventCount: number;
      lastEventHash: string;
      sequence: number;
      failure: "sequence_mismatch" | "previous_hash_mismatch" | "event_hash_mismatch";
    };

export interface AuditLogStore {
  append: (event: AppendAuditEvent) => Promise<AuditEvent>;
  list: (scope: AuditScope) => Promise<readonly AuditEvent[]>;
  verify: (scope: AuditScope) => Promise<AuditVerificationResult>;
  verifyEvents: (events: readonly AuditEvent[]) => Promise<AuditVerificationResult>;
}

interface AuditHeadRow {
  next_sequence: number;
  last_event_hash: string;
}

interface AuditEventRow {
  id: string;
  tenant_id: string;
  app_id: string;
  sequence: number;
  category: string;
  action: string;
  actor: string;
  resource_type: string;
  resource_id: string;
  payload_json: string;
  previous_hash: string;
  event_hash: string;
  created_at: string;
}

export function createD1AuditLogStore(db: D1DatabaseLike): AuditLogStore {
  const list = async (scope: AuditScope): Promise<readonly AuditEvent[]> => {
    const rows = await db
      .prepare(
        `SELECT id, tenant_id, app_id, sequence, category, action, actor, resource_type,
                resource_id, payload_json, previous_hash, event_hash, created_at
         FROM audit_events
         WHERE tenant_id = ? AND app_id = ?
         ORDER BY sequence ASC`
      )
      .bind(scope.tenantId, scope.appId)
      .all();
    return rows.results.map((row) => mapAuditEventRow(row as AuditEventRow));
  };

  const verifyEvents = async (events: readonly AuditEvent[]): Promise<AuditVerificationResult> => {
    let previousHash = GENESIS_HASH;
    let expectedSequence = 1;

    for (const event of events) {
      if (event.sequence !== expectedSequence) {
        return invalidResult(events.length, previousHash, event.sequence, "sequence_mismatch");
      }
      if (event.previousHash !== previousHash) {
        return invalidResult(events.length, previousHash, event.sequence, "previous_hash_mismatch");
      }
      const calculatedHash = await hashAuditEvent(event);
      if (event.eventHash !== calculatedHash) {
        return invalidResult(events.length, previousHash, event.sequence, "event_hash_mismatch");
      }
      previousHash = event.eventHash;
      expectedSequence += 1;
    }

    return { valid: true, eventCount: events.length, lastEventHash: previousHash };
  };

  return {
    append: async (event) => {
      validateAuditEvent(event);
      await db
        .prepare(
          `INSERT OR IGNORE INTO audit_chain_heads
            (tenant_id, app_id, next_sequence, last_event_hash)
           VALUES (?, ?, 1, ?)`
        )
        .bind(event.tenantId, event.appId, GENESIS_HASH)
        .run();

      for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt += 1) {
        const head = await db
          .prepare(
            `SELECT next_sequence, last_event_hash
             FROM audit_chain_heads
             WHERE tenant_id = ? AND app_id = ?`
          )
          .bind(event.tenantId, event.appId)
          .first<AuditHeadRow>();
        if (head === null) {
          throw new Error("audit chain head is unavailable");
        }

        const chainedEvent: AuditEvent = {
          ...event,
          payload: clonePayload(event.payload),
          sequence: head.next_sequence,
          previousHash: head.last_event_hash,
          eventHash: ""
        };
        chainedEvent.eventHash = await hashAuditEvent(chainedEvent);

        try {
          await insertAuditEvent(db, chainedEvent);
          return chainedEvent;
        } catch (error) {
          if (!isAuditChainConflict(error) || attempt === MAX_APPEND_ATTEMPTS) {
            throw error;
          }
          // A concurrent append advanced the chain after our read. Re-reading the head preserves
          // one linear history without exposing coordination state to callers.
        }
      }

      throw new Error("audit append retry limit exceeded");
    },
    list,
    verify: async (scope) => verifyEvents(await list(scope)),
    verifyEvents
  };
}

async function insertAuditEvent(db: D1DatabaseLike, event: AuditEvent): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_events
        (id, tenant_id, app_id, sequence, category, action, actor, resource_type, resource_id,
         payload_json, previous_hash, event_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      event.id,
      event.tenantId,
      event.appId,
      event.sequence,
      event.category,
      event.action,
      event.actor,
      event.resourceType,
      event.resourceId,
      canonicalJson(event.payload),
      event.previousHash,
      event.eventHash,
      event.createdAt.toISOString()
    )
    .run();
}

async function hashAuditEvent(event: Omit<AuditEvent, "eventHash">): Promise<string> {
  const evidence = canonicalJson({
    id: event.id,
    tenantId: event.tenantId,
    appId: event.appId,
    sequence: event.sequence,
    category: event.category,
    action: event.action,
    actor: event.actor,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    payload: event.payload,
    previousHash: event.previousHash,
    createdAt: event.createdAt.toISOString()
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(evidence));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: AuditValue | Readonly<Record<string, AuditValue>>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("audit payload numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const arrayValue = value as readonly AuditValue[];
    return `[${arrayValue.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const objectValue = value as Readonly<Record<string, AuditValue>>;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => {
      const item = objectValue[key];
      if (item === undefined) throw new TypeError("audit payload must not contain undefined");
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    })
    .join(",")}}`;
}

function validateAuditEvent(event: AppendAuditEvent): void {
  for (const [field, value] of Object.entries({
    id: event.id,
    tenantId: event.tenantId,
    appId: event.appId,
    category: event.category,
    action: event.action,
    actor: event.actor,
    resourceType: event.resourceType,
    resourceId: event.resourceId
  })) {
    if (value.trim().length === 0) throw new TypeError(`audit ${field} must not be empty`);
  }
  if (Number.isNaN(event.createdAt.getTime())) throw new TypeError("audit createdAt must be valid");
  canonicalJson(event.payload);
}

function mapAuditEventRow(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    appId: row.app_id,
    sequence: row.sequence,
    category: row.category,
    action: row.action,
    actor: row.actor,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    payload: JSON.parse(row.payload_json) as Record<string, AuditValue>,
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
    createdAt: new Date(row.created_at)
  };
}

function clonePayload(
  payload: Readonly<Record<string, AuditValue>>
): Readonly<Record<string, AuditValue>> {
  return JSON.parse(canonicalJson(payload)) as Record<string, AuditValue>;
}

function invalidResult(
  eventCount: number,
  lastEventHash: string,
  sequence: number,
  failure: "sequence_mismatch" | "previous_hash_mismatch" | "event_hash_mismatch"
): AuditVerificationResult {
  return { valid: false, eventCount, lastEventHash, sequence, failure };
}

function isAuditChainConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes("audit chain conflict");
}
