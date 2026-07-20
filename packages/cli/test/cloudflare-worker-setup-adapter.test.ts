import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CloudflareWorkerSetupAdapterError,
  createCloudflareWorkerSetupAdapter,
  createProductionSetupPlan,
  deriveControlPlaneWorkerName,
  deriveSetupOperationIdempotencyKey,
  WranglerWorkerDeployProcessError,
  type CloudflareApiTransport,
  type SetupOperation,
  type WranglerWorkerDeployProcess
} from "../src/index.js";

const runId = "setup-run-worker-213";
const operation = requireWorkerOperation();
const workerName = deriveControlPlaneWorkerName("tenantscript-control-plane", runId);
const scriptId = "023e105f4ecef8ad9ca31a8372d0c353";

describe("Cloudflare Worker setup adapter", () => {
  it("deploys one absent deterministic target with an atomic ownership marker", async () => {
    const requests: RecordedRequest[] = [];
    const deployments: DeployRequest[] = [];
    let search = 0;
    const adapter = createAdapter(requests, deployments, (request) => {
      if (request.pathSegments.at(-1) === "settings") return settings(deployments[0]?.ownershipTag);
      search += 1;
      return search === 1 ? [] : [worker(scriptId, workerName)];
    });

    const result = await adapter.reconcile(reconcileRequest("initial"));

    expect(result).toEqual({
      disposition: "created",
      resourceRef: `worker:${workerName}:${sha256(scriptId)}`
    });
    expect(deployments).toHaveLength(1);
    expect(deployments[0]?.configPath).toBe("wrangler.jsonc");
    expect(deployments[0]?.workerName).toBe(workerName);
    expect(deployments[0]?.ownershipTag).toMatch(/^tenantscript-setup-[0-9a-f]{32}$/u);
    expect(requests).toEqual([
      searchRequest(workerName),
      searchRequest(workerName),
      settingsRequest(workerName)
    ]);
  });

  it("rejects an existing initial target without deployment or implicit adoption", async () => {
    const deployments: DeployRequest[] = [];
    const adapter = createAdapter([], deployments, () => [worker(scriptId, workerName)]);

    await expect(adapter.reconcile(reconcileRequest("initial"))).rejects.toMatchObject({
      code: "cloudflare_worker_target_exists"
    });
    expect(deployments).toEqual([]);
  });

  it("resumes a checkpoint-lost deployment only when the provider marker matches", async () => {
    const requests: RecordedRequest[] = [];
    const deployments: DeployRequest[] = [];
    const expectedTag = ownershipTag();
    const adapter = createAdapter(requests, deployments, (request) =>
      request.pathSegments.at(-1) === "settings"
        ? settings(expectedTag)
        : [worker(scriptId, workerName)]
    );

    await expect(adapter.reconcile(reconcileRequest("resume"))).resolves.toEqual({
      disposition: "created",
      resourceRef: `worker:${workerName}:${sha256(scriptId)}`
    });
    expect(deployments).toEqual([]);
    expect(requests).toEqual([searchRequest(workerName), settingsRequest(workerName)]);
  });

  it("fails closed when a resumed target has a different ownership marker", async () => {
    const deployments: DeployRequest[] = [];
    const adapter = createAdapter([], deployments, (request) =>
      request.pathSegments.at(-1) === "settings"
        ? settings("tenantscript-setup-00000000000000000000000000000000")
        : [worker(scriptId, workerName)]
    );

    await expect(adapter.reconcile(reconcileRequest("resume"))).rejects.toMatchObject({
      code: "cloudflare_worker_ownership_mismatch"
    });
    expect(deployments).toEqual([]);
  });

  it("reconciles an ambiguous deploy failure by read without replaying mutation", async () => {
    const requests: RecordedRequest[] = [];
    const deployments: DeployRequest[] = [];
    let search = 0;
    const adapter = createAdapter(
      requests,
      deployments,
      (request) => {
        if (request.pathSegments.at(-1) === "settings") return settings(ownershipTag());
        search += 1;
        return search === 1 ? [] : [worker(scriptId, workerName)];
      },
      () => {
        throw new WranglerWorkerDeployProcessError();
      }
    );

    await expect(adapter.reconcile(reconcileRequest("initial"))).resolves.toMatchObject({
      disposition: "created"
    });
    expect(deployments).toHaveLength(1);
    expect(requests).toEqual([
      searchRequest(workerName),
      searchRequest(workerName),
      settingsRequest(workerName)
    ]);
  });

  it("adopts only the explicitly configured exact Worker without deployment", async () => {
    const deployments: DeployRequest[] = [];
    const requests: RecordedRequest[] = [];
    const adapter = createCloudflareWorkerSetupAdapter({
      transport: transport(requests, () => [worker(scriptId, "operator-worker")]),
      deployProcess: deployProcess(deployments),
      worker: { mode: "adopt", workerName: "operator-worker" }
    });

    await expect(adapter.reconcile(reconcileRequest("initial"))).resolves.toEqual({
      disposition: "adopted",
      resourceRef: `worker:operator-worker:${sha256(scriptId)}`
    });
    expect(deployments).toEqual([]);
  });

  it("deletes only a created Worker whose target, immutable ID, and marker still match", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = createAdapter(requests, [], (request) => {
      if (request.method === "DELETE") return null;
      return request.pathSegments.at(-1) === "settings"
        ? settings(ownershipTag())
        : [worker(scriptId, workerName)];
    });

    await expect(
      adapter.cleanupCreated(cleanupRequest(`worker:${workerName}:${sha256(scriptId)}`))
    ).resolves.toBeUndefined();
    expect(requests).toEqual([
      searchRequest(workerName),
      settingsRequest(workerName),
      { method: "DELETE", pathSegments: ["workers", "scripts", workerName] }
    ]);
  });

  it("refuses cleanup after immutable ID or ownership marker drift", async () => {
    for (const drift of ["id", "marker"] as const) {
      const requests: RecordedRequest[] = [];
      const adapter = createAdapter(requests, [], (request) => {
        if (request.pathSegments.at(-1) === "settings") {
          return settings(
            drift === "marker"
              ? "tenantscript-setup-00000000000000000000000000000000"
              : ownershipTag()
          );
        }
        return [worker(drift === "id" ? "different-worker-id" : scriptId, workerName)];
      });

      await expect(
        adapter.cleanupCreated(cleanupRequest(`worker:${workerName}:${sha256(scriptId)}`))
      ).rejects.toMatchObject({ code: "cloudflare_worker_ownership_mismatch" });
      expect(requests.every((request) => request.method !== "DELETE")).toBe(true);
    }
  });

  it("treats an already absent created Worker as idempotent cleanup success", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = createAdapter(requests, [], () => []);

    await expect(
      adapter.cleanupCreated(cleanupRequest(`worker:${workerName}:${sha256(scriptId)}`))
    ).resolves.toBeUndefined();
    expect(requests).toEqual([searchRequest(workerName)]);
  });

  it("rejects partial, duplicate, and malformed provider observations", async () => {
    for (const response of [
      [worker(scriptId, `${workerName}-partial`)],
      [worker(scriptId, workerName), worker("another-id", workerName)],
      [{ id: scriptId, script_name: workerName, unknown: "secret-sentinel" }]
    ]) {
      const adapter = createAdapter([], [], () => response);
      await expect(adapter.reconcile(reconcileRequest("resume"))).rejects.toBeInstanceOf(
        CloudflareWorkerSetupAdapterError
      );
    }
  });

  it("rejects request drift before provider or process access", async () => {
    const requests: RecordedRequest[] = [];
    const deployments: DeployRequest[] = [];
    const adapter = createAdapter(requests, deployments, () => []);

    await expect(
      adapter.reconcile({ ...reconcileRequest("initial"), attempt: "retry" } as never)
    ).rejects.toMatchObject({ code: "cloudflare_worker_invalid_request" });
    await expect(
      adapter.cleanupCreated({
        ...cleanupRequest(`worker:${workerName}:${sha256(scriptId)}`),
        idempotencyKey: deriveSetupOperationIdempotencyKey(runId, operation.id, "reconcile")
      })
    ).rejects.toMatchObject({ code: "cloudflare_worker_invalid_request" });
    await expect(
      adapter.reconcile({
        ...reconcileRequest("initial"),
        operation: { ...operation, dependsOn: [] }
      })
    ).rejects.toMatchObject({ code: "cloudflare_worker_invalid_request" });
    await expect(
      adapter.reconcile({
        ...reconcileRequest("initial"),
        operation: {
          ...operation,
          dependsOn: [
            ...operation.dependsOn.slice(0, 3),
            "create:admin-rate-limiter-do",
            ...operation.dependsOn.slice(3)
          ]
        }
      })
    ).rejects.toMatchObject({ code: "cloudflare_worker_invalid_request" });
    await expect(
      adapter.reconcile({
        ...reconcileRequest("initial"),
        operation: {
          ...operation,
          dependsOn: operation.dependsOn.map((dependency) =>
            dependency === "declare:usage-analytics-engine-binding"
              ? "create:usage-analytics-engine"
              : dependency
          )
        }
      })
    ).rejects.toMatchObject({ code: "cloudflare_worker_invalid_request" });
    expect(requests).toEqual([]);
    expect(deployments).toEqual([]);
  });
});

function createAdapter(
  requests: RecordedRequest[],
  deployments: DeployRequest[],
  handle: (request: RecordedRequest) => unknown,
  deploy?: (request: DeployRequest) => void
) {
  return createCloudflareWorkerSetupAdapter({
    transport: transport(requests, handle),
    deployProcess: deployProcess(deployments, deploy),
    worker: { mode: "create", baseName: "tenantscript-control-plane", configPath: "wrangler.jsonc" }
  });
}

function reconcileRequest(attempt: "initial" | "resume") {
  return {
    runId,
    idempotencyKey: deriveSetupOperationIdempotencyKey(runId, operation.id, "reconcile"),
    attempt,
    operation
  } as const;
}

function cleanupRequest(resourceRef: string) {
  return {
    runId,
    idempotencyKey: deriveSetupOperationIdempotencyKey(runId, operation.id, "cleanup"),
    operation,
    resourceRef
  };
}

function requireWorkerOperation(): SetupOperation {
  const value = createProductionSetupPlan("cloudflare-workers").operations.find(
    (candidate) => candidate.id === "create:control-plane-worker"
  );
  if (value === undefined) throw new Error("missing Worker operation");
  return value;
}

function ownershipTag(): string {
  const key = deriveSetupOperationIdempotencyKey(runId, operation.id, "reconcile");
  return `tenantscript-setup-${sha256(key).slice(0, 32)}`;
}

function worker(id: string, name: string): Record<string, unknown> {
  return {
    id,
    script_name: name,
    created_on: "2026-07-20T00:00:00Z",
    modified_on: "2026-07-20T00:00:00Z",
    environment_is_default: true
  };
}

function settings(tag: string | undefined): Record<string, unknown> {
  return { annotations: tag === undefined ? {} : { "workers/tag": tag } };
}

function searchRequest(name: string): RecordedRequest {
  return {
    method: "GET",
    pathSegments: ["workers", "scripts-search"],
    query: { name, page: "1", per_page: "10" }
  };
}

function settingsRequest(name: string): RecordedRequest {
  return { method: "GET", pathSegments: ["workers", "scripts", name, "settings"] };
}

interface RecordedRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathSegments: readonly string[];
  query?: Readonly<Record<string, string>>;
  body?: unknown;
}

interface DeployRequest {
  configPath: string;
  workerName: string;
  ownershipTag: string;
}

function transport(
  requests: RecordedRequest[],
  handle: (request: RecordedRequest) => unknown
): CloudflareApiTransport {
  return {
    request: async (request) => {
      requests.push(request);
      return await handle(request);
    }
  };
}

function deployProcess(
  deployments: DeployRequest[],
  handle?: (request: DeployRequest) => void
): WranglerWorkerDeployProcess {
  return {
    deploy: (request) => {
      deployments.push(request);
      handle?.(request);
    }
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
