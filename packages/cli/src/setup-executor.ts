import { createHash } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  isSetupRuntimePrimitive,
  type ProductionSetupPlanV1,
  type SetupOperation,
  type SetupRuntimePrimitive
} from "./setup-plan.js";

const MAX_SETUP_JOURNAL_BYTES = 65_536;

export type SetupOperationDisposition = "created" | "adopted" | "applied";
export type SetupOperationPhase =
  | "pending"
  | "in-progress"
  | "completed"
  | "failed"
  | "cleaning"
  | "cleaned"
  | "cleanup-failed";

export interface SetupRunJournalEntry {
  operationId: string;
  phase: SetupOperationPhase;
  disposition?: SetupOperationDisposition;
  resourceRef?: string;
  failureCode?: "setup_operation_failed" | "setup_cleanup_failed";
}

export interface SetupRunJournal {
  version: 1;
  revision: number;
  runId: string;
  planFingerprint: string;
  runtime: SetupRuntimePrimitive;
  approvedAdoptionOperationIds: string[];
  state: "running" | "completed" | "failed" | "cleanup-incomplete";
  entries: SetupRunJournalEntry[];
}

export interface SetupRunJournalStore {
  load: () => Promise<SetupRunJournal | null>;
  save: (journal: SetupRunJournal, expectedRevision: number | null) => Promise<void>;
}

export type SetupReconcileResult =
  | { disposition: "created" | "adopted"; resourceRef: string }
  | { disposition: "applied" };

export interface SetupProviderAdapter {
  reconcile: (request: {
    runId: string;
    idempotencyKey: string;
    operation: SetupOperation;
  }) => Promise<SetupReconcileResult> | SetupReconcileResult;
  cleanupCreated: (request: {
    runId: string;
    idempotencyKey: string;
    operation: SetupOperation;
    resourceRef: string;
  }) => Promise<void> | void;
}

export class SetupRunExecutionError extends Error {
  override readonly name = "SetupRunExecutionError";

  constructor(
    readonly code: "setup_run_failed" | "setup_cleanup_incomplete",
    readonly operationIds: readonly string[]
  ) {
    super(code);
  }

  toJSON(): { code: SetupRunExecutionError["code"]; operationIds: readonly string[] } {
    return { code: this.code, operationIds: this.operationIds };
  }
}

export function createSetupRunJournal(
  plan: ProductionSetupPlanV1,
  runId: string,
  approvedAdoptionOperationIds: readonly string[] = []
): SetupRunJournal {
  validateRunId(runId);
  const approvedAdoptions = normalizeApprovedAdoptions(plan, approvedAdoptionOperationIds);
  return {
    version: 1,
    revision: 1,
    runId,
    planFingerprint: fingerprintPlan(plan),
    runtime: plan.runtime,
    approvedAdoptionOperationIds: approvedAdoptions,
    state: "running",
    entries: plan.operations.map((operation) => ({
      operationId: operation.id,
      phase: "pending"
    }))
  };
}

export async function executeProductionSetup(params: {
  plan: ProductionSetupPlanV1;
  runId: string;
  adapter: SetupProviderAdapter;
  journalStore: SetupRunJournalStore;
  approvedAdoptionOperationIds?: readonly string[];
}): Promise<SetupRunJournal> {
  validateRunId(params.runId);
  let journal = await params.journalStore.load();
  if (journal === null) {
    journal = createSetupRunJournal(params.plan, params.runId, params.approvedAdoptionOperationIds);
    await params.journalStore.save(journal, null);
  }
  validateJournalForPlan(
    journal,
    params.plan,
    params.runId,
    params.approvedAdoptionOperationIds ?? []
  );
  if (journal.state === "completed") return journal;
  if (
    journal.state === "failed" ||
    journal.state === "cleanup-incomplete" ||
    journal.entries.some((entry) =>
      ["failed", "cleaning", "cleaned", "cleanup-failed"].includes(entry.phase)
    )
  ) {
    return resumeCleanupAndThrow(params, journal);
  }

  for (const operation of params.plan.operations) {
    let entry = requireEntry(journal, operation.id);
    if (entry.phase === "completed") continue;
    if (entry.phase !== "pending" && entry.phase !== "in-progress") {
      throw invalidJournal();
    }
    if (entry.phase === "pending") {
      journal = await updateJournal(params.journalStore, journal, (draft) => {
        requireEntry(draft, operation.id).phase = "in-progress";
      });
      entry = requireEntry(journal, operation.id);
    }

    let result: SetupReconcileResult;
    try {
      result = await params.adapter.reconcile({
        runId: journal.runId,
        idempotencyKey: deriveSetupOperationIdempotencyKey(
          journal.runId,
          operation.id,
          "reconcile"
        ),
        operation
      });
      validateReconcileResult(operation, result, journal.approvedAdoptionOperationIds);
    } catch {
      journal = await updateJournal(params.journalStore, journal, (draft) => {
        const failed = requireEntry(draft, operation.id);
        failed.phase = "failed";
        failed.failureCode = "setup_operation_failed";
      });
      return cleanupAndThrow(params, journal);
    }

    // The adapter receives a stable idempotency key before this checkpoint. If the process loses
    // this write, resume reconciles the same operation instead of guessing whether it was created.
    journal = await updateJournal(params.journalStore, journal, (draft) => {
      const completed = requireEntry(draft, operation.id);
      completed.phase = "completed";
      completed.disposition = result.disposition;
      if (result.disposition !== "applied") completed.resourceRef = result.resourceRef;
    });
  }

  return updateJournal(params.journalStore, journal, (draft) => {
    draft.state = "completed";
  });
}

export function createInMemorySetupRunJournalStore(
  initial: SetupRunJournal | null = null
): SetupRunJournalStore {
  let current = initial === null ? null : cloneJournal(parseSetupRunJournal(initial));
  return {
    load: () => Promise.resolve(current === null ? null : cloneJournal(current)),
    save: (journal, expectedRevision) => {
      validateRevisionChange(current, journal, expectedRevision);
      current = cloneJournal(parseSetupRunJournal(journal));
      return Promise.resolve();
    }
  };
}

export function createFileSetupRunJournalStore(path: string): SetupRunJournalStore {
  return {
    load: () => loadJournalFile(path),
    save: (journal, expectedRevision) => saveJournalFile(path, journal, expectedRevision)
  };
}

export function parseSetupRunJournal(value: unknown): SetupRunJournal {
  if (
    !isExactRecord(value, [
      "version",
      "revision",
      "runId",
      "planFingerprint",
      "runtime",
      "approvedAdoptionOperationIds",
      "state",
      "entries"
    ]) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !isSafeIdentifier(value.runId, 128) ||
    typeof value.planFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.planFingerprint) ||
    !isSetupRuntimePrimitive(value.runtime) ||
    !Array.isArray(value.approvedAdoptionOperationIds) ||
    !value.approvedAdoptionOperationIds.every((item) => isSafeIdentifier(item, 256)) ||
    new Set(value.approvedAdoptionOperationIds).size !==
      value.approvedAdoptionOperationIds.length ||
    !["running", "completed", "failed", "cleanup-incomplete"].includes(value.state as string) ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0
  ) {
    throw invalidJournal();
  }
  const entries = value.entries.map(parseEntry);
  if (new Set(entries.map((entry) => entry.operationId)).size !== entries.length) {
    throw invalidJournal();
  }
  if (value.state === "completed" && entries.some((entry) => entry.phase !== "completed")) {
    throw invalidJournal();
  }
  if (
    value.state === "cleanup-incomplete" &&
    !entries.some((entry) => entry.phase === "cleanup-failed")
  ) {
    throw invalidJournal();
  }
  return {
    version: 1,
    revision: value.revision as number,
    runId: value.runId,
    planFingerprint: value.planFingerprint,
    runtime: value.runtime,
    approvedAdoptionOperationIds: [...value.approvedAdoptionOperationIds] as string[],
    state: value.state as SetupRunJournal["state"],
    entries
  };
}

async function cleanupAndThrow(
  params: Parameters<typeof executeProductionSetup>[0],
  journal: SetupRunJournal
): Promise<never> {
  const failedCleanupIds: string[] = [];
  for (const cleanupStep of params.plan.cleanup) {
    const operation = params.plan.operations.find(
      (candidate) => candidate.id === cleanupStep.targetOperationId
    );
    if (operation === undefined) throw invalidJournal();
    let entry = requireEntry(journal, operation.id);
    if (
      entry.disposition !== "created" ||
      !["completed", "cleaning", "cleanup-failed"].includes(entry.phase)
    ) {
      continue;
    }
    const resourceRef = entry.resourceRef;
    if (resourceRef === undefined) throw invalidJournal();
    if (entry.phase !== "cleaning") {
      journal = await updateJournal(params.journalStore, journal, (draft) => {
        requireEntry(draft, operation.id).phase = "cleaning";
      });
      entry = requireEntry(journal, operation.id);
    }
    let cleanupFailed = false;
    try {
      await params.adapter.cleanupCreated({
        runId: journal.runId,
        idempotencyKey: deriveSetupOperationIdempotencyKey(journal.runId, operation.id, "cleanup"),
        operation,
        resourceRef
      });
    } catch {
      cleanupFailed = true;
      failedCleanupIds.push(operation.id);
    }
    if (cleanupFailed) {
      journal = await updateJournal(params.journalStore, journal, (draft) => {
        const failed = requireEntry(draft, operation.id);
        failed.phase = "cleanup-failed";
        failed.failureCode = "setup_cleanup_failed";
      });
    } else {
      // Keep the checkpoint outside the provider catch. A storage crash after successful cleanup
      // must resume with the same cleanup key, not be misclassified as a provider cleanup failure.
      journal = await updateJournal(params.journalStore, journal, (draft) => {
        const cleaned = requireEntry(draft, operation.id);
        cleaned.phase = "cleaned";
        delete cleaned.failureCode;
      });
    }
  }
  journal = await updateJournal(params.journalStore, journal, (draft) => {
    draft.state = failedCleanupIds.length === 0 ? "failed" : "cleanup-incomplete";
  });
  throw new SetupRunExecutionError(
    journal.state === "cleanup-incomplete" ? "setup_cleanup_incomplete" : "setup_run_failed",
    failedCleanupIds
  );
}

async function resumeCleanupAndThrow(
  params: Parameters<typeof executeProductionSetup>[0],
  journal: SetupRunJournal
): Promise<never> {
  return cleanupAndThrow(params, journal);
}

async function updateJournal(
  store: SetupRunJournalStore,
  current: SetupRunJournal,
  update: (draft: SetupRunJournal) => void
): Promise<SetupRunJournal> {
  const next = cloneJournal(current);
  update(next);
  next.revision += 1;
  const parsed = parseSetupRunJournal(next);
  await store.save(parsed, current.revision);
  return parsed;
}

async function loadJournalFile(path: string): Promise<SetupRunJournal | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw new Error("setup journal could not be read");
  }
  try {
    const buffer = Buffer.alloc(MAX_SETUP_JOURNAL_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_SETUP_JOURNAL_BYTES) throw invalidJournal();
    try {
      return parseSetupRunJournal(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
    } catch {
      throw invalidJournal();
    }
  } finally {
    await handle.close();
  }
}

async function saveJournalFile(
  path: string,
  journal: SetupRunJournal,
  expectedRevision: number | null
): Promise<void> {
  const parsed = parseSetupRunJournal(journal);
  const lockPath = `${path}.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new Error("setup journal revision conflict");
  }
  const temporaryPath = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  let temporaryCreated = false;
  try {
    const current = await loadJournalFile(path);
    validateRevisionChange(current, parsed, expectedRevision);
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
    await lock.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

function validateJournalForPlan(
  journal: SetupRunJournal,
  plan: ProductionSetupPlanV1,
  runId: string,
  approvedAdoptionOperationIds: readonly string[]
): void {
  const approvedAdoptions = normalizeApprovedAdoptions(plan, approvedAdoptionOperationIds);
  if (
    journal.runId !== runId ||
    journal.runtime !== plan.runtime ||
    journal.planFingerprint !== fingerprintPlan(plan) ||
    journal.approvedAdoptionOperationIds.length !== approvedAdoptions.length ||
    !journal.approvedAdoptionOperationIds.every(
      (operationId, index) => operationId === approvedAdoptions[index]
    ) ||
    journal.entries.length !== plan.operations.length ||
    !journal.entries.every((entry, index) => entry.operationId === plan.operations[index]?.id)
  ) {
    throw invalidJournal();
  }
}

function validateRevisionChange(
  current: SetupRunJournal | null,
  next: SetupRunJournal,
  expectedRevision: number | null
): void {
  const currentRevision = current?.revision ?? null;
  if (
    currentRevision !== expectedRevision ||
    next.revision !== (expectedRevision === null ? 1 : expectedRevision + 1)
  ) {
    throw new Error("setup journal revision conflict");
  }
}

function validateReconcileResult(
  operation: SetupOperation,
  result: SetupReconcileResult,
  approvedAdoptionOperationIds: readonly string[]
): void {
  if (operation.action === "create") {
    if (
      (result.disposition !== "created" && result.disposition !== "adopted") ||
      !isResourceRef(result.resourceRef)
    ) {
      throw new Error("invalid setup adapter result");
    }
    if (result.disposition === "adopted" && !approvedAdoptionOperationIds.includes(operation.id)) {
      throw new Error("setup adoption is not approved");
    }
    return;
  }
  if (result.disposition !== "applied") throw new Error("invalid setup adapter result");
}

function parseEntry(value: unknown): SetupRunJournalEntry {
  if (
    !isKnownRecord(value, ["operationId", "phase", "disposition", "resourceRef", "failureCode"]) ||
    !isSafeIdentifier(value.operationId, 256) ||
    ![
      "pending",
      "in-progress",
      "completed",
      "failed",
      "cleaning",
      "cleaned",
      "cleanup-failed"
    ].includes(value.phase as string)
  ) {
    throw invalidJournal();
  }
  const entry: SetupRunJournalEntry = {
    operationId: value.operationId,
    phase: value.phase as SetupOperationPhase
  };
  if (value.disposition !== undefined) {
    if (!["created", "adopted", "applied"].includes(value.disposition as string)) {
      throw invalidJournal();
    }
    entry.disposition = value.disposition as SetupOperationDisposition;
  }
  if (value.resourceRef !== undefined) {
    if (!isResourceRef(value.resourceRef)) throw invalidJournal();
    entry.resourceRef = value.resourceRef;
  }
  if (value.failureCode !== undefined) {
    if (
      value.failureCode !== "setup_operation_failed" &&
      value.failureCode !== "setup_cleanup_failed"
    ) {
      throw invalidJournal();
    }
    entry.failureCode = value.failureCode;
  }
  validateEntryState(entry);
  return entry;
}

function validateEntryState(entry: SetupRunJournalEntry): void {
  if (entry.phase === "pending" || entry.phase === "in-progress") {
    if (
      entry.disposition !== undefined ||
      entry.resourceRef !== undefined ||
      entry.failureCode !== undefined
    ) {
      throw invalidJournal();
    }
    return;
  }
  if (entry.phase === "failed") {
    if (
      entry.failureCode !== "setup_operation_failed" ||
      entry.disposition !== undefined ||
      entry.resourceRef !== undefined
    ) {
      throw invalidJournal();
    }
    return;
  }
  if (entry.disposition === undefined) throw invalidJournal();
  if (entry.failureCode !== undefined && entry.phase !== "cleanup-failed") {
    throw invalidJournal();
  }
  if (entry.disposition === "applied") {
    if (entry.resourceRef !== undefined || entry.phase !== "completed") throw invalidJournal();
  } else if (entry.resourceRef === undefined) {
    throw invalidJournal();
  }
  if (["cleaning", "cleaned", "cleanup-failed"].includes(entry.phase)) {
    if (entry.disposition !== "created") throw invalidJournal();
  }
  if ((entry.phase === "cleanup-failed") !== (entry.failureCode === "setup_cleanup_failed")) {
    throw invalidJournal();
  }
}

function requireEntry(journal: SetupRunJournal, operationId: string): SetupRunJournalEntry {
  const entry = journal.entries.find((candidate) => candidate.operationId === operationId);
  if (entry === undefined) throw invalidJournal();
  return entry;
}

function fingerprintPlan(plan: ProductionSetupPlanV1): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: plan.version,
        profile: plan.profile,
        runtime: plan.runtime,
        operations: plan.operations
      })
    )
    .digest("hex");
}

export function deriveSetupOperationIdempotencyKey(
  runId: string,
  operationId: string,
  action: "reconcile" | "cleanup"
): string {
  const digest = createHash("sha256")
    .update(runId)
    .update("\0")
    .update(operationId)
    .update("\0")
    .update(action)
    .digest("hex");
  return `tssetup-${digest}`;
}

function validateRunId(runId: string): void {
  if (!isSafeIdentifier(runId, 128)) throw new TypeError("setup run id is invalid");
}

function isResourceRef(value: unknown): value is string {
  return isSafeIdentifier(value, 256);
}

function isSafeIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(value) &&
    !/(?:secret-sentinel|bearer|eyJ[A-Za-z0-9_-]*\.|(?:^|:)sk[-_])/iu.test(value)
  );
}

function cloneJournal(journal: SetupRunJournal): SetupRunJournal {
  return {
    ...journal,
    approvedAdoptionOperationIds: [...journal.approvedAdoptionOperationIds],
    entries: journal.entries.map((entry) => ({ ...entry }))
  };
}

function normalizeApprovedAdoptions(
  plan: ProductionSetupPlanV1,
  operationIds: readonly string[]
): string[] {
  if (new Set(operationIds).size !== operationIds.length) throw invalidJournal();
  const approved = new Set(operationIds);
  for (const operationId of approved) {
    const operation = plan.operations.find((candidate) => candidate.id === operationId);
    if (operation?.action !== "create") throw invalidJournal();
  }
  return plan.operations
    .filter((operation) => operation.action === "create" && approved.has(operation.id))
    .map((operation) => operation.id);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isKnownRecord(value, keys)) return false;
  return Object.keys(value).length === keys.length;
}

function isKnownRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function invalidJournal(): Error {
  return new Error("setup journal is invalid");
}
