import { describe, expect, it } from "vitest";
import {
  CloudflareD1SetupAdapterError,
  SetupProviderRouterError,
  createCloudflareD1SetupAdapter,
  createProductionSetupPlan,
  createSetupProviderRouter,
  deriveSetupOperationIdempotencyKey,
  type CloudflareApiTransport,
  type SetupOperation,
  type SetupProviderAdapter
} from "../src/index.js";

const runId = "setup-run-193";
const databaseId = "123e4567-e89b-12d3-a456-426614174000";
const createD1 = operation("create:control-plane-d1");
const declareD1 = operation("declare:app-database-boundary");
const createR2 = operation("create:artifact-r2");

describe("setup provider router", () => {
  it("routes exact operation IDs to their owner independent of route order", async () => {
    const calls: string[] = [];
    const d1 = recordingAdapter("d1", calls);
    const r2 = recordingAdapter("r2", calls);
    const router = createSetupProviderRouter({
      routes: [
        { operationIds: [createR2.id], adapter: r2 },
        { operationIds: [createD1.id, declareD1.id], adapter: d1 }
      ]
    });

    await router.reconcile(reconcileRequest(createD1));
    await router.reconcile(reconcileRequest(createR2));
    await router.reconcile(reconcileRequest(declareD1));

    expect(calls).toEqual([
      `d1:reconcile:${createD1.id}`,
      `r2:reconcile:${createR2.id}`,
      `d1:reconcile:${declareD1.id}`
    ]);
  });

  it("routes cleanup by journal operation ownership instead of resource reference", async () => {
    const calls: string[] = [];
    const router = createSetupProviderRouter({
      routes: [
        { operationIds: [createD1.id], adapter: recordingAdapter("d1", calls) },
        { operationIds: [createR2.id], adapter: recordingAdapter("r2", calls) }
      ]
    });

    await router.cleanupCreated({
      runId,
      idempotencyKey: key(createD1, "cleanup"),
      operation: createD1,
      resourceRef: "r2:attacker-controlled"
    });

    expect(calls).toEqual([`d1:cleanup:${createD1.id}:r2:attacker-controlled`]);
  });

  it("fails closed for an unregistered operation without calling a delegate", async () => {
    const calls: string[] = [];
    const router = createSetupProviderRouter({
      routes: [{ operationIds: [createD1.id], adapter: recordingAdapter("d1", calls) }]
    });

    const error = await captureRouterError(router.reconcile(reconcileRequest(createR2)));

    expect(error.code).toBe("setup_provider_route_not_found");
    expect(error.toJSON()).toEqual({ code: "setup_provider_route_not_found" });
    expect(JSON.stringify(error)).not.toContain(createR2.id);
    expect(calls).toEqual([]);
  });

  it("rejects duplicate operation ownership before any delegate call", () => {
    const calls: string[] = [];
    const adapter = recordingAdapter("d1", calls);

    expect(() =>
      createSetupProviderRouter({
        routes: [
          { operationIds: [createD1.id], adapter },
          { operationIds: [createD1.id], adapter }
        ]
      })
    ).toThrow(expect.objectContaining({ code: "setup_provider_invalid_configuration" }));
    expect(calls).toEqual([]);
  });

  it.each([
    { routes: [] },
    { routes: [{ operationIds: [], adapter: recordingAdapter("empty", []) }] },
    {
      routes: [{ operationIds: ["../unsafe"], adapter: recordingAdapter("unsafe", []) }]
    },
    { routes: [{ operationIds: [createD1.id], adapter: {} }] },
    {
      routes: [
        { operationIds: [createD1.id], adapter: recordingAdapter("extra", []), fallback: true }
      ]
    }
  ])("rejects invalid or widened configuration without reflection", (configuration) => {
    let thrown: unknown;
    try {
      createSetupProviderRouter(configuration as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SetupProviderRouterError);
    expect(thrown).toMatchObject({ code: "setup_provider_invalid_configuration" });
    expect(JSON.stringify(thrown)).not.toContain("unsafe");
  });

  it("preserves delegate typed errors without wrapping or reflecting them", async () => {
    const delegateError = new CloudflareD1SetupAdapterError("cloudflare_d1_invalid_request");
    const adapter: SetupProviderAdapter = {
      reconcile: () => {
        throw delegateError;
      },
      cleanupCreated: () => undefined
    };
    const router = createSetupProviderRouter({
      routes: [{ operationIds: [createD1.id], adapter }]
    });

    await expect(router.reconcile(reconcileRequest(createD1))).rejects.toBe(delegateError);
  });

  it("composes with the real D1 adapter while leaving unregistered resources closed", async () => {
    const providerRequests: string[] = [];
    const transport: CloudflareApiTransport = {
      request: (request) => {
        providerRequests.push(`${request.method}:${request.pathSegments.join("/")}`);
        if (request.method === "GET") return Promise.resolve([]);
        const body = requireRecord(request.body);
        return Promise.resolve({ uuid: databaseId, name: body.name });
      }
    };
    const router = createSetupProviderRouter({
      routes: [
        {
          operationIds: [createD1.id, declareD1.id],
          adapter: createCloudflareD1SetupAdapter({
            transport,
            database: { mode: "create", baseName: "tenantscript-control-plane" }
          })
        }
      ]
    });

    await expect(router.reconcile(reconcileRequest(createD1))).resolves.toEqual({
      disposition: "created",
      resourceRef: `d1:${databaseId}`
    });
    await expect(router.reconcile(reconcileRequest(declareD1))).resolves.toEqual({
      disposition: "applied"
    });
    await expect(router.reconcile(reconcileRequest(createR2))).rejects.toMatchObject({
      code: "setup_provider_route_not_found"
    });
    expect(providerRequests).toEqual(["GET:d1/database", "POST:d1/database"]);
  });
});

function recordingAdapter(name: string, calls: string[]): SetupProviderAdapter {
  return {
    reconcile: (request) => {
      calls.push(`${name}:reconcile:${request.operation.id}`);
      return { disposition: "applied" };
    },
    cleanupCreated: (request) => {
      calls.push(`${name}:cleanup:${request.operation.id}:${request.resourceRef}`);
    }
  };
}

function reconcileRequest(operationValue: SetupOperation) {
  return {
    runId,
    idempotencyKey: key(operationValue, "reconcile"),
    operation: operationValue
  };
}

function key(operationValue: SetupOperation, action: "reconcile" | "cleanup"): string {
  return deriveSetupOperationIdempotencyKey(runId, operationValue.id, action);
}

function operation(id: string): SetupOperation {
  const found = createProductionSetupPlan("cloudflare-workers").operations.find(
    (candidate) => candidate.id === id
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

async function captureRouterError(value: unknown): Promise<SetupProviderRouterError> {
  try {
    await value;
  } catch (error) {
    if (error instanceof SetupProviderRouterError) return error;
    throw error;
  }
  throw new Error("expected setup provider router failure");
}
