import { describe, expect, it } from "vitest";
import {
  createD1R2ExecutionArchiveStore,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type R2BucketLike
} from "../src/index.js";

describe("createD1R2ExecutionArchiveStore", () => {
  it("archives expired executions and merges R2 fallback with hot D1 search", async () => {
    const db = new FakeArchiveD1([
      executionRow("old", "2026-05-01T00:00:00.000Z"),
      executionRow("hot", "2026-07-10T00:00:00.000Z")
    ]);
    const bucket = new FakeR2();
    const store = createD1R2ExecutionArchiveStore(db, bucket, {
      hotRetentionDays: 30,
      batchSize: 10,
      archiveId: () => "archive_1"
    });

    const manifest = await store.archiveExpired({
      appId: "app_1",
      tenantId: "tenant_1",
      now: new Date("2026-07-20T00:00:00.000Z")
    });

    expect(manifest).toMatchObject({ id: "archive_1", eventCount: 1 });
    expect(db.executions.map((row) => row.id)).toEqual(["hot"]);
    await expect(store.search(scope())).resolves.toEqual([
      expect.objectContaining({ id: "old" }),
      expect.objectContaining({ id: "hot" })
    ]);
    await expect(store.search({ ...scope(), pluginId: "other" })).resolves.toEqual([]);
  });

  it("reuses a content-addressed object and handles empty archive batches", async () => {
    const db = new FakeArchiveD1([executionRow("old", "2026-05-01T00:00:00.000Z")]);
    const bucket = new FakeR2();
    const options = { hotRetentionDays: 30, archiveId: () => "archive_1" };
    const store = createD1R2ExecutionArchiveStore(db, bucket, options);
    const first = await store.archiveExpired({ ...scope(), now: validNow() });
    expect(first).not.toBeNull();
    expect(bucket.putCount).toBe(1);

    const secondDb = new FakeArchiveD1([executionRow("old", "2026-05-01T00:00:00.000Z")]);
    await createD1R2ExecutionArchiveStore(secondDb, bucket, options).archiveExpired({
      ...scope(),
      now: validNow()
    });
    expect(bucket.putCount).toBe(1);
    await expect(store.archiveExpired({ ...scope(), now: validNow() })).resolves.toBeNull();
  });

  it("fails closed for missing, modified, and malformed R2 evidence", async () => {
    const db = new FakeArchiveD1([executionRow("old", "2026-05-01T00:00:00.000Z")]);
    const bucket = new FakeR2();
    const store = createD1R2ExecutionArchiveStore(db, bucket, {
      hotRetentionDays: 30,
      archiveId: () => "archive_1"
    });
    const manifest = await store.archiveExpired({ ...scope(), now: validNow() });
    if (manifest === null) throw new Error("expected archive manifest");

    bucket.objects.delete(manifest.objectKey);
    await expect(store.search(scope())).rejects.toThrow("execution archive object is missing");
    bucket.objects.set(manifest.objectKey, new TextEncoder().encode("modified\n"));
    await expect(store.search(scope())).rejects.toThrow("execution archive integrity check failed");
    const storedManifest = db.manifests[0];
    if (storedManifest === undefined) throw new Error("expected stored archive manifest");

    const invalid = "{}\n";
    bucket.objects.set(manifest.objectKey, new TextEncoder().encode(invalid));
    db.manifests[0] = { ...storedManifest, content_hash: await digest(invalid) };
    await expect(store.search(scope())).rejects.toThrow("invalid execution archive record");

    const empty = "\n";
    bucket.objects.set(manifest.objectKey, new TextEncoder().encode(empty));
    db.manifests[0] = { ...storedManifest, content_hash: await digest(empty) };
    await expect(store.search(scope())).rejects.toThrow("execution archive event count mismatch");
  });

  it("validates configuration, scope, dates, ranges, ids, and D1 batch support", async () => {
    const db = new FakeArchiveD1([executionRow("old", "2026-05-01T00:00:00.000Z")]);
    const bucket = new FakeR2();
    expect(() => createD1R2ExecutionArchiveStore(db, bucket, { hotRetentionDays: 0 })).toThrow(
      "hotRetentionDays must be a positive integer"
    );
    expect(() =>
      createD1R2ExecutionArchiveStore(db, bucket, { hotRetentionDays: 1, batchSize: -1 })
    ).toThrow("batchSize must be a positive integer");

    const store = createD1R2ExecutionArchiveStore(db, bucket, {
      hotRetentionDays: 30,
      archiveId: () => " "
    });
    await expect(store.archiveExpired({ ...scope(), now: validNow() })).rejects.toThrow(
      "execution archive id must not be empty"
    );
    await expect(
      store.archiveExpired({ appId: "", tenantId: "tenant_1", now: validNow() })
    ).rejects.toThrow("execution archive scope must not be empty");
    await expect(store.archiveExpired({ ...scope(), now: new Date(Number.NaN) })).rejects.toThrow(
      "now must be a valid date"
    );
    await expect(store.search({ ...scope(), from: new Date(Number.NaN) })).rejects.toThrow(
      "from must be a valid date"
    );
    await expect(
      store.search({
        ...scope(),
        from: new Date("2026-07-02T00:00:00.000Z"),
        to: new Date("2026-07-01T00:00:00.000Z")
      })
    ).rejects.toThrow("execution archive search range is invalid");

    const noBatch: D1DatabaseLike = { prepare: db.prepare.bind(db) };
    await expect(
      createD1R2ExecutionArchiveStore(noBatch, bucket, {
        hotRetentionDays: 30,
        archiveId: () => "archive_no_batch"
      }).archiveExpired({ ...scope(), now: validNow() })
    ).rejects.toThrow("D1 batch is unavailable");
  });
});

function scope() {
  return { appId: "app_1", tenantId: "tenant_1" };
}

function validNow() {
  return new Date("2026-07-20T00:00:00.000Z");
}

interface StoredExecutionRow {
  id: string;
  tenant_id: string;
  plugin_id: string;
  hook_name: string;
  version: string;
  status: string;
  duration_ms: number;
  error: string | null;
  capability_calls_json: string;
  created_at: string;
}

interface StoredManifestRow {
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

function executionRow(id: string, createdAt: string): StoredExecutionRow {
  return {
    id,
    tenant_id: "tenant_1",
    plugin_id: "plugin_1",
    hook_name: "invoice.created",
    version: "1.0.0",
    status: "success",
    duration_ms: 12,
    error: null,
    capability_calls_json: '[{"name":"invoice.read","status":"success"}]',
    created_at: createdAt
  };
}

class FakeArchiveD1 implements D1DatabaseLike {
  readonly manifests: StoredManifestRow[] = [];

  constructor(readonly executions: StoredExecutionRow[]) {}

  prepare(query: string): D1PreparedStatementLike {
    let bindings: unknown[] = [];
    const statement = {
      query,
      get bindings() {
        return bindings;
      },
      bind: (...values: unknown[]) => {
        bindings = values;
        return statement;
      },
      run: () => Promise.resolve({}),
      first: <T>() => Promise.resolve(null as T | null),
      all: () => Promise.resolve({ results: this.select(query, bindings) })
    };
    return statement;
  }

  batch(statements: D1PreparedStatementLike[]): Promise<unknown> {
    for (const candidate of statements) {
      const statement = candidate as D1PreparedStatementLike & {
        query: string;
        bindings: readonly unknown[];
      };
      if (statement.query.includes("INSERT INTO execution_archives")) {
        this.manifests.push(manifestFromBindings(statement.bindings));
      } else if (statement.query.includes("DELETE FROM executions")) {
        const id = asString(statement.bindings[0]);
        const index = this.executions.findIndex((row) => row.id === id);
        if (index >= 0) this.executions.splice(index, 1);
      }
    }
    return Promise.resolve([]);
  }

  private select(query: string, bindings: readonly unknown[]): unknown[] {
    if (query.includes("LIMIT ?")) {
      const cutoff = asString(bindings[2]);
      const limit = asNumber(bindings[3]);
      return this.executions
        .filter((row) => row.tenant_id === bindings[0] && row.created_at < cutoff)
        .sort(byCreatedAt)
        .slice(0, limit);
    }
    if (query.includes("FROM executions e")) {
      return this.executions
        .filter(
          (row) =>
            row.tenant_id === bindings[0] &&
            (bindings[2] === null || row.created_at >= asString(bindings[2])) &&
            (bindings[3] === null || row.created_at <= asString(bindings[3]))
        )
        .sort(byCreatedAt);
    }
    if (query.includes("FROM execution_archives")) {
      return this.manifests.filter(
        (row) =>
          row.tenant_id === bindings[0] &&
          row.app_id === bindings[1] &&
          (bindings[2] === null || row.to_at >= asString(bindings[2])) &&
          (bindings[3] === null || row.from_at <= asString(bindings[3]))
      );
    }
    throw new Error(`unexpected query: ${query}`);
  }
}

class FakeR2 implements R2BucketLike {
  readonly objects = new Map<string, Uint8Array>();
  putCount = 0;

  head(key: string): Promise<object | null> {
    return Promise.resolve(this.objects.has(key) ? {} : null);
  }

  put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<unknown> {
    this.putCount += 1;
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array(value);
    this.objects.set(key, bytes);
    return Promise.resolve({});
  }

  get(key: string) {
    const value = this.objects.get(key);
    return Promise.resolve(
      value === undefined
        ? null
        : {
            arrayBuffer: () => {
              const copy = new Uint8Array(value.byteLength);
              copy.set(value);
              return Promise.resolve(copy.buffer);
            }
          }
    );
  }
}

function manifestFromBindings(bindings: readonly unknown[]): StoredManifestRow {
  return {
    id: asString(bindings[0]),
    tenant_id: asString(bindings[1]),
    app_id: asString(bindings[2]),
    object_key: asString(bindings[3]),
    from_at: asString(bindings[4]),
    to_at: asString(bindings[5]),
    event_count: asNumber(bindings[6]),
    content_hash: asString(bindings[7]),
    created_at: asString(bindings[8])
  };
}

function byCreatedAt(left: StoredExecutionRow, right: StoredExecutionRow): number {
  return left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id);
}

function asString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("expected string binding");
  return value;
}

function asNumber(value: unknown): number {
  if (typeof value !== "number") throw new TypeError("expected number binding");
  return value;
}

async function digest(content: string): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
