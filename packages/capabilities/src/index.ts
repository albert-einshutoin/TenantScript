export interface CapabilityGrant {
  channel?: string | readonly string[];
  fields?: readonly string[];
  roles?: string | readonly string[];
  resumeHooks?: string | readonly string[];
}

export type CapabilityGrants = Record<string, CapabilityGrant>;
export type CapabilityProvider = (input: unknown) => unknown;

export interface CapabilityCallJournalEntry {
  executionId: string;
  callIndex: number;
  capability: string;
  inputHash: string;
  result: unknown;
  completedAt: Date;
}

export interface CapabilityCallJournal {
  readCapabilityCall: (query: {
    executionId: string;
    callIndex: number;
  }) => Promise<CapabilityCallJournalEntry | null> | CapabilityCallJournalEntry | null;
  writeCapabilityCall: (
    entry: CapabilityCallJournalEntry
  ) => Promise<CapabilityCallJournalEntry> | CapabilityCallJournalEntry;
}

export interface CapabilityCallJournalStorage {
  get: (
    key: string
  ) => Promise<CapabilityCallJournalEntry | undefined> | CapabilityCallJournalEntry | undefined;
  put: (key: string, entry: CapabilityCallJournalEntry) => Promise<void> | void;
}

export interface CapabilityBroker {
  call: (name: string, input: unknown) => Promise<unknown>;
}

export interface PluginCapabilityContext {
  capability: (name: string, input: unknown) => Promise<unknown>;
}

export type ApprovalState = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalRecord {
  id: string;
  role: string;
  subject: Record<string, unknown>;
  resumeHook: string;
  state: ApprovalState;
  expiresAt: Date;
  createdAt: Date;
  updatedAt?: Date;
}

export interface ApprovalStore {
  createApproval: (record: ApprovalRecord) => Promise<ApprovalRecord> | ApprovalRecord;
}

export interface ApprovalLifecyclePlan {
  approvalId: string;
  notifyAt: Date;
  reminderAt: Date;
  expiresAt: Date;
}

export interface ApprovalWorkflowEngine {
  startApprovalLifecycle: (plan: ApprovalLifecyclePlan) => Promise<void> | void;
}

export class CapabilityDeniedError extends Error {
  override readonly name = "CapabilityDeniedError";
}

export class CapabilityJournalConflictError extends Error {
  override readonly name = "CapabilityJournalConflictError";
}

export function createCapabilityBroker(params: {
  grants: CapabilityGrants;
  providers: Record<string, CapabilityProvider>;
  executionId?: string;
  journal?: CapabilityCallJournal;
  now?: () => Date;
}): CapabilityBroker {
  if (params.journal !== undefined && params.executionId === undefined) {
    throw new Error("capability journal requires an executionId");
  }

  let callIndex = 0;

  return {
    call: async (name, input) => {
      const currentCallIndex = callIndex;
      callIndex += 1;
      const grant = params.grants[name];
      if (grant === undefined) {
        throw new CapabilityDeniedError(`capability ${name} is not granted`);
      }

      assertScope(name, grant, input);

      const provider = params.providers[name];
      if (provider === undefined) {
        throw new CapabilityDeniedError(`capability ${name} has no provider`);
      }

      const inputHash = stableJson(input);
      const journaled = await readJournaledCapabilityCall({
        journal: params.journal,
        executionId: params.executionId,
        callIndex: currentCallIndex,
        capability: name,
        inputHash
      });
      if (journaled !== null) {
        return journaled.result;
      }

      const result = await provider(input);
      await params.journal?.writeCapabilityCall({
        executionId: params.executionId ?? "",
        callIndex: currentCallIndex,
        capability: name,
        inputHash,
        result,
        completedAt: params.now?.() ?? new Date()
      });

      return result;
    }
  };
}

export function createInMemoryCapabilityCallJournal(): CapabilityCallJournal {
  const entries = new Map<string, CapabilityCallJournalEntry>();

  return createDurableObjectCapabilityCallJournal({
    get: (key) => entries.get(key),
    put: (key, entry) => {
      entries.set(key, entry);
    }
  });
}

export function createDurableObjectCapabilityCallJournal(
  storage: CapabilityCallJournalStorage
): CapabilityCallJournal {
  return {
    readCapabilityCall: async (query) => (await storage.get(journalKey(query))) ?? null,
    writeCapabilityCall: async (entry) => {
      await storage.put(journalKey(entry), entry);
      return entry;
    }
  };
}

export function createPluginCapabilityContext(broker: CapabilityBroker): PluginCapabilityContext {
  return {
    capability: (name, input) => broker.call(name, input)
  };
}

export function createApprovalsRequestProvider(params: {
  store: ApprovalStore;
  workflow?: ApprovalWorkflowEngine;
  generateId: () => string;
  now: () => Date;
}): CapabilityProvider {
  return async (input) => {
    const request = parseApprovalRequestInput(input);
    const approval = await params.store.createApproval({
      id: params.generateId(),
      role: request.role,
      subject: request.subject,
      resumeHook: request.resumeHook,
      state: "pending",
      expiresAt: request.expiresAt,
      createdAt: params.now()
    });
    await params.workflow?.startApprovalLifecycle(createApprovalLifecyclePlan(approval));

    return { ok: true, approvalId: approval.id, state: approval.state };
  };
}

export function createApprovalLifecyclePlan(approval: ApprovalRecord): ApprovalLifecyclePlan {
  return {
    approvalId: approval.id,
    notifyAt: approval.createdAt,
    reminderAt: new Date(
      approval.createdAt.getTime() +
        Math.floor((approval.expiresAt.getTime() - approval.createdAt.getTime()) / 2)
    ),
    expiresAt: approval.expiresAt
  };
}

export function expireApproval(approval: ApprovalRecord, now: Date): ApprovalRecord {
  if (approval.state !== "pending" || now.getTime() < approval.expiresAt.getTime()) {
    return approval;
  }

  return {
    ...approval,
    state: "expired",
    updatedAt: now
  };
}

export function createMockSlackSendProvider(params: {
  token: string;
  deliver: (message: { channel: string; text: string }) => void;
}): CapabilityProvider {
  const tokenLength = params.token.length;
  if (tokenLength === 0) {
    throw new Error("mock Slack token must not be empty");
  }

  return (input) => {
    const message = parseSlackSendInput(input);
    params.deliver(message);
    return { ok: true, provider: "mock-slack" };
  };
}

async function readJournaledCapabilityCall(params: {
  journal: CapabilityCallJournal | undefined;
  executionId: string | undefined;
  callIndex: number;
  capability: string;
  inputHash: string;
}): Promise<CapabilityCallJournalEntry | null> {
  if (params.journal === undefined || params.executionId === undefined) {
    return null;
  }

  const entry = await params.journal.readCapabilityCall({
    executionId: params.executionId,
    callIndex: params.callIndex
  });
  if (entry === null) {
    return null;
  }

  if (entry.capability !== params.capability || entry.inputHash !== params.inputHash) {
    throw new CapabilityJournalConflictError(
      `capability journal conflict for ${params.executionId}:${String(params.callIndex)}`
    );
  }

  return entry;
}

function assertScope(name: string, grant: CapabilityGrant, input: unknown): void {
  if (name === "slack.send") {
    const message = parseSlackSendInput(input);
    const allowedChannels = grant.channel === undefined ? [] : [grant.channel].flat();
    if (allowedChannels.length > 0 && !allowedChannels.includes(message.channel)) {
      throw new CapabilityDeniedError(
        `slack.send channel ${message.channel} is outside granted scope`
      );
    }
  }

  if (name === "approvals.request") {
    const request = parseApprovalRequestInput(input);
    const allowedRoles = grant.roles === undefined ? [] : [grant.roles].flat();
    if (allowedRoles.length > 0 && !allowedRoles.includes(request.role)) {
      throw new CapabilityDeniedError(
        `approvals.request role ${request.role} is outside granted scope`
      );
    }
    const allowedResumeHooks = grant.resumeHooks === undefined ? [] : [grant.resumeHooks].flat();
    if (allowedResumeHooks.length > 0 && !allowedResumeHooks.includes(request.resumeHook)) {
      throw new CapabilityDeniedError(
        `approvals.request resumeHook ${request.resumeHook} is outside granted scope`
      );
    }
  }
}

function journalKey(params: { executionId: string; callIndex: number }): string {
  return `${params.executionId}:${String(params.callIndex)}`;
}

function stableJson(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "bigint") {
    return `bigint:${value.toString()}`;
  }
  if (typeof value === "symbol") {
    return `symbol:${value.description ?? ""}`;
  }
  if (typeof value === "function") {
    return `function:${value.name}`;
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function parseSlackSendInput(input: unknown): { channel: string; text: string } {
  if (!isRecord(input) || typeof input.channel !== "string" || typeof input.text !== "string") {
    throw new CapabilityDeniedError("slack.send requires channel and text");
  }

  return {
    channel: input.channel,
    text: input.text
  };
}

function parseApprovalRequestInput(input: unknown): {
  role: string;
  subject: Record<string, unknown>;
  resumeHook: string;
  expiresAt: Date;
} {
  if (
    !isRecord(input) ||
    typeof input.role !== "string" ||
    !isRecord(input.subject) ||
    typeof input.resumeHook !== "string" ||
    typeof input.expiresAt !== "string"
  ) {
    throw new CapabilityDeniedError(
      "approvals.request requires role, subject, resumeHook, and expiresAt"
    );
  }

  const expiresAt = new Date(input.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new CapabilityDeniedError("approvals.request expiresAt must be an ISO timestamp");
  }

  return {
    role: input.role,
    subject: input.subject,
    resumeHook: input.resumeHook,
    expiresAt
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
