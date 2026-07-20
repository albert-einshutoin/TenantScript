import { describe, expect, it } from "vitest";
import {
  CloudflareApiError,
  CloudflareD1SetupAdapterError,
  createCloudflareApiTransport,
  createCloudflareD1SetupAdapter,
  createProductionSetupPlan,
  deriveSetupOperationIdempotencyKey,
  type CloudflareApiTransport,
  type SetupOperation
} from "../src/index.js";

const databaseId = "123e4567-e89b-12d3-a456-426614174000";
const runId = "setup-run-191";
const createOperation = operation("create:control-plane-d1");
const declareOperation = operation("declare:app-database-boundary");
const reconcileKey = deriveSetupOperationIdempotencyKey(runId, createOperation.id, "reconcile");
const cleanupKey = deriveSetupOperationIdempotencyKey(runId, createOperation.id, "cleanup");

describe("Cloudflare D1 setup adapter", () => {
  it("creates a deterministically named D1 database after an exact-name miss", async () => {
    const requests: RecordedRequest[] = [];
    const transport = recordingTransport(requests, (request) => {
      if (request.method === "GET") return [];
      const body = requireRecord(request.body);
      return { uuid: databaseId, name: body.name };
    });
    const adapter = createCloudflareD1SetupAdapter({
      transport,
      database: { mode: "create", baseName: "tenantscript-control-plane", jurisdiction: "eu" }
    });

    await expect(
      adapter.reconcile({ runId, idempotencyKey: reconcileKey, operation: createOperation })
    ).resolves.toEqual({ disposition: "created", resourceRef: `d1:${databaseId}` });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: "GET",
      pathSegments: ["d1", "database"],
      query: { page: "1", per_page: "10" }
    });
    const derivedName = requests[0]?.query?.name;
    expect(derivedName).toMatch(/^tenantscript-control-plane-[0-9a-f]{24}$/u);
    expect(requests[1]).toEqual({
      method: "POST",
      pathSegments: ["d1", "database"],
      body: { name: derivedName, jurisdiction: "eu" }
    });
  });

  it("reconciles a response-loss resume without replaying the create mutation", async () => {
    const initialRequests: RecordedRequest[] = [];
    let createdName = "";
    const initial = createCloudflareD1SetupAdapter({
      transport: recordingTransport(initialRequests, (request) => {
        if (request.method === "GET") return [];
        createdName = String(requireRecord(request.body).name);
        return { uuid: databaseId, name: createdName };
      }),
      database: { mode: "create", baseName: "tenantscript-control-plane" }
    });
    await initial.reconcile({ runId, idempotencyKey: reconcileKey, operation: createOperation });

    const resumedRequests: RecordedRequest[] = [];
    const resumed = createCloudflareD1SetupAdapter({
      transport: recordingTransport(resumedRequests, () => [
        { uuid: databaseId, name: createdName, version: "production" }
      ]),
      database: { mode: "create", baseName: "tenantscript-control-plane" }
    });

    await expect(
      resumed.reconcile({ runId, idempotencyKey: reconcileKey, operation: createOperation })
    ).resolves.toEqual({ disposition: "created", resourceRef: `d1:${databaseId}` });
    expect(resumedRequests).toEqual([
      {
        method: "GET",
        pathSegments: ["d1", "database"],
        query: { name: createdName, page: "1", per_page: "10" }
      }
    ]);
  });

  it("adopts only an explicitly configured D1 database without mutation", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = createCloudflareD1SetupAdapter({
      transport: recordingTransport(requests, () => ({
        uuid: databaseId,
        name: "operator-owned-database"
      })),
      database: { mode: "adopt", databaseId }
    });

    await expect(
      adapter.reconcile({ runId, idempotencyKey: reconcileKey, operation: createOperation })
    ).resolves.toEqual({ disposition: "adopted", resourceRef: `d1:${databaseId}` });
    expect(requests).toEqual([
      {
        method: "GET",
        pathSegments: ["d1", "database", databaseId],
        query: { fields: "uuid,name" }
      }
    ]);
  });

  it("applies the app database declaration without a provider request", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = createCloudflareD1SetupAdapter({
      transport: recordingTransport(requests, () => {
        throw new Error("unexpected request");
      }),
      database: { mode: "create", baseName: "tenantscript-control-plane" }
    });

    await expect(
      adapter.reconcile({
        runId,
        idempotencyKey: deriveSetupOperationIdempotencyKey(runId, declareOperation.id, "reconcile"),
        operation: declareOperation
      })
    ).resolves.toEqual({ disposition: "applied" });
    expect(requests).toEqual([]);
  });

  it.each([
    { mode: "create", baseName: "../operator-secret" },
    { mode: "create", baseName: "UPPERCASE" },
    { mode: "adopt", databaseId: "../../operator-secret" },
    { mode: "create", baseName: "valid-name", databaseId },
    { mode: "adopt", databaseId, baseName: "valid-name" }
  ])("rejects invalid configuration before a provider request", (database) => {
    const requests: RecordedRequest[] = [];
    expect(() =>
      createCloudflareD1SetupAdapter({
        transport: recordingTransport(requests, () => null),
        database: database as never
      })
    ).toThrow(CloudflareD1SetupAdapterError);
    expect(requests).toEqual([]);
  });

  it.each(["non-array list", "duplicate exact matches", "invalid UUID", "wrong create name"])(
    "fails closed for %s",
    async (scenario) => {
      const adapter = createCloudflareD1SetupAdapter({
        transport: scenarioTransport(scenario),
        database: { mode: "create", baseName: "tenantscript-control-plane" }
      });

      const error = await captureAdapterError(
        adapter.reconcile({ runId, idempotencyKey: reconcileKey, operation: createOperation })
      );
      expect(error.code).toBe("cloudflare_d1_invalid_response");
      expect(JSON.stringify(error)).not.toContain("operator-secret");
    }
  );

  it("rejects unknown provider response fields instead of widening the schema", async () => {
    const adapter = createCloudflareD1SetupAdapter({
      transport: recordingTransport([], (request) => {
        const name = request.query?.name ?? "";
        return [{ uuid: databaseId, name, unexpected: "operator-secret" }];
      }),
      database: { mode: "create", baseName: "tenantscript-control-plane" }
    });

    const error = await captureAdapterError(
      adapter.reconcile({ runId, idempotencyKey: reconcileKey, operation: createOperation })
    );
    expect(error.code).toBe("cloudflare_d1_invalid_response");
    expect(JSON.stringify(error)).not.toContain("operator-secret");
  });

  it("rejects idempotency-key drift before a provider request", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = createCloudflareD1SetupAdapter({
      transport: recordingTransport(requests, () => null),
      database: { mode: "create", baseName: "tenantscript-control-plane" }
    });

    const error = await captureAdapterError(
      adapter.reconcile({
        runId,
        idempotencyKey: `tssetup-${"0".repeat(64)}`,
        operation: createOperation
      })
    );
    expect(error.code).toBe("cloudflare_d1_invalid_request");
    expect(requests).toEqual([]);
  });

  it("does not replay D1 create through the real transport after a provider failure", async () => {
    const methods: string[] = [];
    const transport = createCloudflareApiTransport({
      accountId: "0123456789abcdef0123456789abcdef",
      apiToken: "d1-adapter-secret-sentinel",
      fetch: (_input, init) => {
        methods.push(String(init.method));
        return Promise.resolve(
          init.method === "GET"
            ? jsonResponse({ success: true, result: [] })
            : jsonResponse(
                {
                  success: false,
                  result: null,
                  errors: [{ message: "d1-adapter-secret-sentinel" }]
                },
                { status: 503 }
              )
        );
      }
    });
    const adapter = createCloudflareD1SetupAdapter({
      transport,
      database: { mode: "create", baseName: "tenantscript-control-plane" }
    });

    const error = await captureApiError(
      adapter.reconcile({ runId, idempotencyKey: reconcileKey, operation: createOperation })
    );
    expect(error.code).toBe("cloudflare_api_unavailable");
    expect(methods).toEqual(["GET", "POST"]);
    expect(JSON.stringify(error)).not.toContain("d1-adapter-secret-sentinel");
  });

  it("rejects unsupported setup operations without a provider request", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = createCloudflareD1SetupAdapter({
      transport: recordingTransport(requests, () => null),
      database: { mode: "create", baseName: "tenantscript-control-plane" }
    });

    const unsupported = operation("create:artifact-r2");
    const error = await captureAdapterError(
      adapter.reconcile({
        runId,
        idempotencyKey: deriveSetupOperationIdempotencyKey(runId, unsupported.id, "reconcile"),
        operation: unsupported
      })
    );
    expect(error.code).toBe("cloudflare_d1_unsupported_operation");
    expect(requests).toEqual([]);
  });

  it("verifies deterministic ownership before deleting a created D1 database", async () => {
    const requests: RecordedRequest[] = [];
    let derivedName = "";
    const transport = recordingTransport(requests, (request) => {
      if (request.method === "GET" && request.pathSegments.length === 2) {
        derivedName = String(request.query?.name);
        return [];
      }
      if (request.method === "POST") {
        return { uuid: databaseId, name: requireRecord(request.body).name };
      }
      if (request.method === "GET") return { uuid: databaseId, name: derivedName };
      return {};
    });
    const adapter = createCloudflareD1SetupAdapter({
      transport,
      database: { mode: "create", baseName: "tenantscript-control-plane" }
    });
    await adapter.reconcile({ runId, idempotencyKey: reconcileKey, operation: createOperation });
    requests.length = 0;

    await expect(
      adapter.cleanupCreated({
        runId,
        idempotencyKey: cleanupKey,
        operation: createOperation,
        resourceRef: `d1:${databaseId}`
      })
    ).resolves.toBeUndefined();
    expect(requests).toEqual([
      {
        method: "GET",
        pathSegments: ["d1", "database", databaseId],
        query: { fields: "uuid,name" }
      },
      { method: "DELETE", pathSegments: ["d1", "database", databaseId] }
    ]);
  });

  it("fails cleanup before DELETE when resource ownership does not match", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = createCloudflareD1SetupAdapter({
      transport: recordingTransport(requests, () => ({
        uuid: databaseId,
        name: "operator-owned-database"
      })),
      database: { mode: "create", baseName: "tenantscript-control-plane" }
    });

    const error = await captureAdapterError(
      adapter.cleanupCreated({
        runId,
        idempotencyKey: cleanupKey,
        operation: createOperation,
        resourceRef: `d1:${databaseId}`
      })
    );
    expect(error.code).toBe("cloudflare_d1_ownership_mismatch");
    expect(requests).toHaveLength(1);
  });

  it("treats an already absent created database as idempotent cleanup success", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = createCloudflareD1SetupAdapter({
      transport: recordingTransport(requests, () => {
        throw new CloudflareApiError("cloudflare_api_request_failed", 404);
      }),
      database: { mode: "create", baseName: "tenantscript-control-plane" }
    });

    await expect(
      adapter.cleanupCreated({
        runId,
        idempotencyKey: cleanupKey,
        operation: createOperation,
        resourceRef: `d1:${databaseId}`
      })
    ).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it("never cleans up through an adopt-mode adapter", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = createCloudflareD1SetupAdapter({
      transport: recordingTransport(requests, () => null),
      database: { mode: "adopt", databaseId }
    });

    const error = await captureAdapterError(
      adapter.cleanupCreated({
        runId,
        idempotencyKey: cleanupKey,
        operation: createOperation,
        resourceRef: `d1:${databaseId}`
      })
    );
    expect(error.code).toBe("cloudflare_d1_invalid_request");
    expect(requests).toEqual([]);
  });

  it.each([
    [declareOperation, `d1:${databaseId}`],
    [createOperation, `d1:../../operator-secret`]
  ])(
    "rejects cleanup operation or resource-ref drift before a provider request",
    async (op, ref) => {
      const requests: RecordedRequest[] = [];
      const adapter = createCloudflareD1SetupAdapter({
        transport: recordingTransport(requests, () => null),
        database: { mode: "create", baseName: "tenantscript-control-plane" }
      });

      const error = await captureAdapterError(
        adapter.cleanupCreated({
          runId,
          idempotencyKey: cleanupKey,
          operation: op,
          resourceRef: ref
        })
      );
      expect(error.code).toBe("cloudflare_d1_invalid_request");
      expect(requests).toEqual([]);
    }
  );
});

interface RecordedRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathSegments: readonly string[];
  query?: Readonly<Record<string, string>>;
  body?: unknown;
}

function recordingTransport(
  requests: RecordedRequest[],
  respond: (request: RecordedRequest) => unknown
): CloudflareApiTransport {
  return {
    request: (request) => {
      requests.push(structuredClone(request));
      return Promise.resolve(respond(request));
    }
  };
}

function scenarioTransport(scenario: string): CloudflareApiTransport {
  return {
    request: (request) => {
      if (request.method === "GET") {
        const name = request.query?.name ?? "";
        if (scenario === "non-array list") return Promise.resolve({ uuid: databaseId, name });
        if (scenario === "duplicate exact matches") {
          return Promise.resolve([
            { uuid: databaseId, name },
            { uuid: "223e4567-e89b-12d3-a456-426614174000", name }
          ]);
        }
        if (scenario === "invalid UUID") {
          return Promise.resolve([{ uuid: "operator-secret", name }]);
        }
        return Promise.resolve([]);
      }
      const expectedName = String(requireRecord(request.body).name);
      return Promise.resolve({
        uuid: databaseId,
        name: scenario === "wrong create name" ? "operator-secret" : expectedName
      });
    }
  };
}

function operation(id: string): SetupOperation {
  const found = createProductionSetupPlan("cloudflare-workers").operations.find(
    (item) => item.id === id
  );
  if (found === undefined) throw new Error(`missing setup operation ${id}`);
  return found;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected record");
  }
  return value as Record<string, unknown>;
}

async function captureAdapterError(value: unknown): Promise<CloudflareD1SetupAdapterError> {
  try {
    await value;
  } catch (error) {
    if (error instanceof CloudflareD1SetupAdapterError) return error;
    throw error;
  }
  throw new Error("expected D1 setup adapter failure");
}

async function captureApiError(value: unknown): Promise<CloudflareApiError> {
  try {
    await value;
  } catch (error) {
    if (error instanceof CloudflareApiError) return error;
    throw error;
  }
  throw new Error("expected Cloudflare API failure");
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}
