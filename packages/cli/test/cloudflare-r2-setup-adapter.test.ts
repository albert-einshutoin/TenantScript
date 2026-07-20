import { describe, expect, it } from "vitest";
import {
  CloudflareApiError,
  CloudflareR2SetupAdapterError,
  createCloudflareApiTransport,
  createCloudflareR2SetupAdapter,
  createProductionSetupPlan,
  deriveSetupOperationIdempotencyKey,
  type CloudflareApiTransport,
  type SetupOperation
} from "../src/index.js";

const runId = "setup-run-197";
const artifacts = operation("create:artifact-r2");
const archive = operation("create:execution-archive-r2");

describe("Cloudflare R2 setup adapter", () => {
  it.each([
    [artifacts, "tenantscript-artifacts"],
    [archive, "tenantscript-execution-archive"]
  ] as const)("creates a deterministic bucket for %s after an exact miss", async (op, baseName) => {
    const requests: RecordedRequest[] = [];
    const adapter = createAdapter(requests, (request) => {
      if (request.method === "GET") throw notFound();
      return {
        name: requireRecord(request.body).name,
        jurisdiction: "eu",
        storage_class: "Standard"
      };
    });

    const result = await adapter.reconcile(reconcileRequest(op));
    expect(result.disposition).toBe("created");
    expect("resourceRef" in result ? result.resourceRef : "").toMatch(
      /^r2:[a-z0-9-]+-[0-9a-f]{24}$/u
    );
    const expectedName = requests[0]?.pathSegments[2];
    expect(expectedName).toMatch(new RegExp(`^${baseName}-[0-9a-f]{24}$`, "u"));
    expect(requests).toEqual([
      {
        method: "GET",
        pathSegments: ["r2", "buckets", expectedName],
        r2Jurisdiction: "eu"
      },
      {
        method: "POST",
        pathSegments: ["r2", "buckets"],
        r2Jurisdiction: "eu",
        body: { name: expectedName, locationHint: "apac", storageClass: "Standard" }
      }
    ]);
  });

  it("uses different deterministic names for the two authority boundaries", async () => {
    const names: string[] = [];
    const adapter = createAdapter([], (request) => {
      if (request.method === "GET") throw notFound();
      const name = String(requireRecord(request.body).name);
      names.push(name);
      return { name, jurisdiction: "eu", storage_class: "Standard" };
    });

    await adapter.reconcile(reconcileRequest(artifacts));
    await adapter.reconcile(reconcileRequest(archive));
    expect(names[0]).not.toBe(names[1]);
  });

  it("resumes a lost create response by observing the exact bucket without replaying POST", async () => {
    const requests: RecordedRequest[] = [];
    const expectedName = derivedName("tenantscript-artifacts", artifacts);
    const adapter = createAdapter(requests, () => ({
      name: expectedName,
      jurisdiction: "eu",
      location: "apac",
      storage_class: "Standard",
      creation_date: "2026-07-20T00:00:00Z"
    }));

    await expect(adapter.reconcile(reconcileRequest(artifacts))).resolves.toEqual({
      disposition: "created",
      resourceRef: `r2:${expectedName}`
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
  });

  it("adopts only explicitly configured exact buckets without mutation", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = createCloudflareR2SetupAdapter({
      transport: recordingTransport(requests, () => ({
        name: "operator-artifacts",
        jurisdiction: "eu"
      })),
      buckets: {
        artifacts: { mode: "adopt", bucketName: "operator-artifacts", jurisdiction: "eu" },
        executionArchive: { mode: "adopt", bucketName: "operator-archive" }
      }
    });

    await expect(adapter.reconcile(reconcileRequest(artifacts))).resolves.toEqual({
      disposition: "adopted",
      resourceRef: "r2:operator-artifacts"
    });
    expect(requests).toEqual([
      {
        method: "GET",
        pathSegments: ["r2", "buckets", "operator-artifacts"],
        r2Jurisdiction: "eu"
      }
    ]);
  });

  it("keeps automatic location and default storage implicit", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = createCloudflareR2SetupAdapter({
      transport: recordingTransport(requests, (request) => {
        if (request.method === "GET") throw notFound();
        return { name: requireRecord(request.body).name };
      }),
      buckets: {
        artifacts: { mode: "create", baseName: "minimal-artifacts" },
        executionArchive: { mode: "create", baseName: "minimal-archive" }
      }
    });

    await adapter.reconcile(reconcileRequest(artifacts));
    expect(requests[0]).not.toHaveProperty("r2Jurisdiction");
    expect(requests[1]).toEqual({
      method: "POST",
      pathSegments: ["r2", "buckets"],
      body: { name: requests[0]?.pathSegments[2] }
    });
  });

  it.each([
    ["wrong name", { name: "operator-secret", jurisdiction: "eu", storage_class: "Standard" }],
    [
      "wrong jurisdiction",
      {
        name: derivedName("tenantscript-artifacts", artifacts),
        jurisdiction: "default",
        storage_class: "Standard"
      }
    ],
    [
      "wrong storage class",
      {
        name: derivedName("tenantscript-artifacts", artifacts),
        jurisdiction: "eu",
        storage_class: "InfrequentAccess"
      }
    ],
    [
      "unknown field",
      {
        name: derivedName("tenantscript-artifacts", artifacts),
        jurisdiction: "eu",
        storage_class: "Standard",
        secret: "operator-secret"
      }
    ]
  ])("fails closed for %s provider response", async (_scenario, response) => {
    const adapter = createAdapter([], () => response);
    const error = await captureAdapterError(adapter.reconcile(reconcileRequest(artifacts)));
    expect(error.code).toBe("cloudflare_r2_invalid_response");
    expect(JSON.stringify(error)).not.toContain("operator-secret");
  });

  it.each([
    {
      artifacts: { mode: "create", baseName: "../secret" },
      executionArchive: { mode: "create", baseName: "valid-archive" }
    },
    {
      artifacts: { mode: "adopt", bucketName: "same-bucket" },
      executionArchive: { mode: "adopt", bucketName: "same-bucket" }
    },
    {
      artifacts: { mode: "create", baseName: "valid-artifacts", locationHint: "secret" },
      executionArchive: { mode: "create", baseName: "valid-archive" }
    },
    {
      artifacts: { mode: "create", baseName: "valid-artifacts", extra: true },
      executionArchive: { mode: "create", baseName: "valid-archive" }
    }
  ])("rejects invalid configuration before provider access", (buckets) => {
    const requests: RecordedRequest[] = [];
    expect(() =>
      createCloudflareR2SetupAdapter({
        transport: recordingTransport(requests, () => null),
        buckets: buckets as never
      })
    ).toThrow(CloudflareR2SetupAdapterError);
    expect(requests).toEqual([]);
  });

  it("rejects idempotency and operation metadata drift before provider access", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = createAdapter(requests, () => null);
    const error = await captureAdapterError(
      adapter.reconcile({
        ...reconcileRequest(artifacts),
        idempotencyKey: `tssetup-${"0".repeat(64)}`
      })
    );
    expect(error.code).toBe("cloudflare_r2_invalid_request");
    expect(requests).toEqual([]);
  });

  it("rejects a valid but unsupported setup operation without provider access", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = createAdapter(requests, () => null);
    const unsupported = operation("create:control-plane-d1");
    await expect(adapter.reconcile(reconcileRequest(unsupported))).rejects.toMatchObject({
      code: "cloudflare_r2_unsupported_operation"
    });
    expect(requests).toEqual([]);
  });

  it("does not replay R2 create through the real transport after a provider failure", async () => {
    const methods: string[] = [];
    const transport = createCloudflareApiTransport({
      accountId: "0123456789abcdef0123456789abcdef",
      apiToken: "r2-adapter-secret-sentinel",
      maxGetAttempts: 1,
      fetch: (_input, init) => {
        methods.push(String(init.method));
        return Promise.resolve(
          init.method === "GET"
            ? jsonResponse({ success: false, result: null }, { status: 404 })
            : jsonResponse(
                {
                  success: false,
                  result: null,
                  errors: [{ message: "r2-adapter-secret-sentinel" }]
                },
                { status: 503 }
              )
        );
      }
    });
    const adapter = createCloudflareR2SetupAdapter({
      transport,
      buckets: {
        artifacts: { mode: "create", baseName: "minimal-artifacts" },
        executionArchive: { mode: "create", baseName: "minimal-archive" }
      }
    });

    const error = await captureApiError(adapter.reconcile(reconcileRequest(artifacts)));
    expect(error.code).toBe("cloudflare_api_unavailable");
    expect(methods).toEqual(["GET", "POST"]);
    expect(JSON.stringify(error)).not.toContain("r2-adapter-secret-sentinel");
  });

  it("verifies deterministic ownership before deleting a created bucket", async () => {
    const requests: RecordedRequest[] = [];
    const name = derivedName("tenantscript-artifacts", artifacts);
    const adapter = createAdapter(requests, (request) =>
      request.method === "GET" ? { name, jurisdiction: "eu", storage_class: "Standard" } : {}
    );

    await expect(
      adapter.cleanupCreated({
        runId,
        idempotencyKey: key(artifacts, "cleanup"),
        operation: artifacts,
        resourceRef: `r2:${name}`
      })
    ).resolves.toBeUndefined();
    expect(requests.map((request) => request.method)).toEqual(["GET", "DELETE"]);
    expect(requests[1]).toEqual({
      method: "DELETE",
      pathSegments: ["r2", "buckets", name],
      r2Jurisdiction: "eu"
    });
  });

  it("rejects cross-operation resource references before GET or DELETE", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = createAdapter(requests, () => null);
    const error = await captureAdapterError(
      adapter.cleanupCreated({
        runId,
        idempotencyKey: key(artifacts, "cleanup"),
        operation: artifacts,
        resourceRef: `r2:${derivedName("tenantscript-execution-archive", archive)}`
      })
    );
    expect(error.code).toBe("cloudflare_r2_invalid_request");
    expect(requests).toEqual([]);
  });

  it("fails cleanup before DELETE when observed ownership drifts", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = createAdapter(requests, () => ({
      name: "operator-owned-bucket",
      jurisdiction: "eu",
      storage_class: "Standard"
    }));
    const error = await captureAdapterError(
      adapter.cleanupCreated({
        runId,
        idempotencyKey: key(artifacts, "cleanup"),
        operation: artifacts,
        resourceRef: `r2:${derivedName("tenantscript-artifacts", artifacts)}`
      })
    );
    expect(error.code).toBe("cloudflare_r2_ownership_mismatch");
    expect(requests.map((request) => request.method)).toEqual(["GET"]);
  });

  it("never cleans up an adopted bucket", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = createCloudflareR2SetupAdapter({
      transport: recordingTransport(requests, () => null),
      buckets: {
        artifacts: { mode: "adopt", bucketName: "operator-artifacts" },
        executionArchive: { mode: "create", baseName: "valid-archive" }
      }
    });
    await expect(
      adapter.cleanupCreated({
        runId,
        idempotencyKey: key(artifacts, "cleanup"),
        operation: artifacts,
        resourceRef: "r2:operator-artifacts"
      })
    ).rejects.toMatchObject({ code: "cloudflare_r2_invalid_request" });
    expect(requests).toEqual([]);
  });

  it("treats an already absent created bucket as idempotent cleanup success", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = createAdapter(requests, () => {
      throw notFound();
    });
    await expect(
      adapter.cleanupCreated({
        runId,
        idempotencyKey: key(artifacts, "cleanup"),
        operation: artifacts,
        resourceRef: `r2:${derivedName("tenantscript-artifacts", artifacts)}`
      })
    ).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
  });
});

function createAdapter(
  requests: RecordedRequest[],
  respond: (request: RecordedRequest) => unknown
) {
  return createCloudflareR2SetupAdapter({
    transport: recordingTransport(requests, respond),
    buckets: {
      artifacts: {
        mode: "create",
        baseName: "tenantscript-artifacts",
        locationHint: "apac",
        jurisdiction: "eu",
        storageClass: "Standard"
      },
      executionArchive: {
        mode: "create",
        baseName: "tenantscript-execution-archive",
        locationHint: "apac",
        jurisdiction: "eu",
        storageClass: "Standard"
      }
    }
  });
}

interface RecordedRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathSegments: readonly string[];
  query?: Readonly<Record<string, string>>;
  body?: unknown;
  r2Jurisdiction?: "default" | "eu" | "fedramp";
}

function recordingTransport(
  requests: RecordedRequest[],
  respond: (request: RecordedRequest) => unknown
): CloudflareApiTransport {
  return {
    request: (request) => {
      requests.push(structuredClone(request));
      return Promise.resolve().then(() => respond(request));
    }
  };
}

function reconcileRequest(op: SetupOperation) {
  return { runId, idempotencyKey: key(op, "reconcile"), operation: op };
}

function key(op: SetupOperation, action: "reconcile" | "cleanup"): string {
  return deriveSetupOperationIdempotencyKey(runId, op.id, action);
}

function derivedName(baseName: string, op: SetupOperation): string {
  // The exact digest is intentionally asserted through adapter behavior; this helper is replaced
  // with the observed stable output once the public derivation contract exists.
  const keyValue = key(op, "reconcile");
  return `${baseName}-${sha256Prefix(keyValue)}`;
}

function sha256Prefix(value: string): string {
  // Web Crypto is async, while fixtures must be synchronous. These are fixed TDD vectors for the
  // two operation keys and keep the test independent from a non-public production helper.
  const vectors: Record<string, string> = {
    [key(artifacts, "reconcile")]: "dc61af47dc53334b116c9413",
    [key(archive, "reconcile")]: "ef113147c52c46fc03ed5bba"
  };
  return vectors[value] ?? "missing-vector";
}

function operation(id: string): SetupOperation {
  const found = createProductionSetupPlan("cloudflare-workers").operations.find(
    (candidate) => candidate.id === id
  );
  if (found === undefined) throw new Error(`missing operation ${id}`);
  return found;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected record");
  }
  return value as Record<string, unknown>;
}

function notFound(): CloudflareApiError {
  return new CloudflareApiError("cloudflare_api_request_failed", 404);
}

async function captureAdapterError(value: unknown): Promise<CloudflareR2SetupAdapterError> {
  try {
    await value;
  } catch (error) {
    if (error instanceof CloudflareR2SetupAdapterError) return error;
    throw error;
  }
  throw new Error("expected R2 setup adapter failure");
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
