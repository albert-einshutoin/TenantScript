import { describe, expect, it, vi } from "vitest";
import {
  AdminInstallFlowError,
  createD1AdminInstallRequestStore,
  type D1DatabaseLike,
  type D1PreparedStatementLike
} from "../src/index.js";

describe("D1 Admin installation request adapter", () => {
  it("batches the normalized proposal, redacted audit, and idempotency evidence", async () => {
    const db = database({ version: versionRow(), idempotency: [null] });
    const store = createD1AdminInstallRequestStore(db, {
      approvalId: () => "approval_1",
      installationId: () => "installation_1",
      auditId: () => "request_audit_1",
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    await expect(store.requestInstallation(request())).resolves.toEqual(result());
    expect(db.batch).toHaveBeenCalledTimes(1);
    const statements = db.batch.mock.calls[0]?.[0] ?? [];
    expect(statements).toHaveLength(5);
    expect(bindings(statements[1])).toContain("installation.request");
    expect(bindings(statements[2])).toContain(JSON.stringify({ channel: "C123", retries: 3 }));
    expect(bindings(statements[2])).toContain(
      JSON.stringify({ "slack.send": { channel: "C123" } })
    );
    expect(JSON.stringify(bindings(statements[3]))).not.toContain("C123");
  });

  it("returns null for a tenant/version mismatch and fails closed without D1 batch", async () => {
    await expect(
      createD1AdminInstallRequestStore(
        database({ version: null, idempotency: [null] })
      ).requestInstallation(request())
    ).resolves.toBeNull();

    const db = database({ version: versionRow(), idempotency: [null] });
    delete (db as Partial<typeof db>).batch;
    await expect(
      createD1AdminInstallRequestStore(db).requestInstallation(request())
    ).rejects.toThrow("D1 batch is unavailable");
  });

  it("replays a valid stored result and rejects a changed request hash", async () => {
    const originalHash = await requestHashFromSuccessfulBatch();
    const row = {
      request_hash: originalHash,
      result_json: JSON.stringify(result()),
      expires_at: "2026-07-21T00:00:00.000Z"
    };
    const replay = createD1AdminInstallRequestStore(
      database({ version: null, idempotency: [row, row] }),
      { now: () => new Date("2026-07-20T00:00:00.000Z") }
    );

    await expect(replay.requestInstallation(request())).resolves.toEqual(result());
    await expect(replay.requestInstallation({ ...request(), priority: 11 })).rejects.toEqual(
      new AdminInstallFlowError("idempotency_key_reused")
    );
  });

  it.each([
    ["malformed JSON", "{"],
    ["wrong state", JSON.stringify({ ...result(), state: "approved" })],
    ["extra field", JSON.stringify({ ...result(), secret: "must-not-replay" })],
    ["invalid expiry", JSON.stringify({ ...result(), expiresAt: "not-a-date" })]
  ])("rejects a corrupt %s idempotency result", async (_label, resultJson) => {
    const originalHash = await requestHashFromSuccessfulBatch();
    const store = createD1AdminInstallRequestStore(
      database({
        version: null,
        idempotency: [
          {
            request_hash: originalHash,
            result_json: resultJson,
            expires_at: "2026-07-21T00:00:00.000Z"
          }
        ]
      }),
      { now: () => new Date("2026-07-20T00:00:00.000Z") }
    );

    await expect(store.requestInstallation(request())).rejects.toThrow();
  });

  it("recovers a concurrent winner after its own batch loses the idempotency race", async () => {
    const originalHash = await requestHashFromSuccessfulBatch();
    const winner = {
      request_hash: originalHash,
      result_json: JSON.stringify(result()),
      expires_at: "2026-07-21T00:00:00.000Z"
    };
    const db = database({ version: versionRow(), idempotency: [null, winner] });
    db.batch.mockRejectedValueOnce(new Error("unique conflict"));
    const store = createD1AdminInstallRequestStore(db, {
      approvalId: () => "loser",
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    await expect(store.requestInstallation(request())).resolves.toEqual(result());
  });
});

async function requestHashFromSuccessfulBatch(): Promise<string> {
  const db = database({ version: versionRow(), idempotency: [null] });
  await createD1AdminInstallRequestStore(db, {
    approvalId: () => "approval_1",
    installationId: () => "installation_1",
    auditId: () => "request_audit_1",
    now: () => new Date("2026-07-20T00:00:00.000Z")
  }).requestInstallation(request());
  const idempotency = db.batch.mock.calls[0]?.[0]?.[4];
  const values = bindings(idempotency);
  const hash = values[4];
  if (typeof hash !== "string") throw new Error("expected request hash binding");
  return hash;
}

function request() {
  return {
    appId: "app_1",
    tenantId: "tenant_1",
    actor: "operator-subject",
    idempotencyKey: "installation-request-key-0001",
    versionId: "version_1",
    config: { channel: "C123" },
    confirmedCapabilities: ["slack.send"],
    enabled: false,
    priority: 10
  };
}

function result() {
  return {
    approvalId: "approval_1",
    state: "pending" as const,
    pluginKey: "invoice-notify",
    version: "1.0.0",
    capabilities: ["slack.send"],
    expiresAt: "2026-07-21T00:00:00.000Z"
  };
}

function versionRow() {
  return {
    id: "version_1",
    plugin_id: "plugin_1",
    plugin_key: "invoice-notify",
    version: "1.0.0",
    manifest_json: JSON.stringify({
      name: "invoice-notify",
      version: "1.0.0",
      hooks: [
        { name: "invoice.created", type: "event", timeoutMs: 250, schemaVersionRange: "^1.0.0" }
      ],
      capabilities: { "slack.send": { channel: "$config.channel" } },
      configSchema: {
        properties: {
          channel: { type: "string" },
          retries: { type: "number", default: 3 }
        },
        required: ["channel"]
      },
      egress: { mode: "deny" },
      limits: { cpuMs: 50, timeoutMs: 500 }
    })
  };
}

interface IdempotencyRow {
  request_hash: string;
  result_json: string;
  expires_at: string;
}

function database(options: {
  version: ReturnType<typeof versionRow> | null;
  idempotency: (IdempotencyRow | null)[];
}): D1DatabaseLike & {
  batch: ReturnType<typeof vi.fn<(statements: D1PreparedStatementLike[]) => Promise<unknown>>>;
} {
  const batch = vi
    .fn<(statements: D1PreparedStatementLike[]) => Promise<unknown>>()
    .mockResolvedValue([]);
  return {
    prepare: (query) =>
      new Statement(query, () =>
        query.includes("FROM installation_request_idempotency")
          ? (options.idempotency.shift() ?? null)
          : options.version
      ),
    batch
  };
}

class Statement implements D1PreparedStatementLike {
  constructor(
    readonly query: string,
    private readonly row: () => unknown,
    readonly values: unknown[] = []
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new Statement(this.query, this.row, values);
  }

  run(): Promise<unknown> {
    return Promise.resolve({ success: true });
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve(this.row() as T | null);
  }

  all(): Promise<{ results: unknown[] }> {
    return Promise.resolve({ results: [] });
  }
}

function bindings(statement: D1PreparedStatementLike | undefined): unknown[] {
  if (!(statement instanceof Statement)) throw new Error("expected fake statement");
  return statement.values;
}
