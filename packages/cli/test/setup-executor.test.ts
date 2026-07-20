import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileSetupRunJournalStore,
  createInMemorySetupRunJournalStore,
  createProductionSetupPlan,
  createSetupRunJournal,
  executeProductionSetup,
  parseSetupRunJournal,
  SetupRunExecutionError,
  type SetupOperation,
  type SetupProviderAdapter,
  type SetupReconcileResult,
  type SetupRunJournal,
  type SetupRunJournalStore
} from "../src/index.js";

const plan = createProductionSetupPlan("cloudflare-workers");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("production setup executor", () => {
  it("checkpoints created, adopted, and applied operations in plan order", async () => {
    const calls: string[] = [];
    const adapter = adapterFrom({
      reconcile: (operation) => {
        calls.push(operation.id);
        return operation.action === "create"
          ? operation.id === "create:control-plane-d1"
            ? { disposition: "created", resourceRef: "d1:created-by-run" }
            : { disposition: "adopted", resourceRef: `adopted:${operation.id}` }
          : { disposition: "applied" };
      }
    });
    const store = createInMemorySetupRunJournalStore();

    const result = await executeProductionSetup({
      plan,
      runId: "run-001",
      adapter,
      journalStore: store,
      approvedAdoptionOperationIds: plan.operations
        .filter(
          (operation) => operation.action === "create" && operation.id !== "create:control-plane-d1"
        )
        .map((operation) => operation.id)
    });

    expect(calls).toEqual(plan.operations.map((operation) => operation.id));
    expect(result.state).toBe("completed");
    expect(result.entries.map((entry) => entry.phase)).toEqual(
      plan.operations.map(() => "completed")
    );
    expect(result.entries[0]).toMatchObject({
      disposition: "created",
      resourceRef: "d1:created-by-run"
    });
    expect(result.entries[2]).toMatchObject({ disposition: "adopted" });
    expect(result.entries[1]).toMatchObject({ disposition: "applied" });
  });

  it("reconciles an in-progress operation with the same idempotency key after a checkpoint crash", async () => {
    const baseStore = createInMemorySetupRunJournalStore();
    const store = failOneSaveAfterReconcile(baseStore);
    const keys: string[] = [];
    const adapter = adapterFrom({
      reconcile: (operation, idempotencyKey) => {
        keys.push(idempotencyKey);
        store.armFailure();
        return operation.action === "create"
          ? { disposition: "created", resourceRef: `created:${operation.id}` }
          : { disposition: "applied" };
      }
    });

    await expect(
      executeProductionSetup({ plan, runId: "run-crash", adapter, journalStore: store })
    ).rejects.toThrow("synthetic journal write crash");

    store.disableFailure();
    await executeProductionSetup({ plan, runId: "run-crash", adapter, journalStore: store });
    expect(keys[0]).toMatch(/^tssetup-[0-9a-f]{64}$/u);
    expect(keys[1]).toBe(keys[0]);
  });

  it("cleans up only resources created by this run and never adopted resources", async () => {
    const cleanup: string[] = [];
    const adapter = adapterFrom({
      reconcile: (operation) => {
        if (operation.id === "create:admin-rate-limiter-do") {
          throw new Error("provider secret-sentinel");
        }
        if (operation.action !== "create") return { disposition: "applied" };
        return operation.id === "create:artifact-r2"
          ? { disposition: "adopted", resourceRef: "r2:operator-owned" }
          : { disposition: "created", resourceRef: `created:${operation.id}` };
      },
      cleanup: (operation) => {
        cleanup.push(operation.id);
      }
    });
    const store = createInMemorySetupRunJournalStore();

    const error = await captureExecutionError(
      executeProductionSetup({
        plan,
        runId: "run-failure",
        adapter,
        journalStore: store,
        approvedAdoptionOperationIds: ["create:artifact-r2"]
      })
    );

    expect(error.code).toBe("setup_run_failed");
    expect(cleanup).toEqual(["create:execution-archive-r2", "create:control-plane-d1"]);
    expect(JSON.stringify(error)).not.toContain("secret-sentinel");
    expect(JSON.stringify(await store.load())).not.toContain("secret-sentinel");
  });

  it("continues reverse cleanup after one cleanup failure and reports only stable operation ids", async () => {
    const cleanup: string[] = [];
    const adapter = adapterFrom({
      reconcile: (operation) => {
        if (operation.id === "create:admin-rate-limiter-do") throw new Error("apply failed");
        return operation.action === "create"
          ? { disposition: "created", resourceRef: `created:${operation.id}` }
          : { disposition: "applied" };
      },
      cleanup: (operation) => {
        cleanup.push(operation.id);
        if (operation.id === "create:artifact-r2") throw new Error("secret-sentinel");
      }
    });

    const error = await captureExecutionError(
      executeProductionSetup({
        plan,
        runId: "run-cleanup-failure",
        adapter,
        journalStore: createInMemorySetupRunJournalStore()
      })
    );

    expect(error.code).toBe("setup_cleanup_incomplete");
    expect(cleanup).toEqual([
      "create:execution-archive-r2",
      "create:artifact-r2",
      "create:control-plane-d1"
    ]);
    expect(error.operationIds).toEqual(["create:artifact-r2"]);
    expect(JSON.stringify(error)).not.toContain("secret-sentinel");
  });

  it("rejects adoption without operation-level operator approval", async () => {
    const cleanup: string[] = [];
    const adapter = adapterFrom({
      reconcile: (operation) =>
        operation.action === "create"
          ? operation.id === "create:control-plane-d1"
            ? { disposition: "created", resourceRef: "d1:created" }
            : { disposition: "adopted", resourceRef: `existing:${operation.id}` }
          : { disposition: "applied" },
      cleanup: (operation) => {
        cleanup.push(operation.id);
      }
    });

    const error = await captureExecutionError(
      executeProductionSetup({
        plan,
        runId: "run-unapproved-adoption",
        adapter,
        journalStore: createInMemorySetupRunJournalStore()
      })
    );
    expect(error.code).toBe("setup_run_failed");
    expect(cleanup).toEqual(["create:control-plane-d1"]);
  });

  it("retries cleanup with the same idempotency key after its success checkpoint crashes", async () => {
    const baseStore = createInMemorySetupRunJournalStore();
    const store = failOneSaveAfterReconcile(baseStore);
    const cleanupKeys: string[] = [];
    const adapter: SetupProviderAdapter = {
      reconcile: ({ operation }) => {
        if (operation.id === "create:admin-rate-limiter-do") throw new Error("apply failed");
        return operation.action === "create"
          ? { disposition: "created", resourceRef: `created:${operation.id}` }
          : { disposition: "applied" };
      },
      cleanupCreated: ({ operation, idempotencyKey }) => {
        cleanupKeys.push(idempotencyKey);
        if (operation.id === "create:execution-archive-r2" && cleanupKeys.length === 1) {
          store.armFailure();
        }
      }
    };

    await expect(
      executeProductionSetup({ plan, runId: "run-cleanup-crash", adapter, journalStore: store })
    ).rejects.toThrow("synthetic journal write crash");

    store.disableFailure();
    await expect(
      executeProductionSetup({ plan, runId: "run-cleanup-crash", adapter, journalStore: store })
    ).rejects.toBeInstanceOf(SetupRunExecutionError);
    expect(cleanupKeys[1]).toBe(cleanupKeys[0]);
  });
});

describe("setup run journal", () => {
  it("round-trips a closed journal and rejects unknown or secret-shaped data", () => {
    const journal = createSetupRunJournal(plan, "run-journal");
    expect(parseSetupRunJournal(JSON.parse(JSON.stringify(journal)))).toEqual(journal);
    expect(() => parseSetupRunJournal({ ...journal, apiToken: "secret-sentinel" })).toThrow(
      "setup journal is invalid"
    );
    expect(() => parseSetupRunJournal({ ...journal, runId: "Bearer secret-sentinel" })).toThrow(
      "setup journal is invalid"
    );
  });

  it("rejects a journal whose operation set drifts from the canonical plan", async () => {
    const journal = createSetupRunJournal(plan, "run-drift");
    journal.entries[0] = { operationId: "create:unknown-resource", phase: "pending" };

    await expect(
      executeProductionSetup({
        plan,
        runId: "run-drift",
        adapter: adapterFrom({
          reconcile: () => {
            throw new Error("adapter must not run");
          }
        }),
        journalStore: createInMemorySetupRunJournalStore(journal)
      })
    ).rejects.toThrow("setup journal is invalid");
  });

  it("uses revision CAS and preserves the prior valid file after a stale write", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "setup-run.json");
    const store = createFileSetupRunJournalStore(path);
    const initial = createSetupRunJournal(plan, "run-file");
    await store.save(initial, null);
    const updated = { ...initial, revision: 2 };
    await store.save(updated, 1);
    const before = await readFile(path, "utf8");

    await expect(store.save({ ...updated, revision: 3 }, 1)).rejects.toThrow(
      "setup journal revision conflict"
    );
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await store.load()).toEqual(updated);
  });

  it("rejects oversized journal files without parsing or reflecting their content", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "setup-run.json");
    await writeFile(path, `{"secret":"secret-sentinel","padding":"${"x".repeat(70_000)}"}`);
    const store = createFileSetupRunJournalStore(path);

    await expect(store.load()).rejects.toThrow("setup journal is invalid");
  });

  it("rejects a concurrent file writer while preserving the current revision", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "setup-run.json");
    const store = createFileSetupRunJournalStore(path);
    const initial = createSetupRunJournal(plan, "run-locked");
    await store.save(initial, null);
    const before = await readFile(path, "utf8");
    await writeFile(`${path}.lock`, "active writer");

    await expect(store.save({ ...initial, revision: 2 }, 1)).rejects.toThrow(
      "setup journal revision conflict"
    );
    expect(await readFile(path, "utf8")).toBe(before);
  });
});

function adapterFrom(params: {
  reconcile: (
    operation: SetupOperation,
    idempotencyKey: string
  ) => SetupReconcileResult | Promise<SetupReconcileResult>;
  cleanup?: (
    operation: SetupOperation,
    resourceRef: string,
    idempotencyKey: string
  ) => void | Promise<void>;
}): SetupProviderAdapter {
  return {
    reconcile: ({ operation, idempotencyKey }) => params.reconcile(operation, idempotencyKey),
    cleanupCreated: ({ operation, resourceRef, idempotencyKey }) =>
      params.cleanup?.(operation, resourceRef, idempotencyKey)
  };
}

async function captureExecutionError(
  promise: Promise<SetupRunJournal>
): Promise<SetupRunExecutionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SetupRunExecutionError) return error;
    throw error;
  }
  throw new Error("expected setup execution to fail");
}

function failOneSaveAfterReconcile(base: SetupRunJournalStore): SetupRunJournalStore & {
  armFailure: () => void;
  disableFailure: () => void;
} {
  let armed = false;
  let enabled = true;
  return {
    load: () => base.load(),
    save: async (journal, expectedRevision) => {
      if (armed && enabled) {
        armed = false;
        throw new Error("synthetic journal write crash");
      }
      await base.save(journal, expectedRevision);
    },
    armFailure: () => {
      armed = true;
    },
    disableFailure: () => {
      enabled = false;
    }
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tenantscript-setup-journal-"));
  temporaryDirectories.push(directory);
  return directory;
}
