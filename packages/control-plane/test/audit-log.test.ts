import { describe, expect, it } from "vitest";
import {
  createD1AuditLogStore,
  type AppendAuditEvent,
  type AuditEvent,
  type D1DatabaseLike,
  type D1PreparedStatementLike
} from "../src/index.js";

describe("createD1AuditLogStore", () => {
  it("appends, clones, lists, and verifies a deterministic chain", async () => {
    const db = new FakeAuditD1();
    const store = createD1AuditLogStore(db);
    const payload = { nested: { z: 1, a: true }, values: ["b", "a"] };

    const first = await store.append(event("audit_1", payload));
    payload.nested.z = 99;
    const second = await store.append(event("audit_2", { result: "approved" }));

    expect(first.sequence).toBe(1);
    expect(second).toMatchObject({ sequence: 2, previousHash: first.eventHash });
    await expect(store.list(scope())).resolves.toEqual([first, second]);
    await expect(store.verify(scope())).resolves.toEqual({
      valid: true,
      eventCount: 2,
      lastEventHash: second.eventHash
    });
  });

  it("reports predecessor and content corruption independently", async () => {
    const store = createD1AuditLogStore(new FakeAuditD1());
    const first = await store.append(event("audit_1", {}));
    const second = await store.append(event("audit_2", {}));

    await expect(
      store.verifyEvents([{ ...first, previousHash: "f".repeat(64) }, second])
    ).resolves.toMatchObject({ valid: false, failure: "previous_hash_mismatch", sequence: 1 });
    await expect(
      store.verifyEvents([{ ...first, payload: { forged: true } }, second])
    ).resolves.toMatchObject({ valid: false, failure: "event_hash_mismatch", sequence: 1 });
    await expect(store.verifyEvents([second])).resolves.toMatchObject({
      valid: false,
      failure: "sequence_mismatch",
      sequence: 2
    });
  });

  it("rejects malformed evidence before touching D1", async () => {
    const store = createD1AuditLogStore(new FakeAuditD1());

    await expect(store.append(event(" ", {}))).rejects.toThrow("audit id must not be empty");
    await expect(
      store.append({ ...event("audit_bad_date", {}), createdAt: new Date(Number.NaN) })
    ).rejects.toThrow("audit createdAt must be valid");
    await expect(
      store.append(event("audit_infinite", { value: Number.POSITIVE_INFINITY }))
    ).rejects.toThrow("audit payload numbers must be finite");
    await expect(
      store.append(event("audit_undefined", { value: undefined } as never))
    ).rejects.toThrow("audit payload must not contain undefined");
  });

  it("retries only chain conflicts and preserves unrelated D1 failures", async () => {
    const conflictingDb = new FakeAuditD1({ chainConflicts: 3 });
    await expect(
      createD1AuditLogStore(conflictingDb).append(event("audit_conflict", {}))
    ).rejects.toThrow("audit chain conflict");
    expect(conflictingDb.auditInsertAttempts).toBe(3);

    const unavailableDb = new FakeAuditD1({ omitHead: true });
    await expect(
      createD1AuditLogStore(unavailableDb).append(event("audit_no_head", {}))
    ).rejects.toThrow("audit chain head is unavailable");

    const duplicateDb = new FakeAuditD1();
    const duplicateStore = createD1AuditLogStore(duplicateDb);
    await duplicateStore.append(event("audit_duplicate", {}));
    await expect(duplicateStore.append(event("audit_duplicate", {}))).rejects.toThrow(
      "UNIQUE constraint failed"
    );
  });
});

function event(id: string, payload: AppendAuditEvent["payload"]): AppendAuditEvent {
  return {
    id,
    tenantId: "tenant_1",
    appId: "app_1",
    category: "approval",
    action: "approval.decided",
    actor: "admin-1",
    resourceType: "approval",
    resourceId: "approval_1",
    payload,
    createdAt: new Date("2026-07-20T00:00:00.000Z")
  };
}

function scope() {
  return { tenantId: "tenant_1", appId: "app_1" };
}

class FakeAuditD1 implements D1DatabaseLike {
  readonly events: AuditEvent[] = [];
  readonly heads = new Map<string, { nextSequence: number; lastEventHash: string }>();
  auditInsertAttempts = 0;
  private chainConflicts: number;
  private readonly omitHead: boolean;

  constructor(options: { chainConflicts?: number; omitHead?: boolean } = {}) {
    this.chainConflicts = options.chainConflicts ?? 0;
    this.omitHead = options.omitHead ?? false;
  }

  prepare(query: string): D1PreparedStatementLike {
    let bindings: unknown[] = [];
    const statement: D1PreparedStatementLike = {
      bind: (...values) => {
        bindings = values;
        return statement;
      },
      run: () => Promise.resolve().then(() => this.run(query, bindings)),
      first: <T>() => Promise.resolve().then(() => this.first(query, bindings) as T | null),
      all: () => Promise.resolve().then(() => ({ results: this.all(query, bindings) }))
    };
    return statement;
  }

  private run(query: string, bindings: readonly unknown[]): unknown {
    if (query.includes("INSERT OR IGNORE INTO audit_chain_heads")) {
      if (!this.omitHead) {
        const key = this.key(bindings);
        if (!this.heads.has(key)) {
          this.heads.set(key, {
            nextSequence: 1,
            lastEventHash: stringBinding(bindings, 2)
          });
        }
      }
      return {};
    }
    if (query.includes("INSERT INTO audit_events")) {
      this.auditInsertAttempts += 1;
      if (this.chainConflicts > 0) {
        this.chainConflicts -= 1;
        throw new Error("audit chain conflict");
      }
      const id = stringBinding(bindings, 0);
      if (this.events.some((stored) => stored.id === id)) {
        throw new Error("UNIQUE constraint failed: audit_events.id");
      }
      const stored = rowToEvent(bindings);
      const key = `${stored.tenantId}:${stored.appId}`;
      const head = this.heads.get(key);
      if (
        head === undefined ||
        head.nextSequence !== stored.sequence ||
        head.lastEventHash !== stored.previousHash
      ) {
        throw new Error("audit chain conflict");
      }
      this.events.push(stored);
      this.heads.set(key, {
        nextSequence: stored.sequence + 1,
        lastEventHash: stored.eventHash
      });
      return {};
    }
    throw new Error(`unexpected run query: ${query}`);
  }

  private first(query: string, bindings: readonly unknown[]): unknown {
    if (!query.includes("FROM audit_chain_heads"))
      throw new Error(`unexpected first query: ${query}`);
    const head = this.heads.get(this.key(bindings));
    return head === undefined
      ? null
      : { next_sequence: head.nextSequence, last_event_hash: head.lastEventHash };
  }

  private all(query: string, bindings: readonly unknown[]): unknown[] {
    if (!query.includes("FROM audit_events")) throw new Error(`unexpected all query: ${query}`);
    const tenantId = stringBinding(bindings, 0);
    const appId = stringBinding(bindings, 1);
    return this.events
      .filter((stored) => stored.tenantId === tenantId && stored.appId === appId)
      .sort((left, right) => left.sequence - right.sequence)
      .map(eventToRow);
  }

  private key(bindings: readonly unknown[]): string {
    return `${stringBinding(bindings, 0)}:${stringBinding(bindings, 1)}`;
  }
}

function rowToEvent(bindings: readonly unknown[]): AuditEvent {
  return {
    id: stringBinding(bindings, 0),
    tenantId: stringBinding(bindings, 1),
    appId: stringBinding(bindings, 2),
    sequence: numberBinding(bindings, 3),
    category: stringBinding(bindings, 4),
    action: stringBinding(bindings, 5),
    actor: stringBinding(bindings, 6),
    resourceType: stringBinding(bindings, 7),
    resourceId: stringBinding(bindings, 8),
    payload: JSON.parse(stringBinding(bindings, 9)) as AppendAuditEvent["payload"],
    previousHash: stringBinding(bindings, 10),
    eventHash: stringBinding(bindings, 11),
    createdAt: new Date(stringBinding(bindings, 12))
  };
}

function eventToRow(eventRecord: AuditEvent): Record<string, unknown> {
  return {
    id: eventRecord.id,
    tenant_id: eventRecord.tenantId,
    app_id: eventRecord.appId,
    sequence: eventRecord.sequence,
    category: eventRecord.category,
    action: eventRecord.action,
    actor: eventRecord.actor,
    resource_type: eventRecord.resourceType,
    resource_id: eventRecord.resourceId,
    payload_json: JSON.stringify(eventRecord.payload),
    previous_hash: eventRecord.previousHash,
    event_hash: eventRecord.eventHash,
    created_at: eventRecord.createdAt.toISOString()
  };
}

function stringBinding(bindings: readonly unknown[], index: number): string {
  const value = bindings[index];
  if (typeof value !== "string") throw new TypeError(`binding ${String(index)} must be a string`);
  return value;
}

function numberBinding(bindings: readonly unknown[], index: number): number {
  const value = bindings[index];
  if (typeof value !== "number") throw new TypeError(`binding ${String(index)} must be a number`);
  return value;
}
