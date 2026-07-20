import { describe, expect, it, vi } from "vitest";
import {
  createD1R2ExecutionArchiveStore,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type R2BucketLike
} from "../src/index.js";

const scope = { appId: "app_chaos", tenantId: "tenant_chaos" };

describe("control-plane storage chaos scenarios", () => {
  it("fails closed before touching R2 when D1 is unavailable", async () => {
    const unavailable = new Error("synthetic D1 unavailable");
    const db = database(() => Promise.reject(unavailable));
    const bucket = bucketSpies();
    const archive = createD1R2ExecutionArchiveStore(db, bucket, {
      hotRetentionDays: 30,
      archiveId: () => "archive_chaos"
    });

    await expect(
      archive.archiveExpired({ ...scope, now: new Date("2026-07-20T00:00:00.000Z") })
    ).rejects.toBe(unavailable);
    expect(bucket.head).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("keeps D1 hot data authoritative when R2 archive writes are unavailable", async () => {
    const r2Unavailable = new Error("synthetic R2 unavailable");
    const batch = vi.fn();
    const db = Object.assign(
      database(() => Promise.resolve({ results: [executionRow()] })),
      {
        batch
      }
    );
    const bucket = bucketSpies();
    vi.mocked(bucket.head).mockResolvedValue(null);
    vi.mocked(bucket.put).mockRejectedValue(r2Unavailable);
    const archive = createD1R2ExecutionArchiveStore(db, bucket, {
      hotRetentionDays: 30,
      archiveId: () => "archive_chaos"
    });

    await expect(
      archive.archiveExpired({ ...scope, now: new Date("2026-07-20T00:00:00.000Z") })
    ).rejects.toBe(r2Unavailable);
    expect(batch).not.toHaveBeenCalled();
  });

  it("fails closed instead of hiding an unreachable R2 search partition", async () => {
    const r2Unavailable = new Error("synthetic R2 read unavailable");
    const db = database((query) =>
      Promise.resolve({
        results: query.includes("FROM execution_archives") ? [archiveRow()] : []
      })
    );
    const bucket = bucketSpies();
    vi.mocked(bucket.get).mockRejectedValue(r2Unavailable);
    const archive = createD1R2ExecutionArchiveStore(db, bucket, { hotRetentionDays: 30 });

    await expect(archive.search(scope)).rejects.toBe(r2Unavailable);
  });
});

function database(all: (query: string) => Promise<{ results: unknown[] }>): D1DatabaseLike {
  return {
    prepare(query) {
      const statement: D1PreparedStatementLike = {
        bind: () => statement,
        run: () => Promise.reject(new Error("unexpected D1 run")),
        first: () => Promise.reject(new Error("unexpected D1 first")),
        all: () => all(query)
      };
      return statement;
    }
  };
}

function bucketSpies(): R2BucketLike {
  return {
    head: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null)
  };
}

function executionRow(): Record<string, unknown> {
  return {
    id: "execution_chaos",
    tenant_id: scope.tenantId,
    plugin_id: "plugin_chaos",
    hook_name: "invoice.created",
    version: "1.0.0",
    status: "success",
    duration_ms: 5,
    error: null,
    capability_calls_json: "[]",
    created_at: "2026-05-01T00:00:00.000Z"
  };
}

function archiveRow(): Record<string, unknown> {
  return {
    id: "archive_chaos",
    tenant_id: scope.tenantId,
    app_id: scope.appId,
    object_key: "execution-archives/app_chaos/tenant_chaos/object.ndjson",
    from_at: "2026-05-01T00:00:00.000Z",
    to_at: "2026-05-01T00:00:00.000Z",
    event_count: 1,
    content_hash: "0".repeat(64),
    created_at: "2026-07-01T00:00:00.000Z"
  };
}
