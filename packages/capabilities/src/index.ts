export interface CapabilityGrant {
  channel?: string | readonly string[];
  fields?: readonly string[];
  recipientDomains?: string | readonly string[];
  roles?: string | readonly string[];
  resumeHooks?: string | readonly string[];
  templates?: string | readonly string[];
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

export interface CapabilityRateLimit {
  limit: number;
  windowMs: number;
}

export interface CapabilityRateLimitBucket {
  capability: string;
  windowStartedAt: Date;
  count: number;
}

export interface CapabilityRateLimitDecision {
  allowed: boolean;
  count: number;
  limit: number;
  resetAt: Date;
}

export interface CapabilityRateLimiter {
  checkCapabilityRateLimit: (request: {
    capability: string;
    at: Date;
  }) => Promise<CapabilityRateLimitDecision> | CapabilityRateLimitDecision;
}

export interface CapabilityRateLimiterStorage {
  get: (
    key: string
  ) => Promise<CapabilityRateLimitBucket | undefined> | CapabilityRateLimitBucket | undefined;
  put: (key: string, bucket: CapabilityRateLimitBucket) => Promise<void> | void;
}

export type CapabilityAuditRecord = {
  capability: string;
  at: Date;
} & (
  | {
      status: "success";
      reason: "provider_completed";
    }
  | {
      status: "denied";
      reason:
        | "grant_missing"
        | "provider_missing"
        | "input_invalid"
        | "scope_denied"
        | "provider_denied"
        | "result_scope_denied"
        | "rate_limited";
    }
  | {
      status: "error";
      reason: "provider_failed";
    }
);

export interface CapabilityAuditSink {
  writeCapabilityAudit: (record: CapabilityAuditRecord) => Promise<void> | void;
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

export interface InvoiceRecord extends Record<string, unknown> {
  tenantId: string;
  id: string;
}

export interface InvoiceStore {
  findInvoice: (query: {
    tenantId: string;
    invoiceId: string;
  }) => Promise<InvoiceRecord | null> | InvoiceRecord | null;
}

export interface EmailTemplate {
  subject: string;
  text: string;
}

export interface EmailDelivery {
  to: string;
  subject: string;
  text: string;
}

export class CapabilityDeniedError extends Error {
  override readonly name = "CapabilityDeniedError";
}

export class CapabilityJournalConflictError extends Error {
  override readonly name = "CapabilityJournalConflictError";
}

export class CapabilityProviderError extends Error {
  override readonly name = "CapabilityProviderError";
}

class CapabilityInputError extends CapabilityDeniedError {}

export function createCapabilityBroker(params: {
  grants: CapabilityGrants;
  providers: Record<string, CapabilityProvider>;
  executionId?: string;
  journal?: CapabilityCallJournal;
  rateLimiter?: CapabilityRateLimiter;
  auditSink?: CapabilityAuditSink;
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
      const calledAt = params.now?.() ?? new Date();
      const grant = params.grants[name];
      if (grant === undefined) {
        await writeCapabilityAudit(params.auditSink, {
          capability: name,
          status: "denied",
          reason: "grant_missing",
          at: calledAt
        });
        throw new CapabilityDeniedError(`capability ${name} is not granted`);
      }

      try {
        assertScope(name, grant, input);
      } catch (error) {
        await writeCapabilityAudit(params.auditSink, {
          capability: name,
          status: "denied",
          reason: error instanceof CapabilityInputError ? "input_invalid" : "scope_denied",
          at: calledAt
        });
        throw error;
      }

      const provider = params.providers[name];
      if (provider === undefined) {
        await writeCapabilityAudit(params.auditSink, {
          capability: name,
          status: "denied",
          reason: "provider_missing",
          at: calledAt
        });
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

      await enforceCapabilityRateLimit({
        capability: name,
        at: calledAt,
        rateLimiter: params.rateLimiter,
        auditSink: params.auditSink
      });

      let providerResult: unknown;
      try {
        providerResult = await provider(input);
      } catch (error) {
        if (error instanceof CapabilityDeniedError) {
          await writeCapabilityAudit(params.auditSink, {
            capability: name,
            status: "denied",
            reason: "provider_denied",
            at: calledAt
          });
          throw error;
        }

        // Provider failures may contain credentials or customer data, so only a stable
        // category crosses the plugin boundary and enters the metadata-only audit log.
        await writeCapabilityAudit(params.auditSink, {
          capability: name,
          status: "error",
          reason: "provider_failed",
          at: calledAt
        });
        throw new CapabilityProviderError(`capability ${name} provider failed`);
      }

      let result: unknown;
      try {
        result = applyResultScope(name, grant, providerResult);
      } catch (error) {
        await writeCapabilityAudit(params.auditSink, {
          capability: name,
          status: "denied",
          reason: "result_scope_denied",
          at: calledAt
        });
        throw error;
      }
      await params.journal?.writeCapabilityCall({
        executionId: params.executionId ?? "",
        callIndex: currentCallIndex,
        capability: name,
        inputHash,
        result,
        completedAt: calledAt
      });
      await writeCapabilityAudit(params.auditSink, {
        capability: name,
        status: "success",
        reason: "provider_completed",
        at: calledAt
      });

      return result;
    }
  };
}

export function createInMemoryCapabilityRateLimiter(params: {
  limits: Record<string, CapabilityRateLimit>;
}): CapabilityRateLimiter {
  const buckets = new Map<string, CapabilityRateLimitBucket>();
  return createDurableObjectCapabilityRateLimiter({
    limits: params.limits,
    storage: {
      get: (key) => buckets.get(key),
      put: (key, bucket) => {
        buckets.set(key, bucket);
      }
    }
  });
}

export function createDurableObjectCapabilityRateLimiter(params: {
  limits: Record<string, CapabilityRateLimit>;
  storage: CapabilityRateLimiterStorage;
}): CapabilityRateLimiter {
  return {
    checkCapabilityRateLimit: async (request) => {
      const limit = params.limits[request.capability];
      if (limit === undefined) {
        return {
          allowed: true,
          count: 0,
          limit: Number.POSITIVE_INFINITY,
          resetAt: request.at
        };
      }
      validateCapabilityRateLimit(request.capability, limit);

      const key = request.capability;
      const current = await params.storage.get(key);
      const windowExpired =
        current === undefined ||
        request.at.getTime() - current.windowStartedAt.getTime() >= limit.windowMs;
      const bucket = windowExpired
        ? { capability: request.capability, windowStartedAt: request.at, count: 0 }
        : current;
      const next = {
        ...bucket,
        count: bucket.count + 1
      };
      const resetAt = new Date(bucket.windowStartedAt.getTime() + limit.windowMs);
      if (next.count > limit.limit) {
        return {
          allowed: false,
          count: next.count,
          limit: limit.limit,
          resetAt
        };
      }

      await params.storage.put(key, next);
      return {
        allowed: true,
        count: next.count,
        limit: limit.limit,
        resetAt
      };
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

async function enforceCapabilityRateLimit(params: {
  capability: string;
  at: Date;
  rateLimiter: CapabilityRateLimiter | undefined;
  auditSink: CapabilityAuditSink | undefined;
}): Promise<void> {
  if (params.rateLimiter === undefined) {
    return;
  }

  const decision = await params.rateLimiter.checkCapabilityRateLimit({
    capability: params.capability,
    at: params.at
  });
  if (decision.allowed) {
    return;
  }

  await writeCapabilityAudit(params.auditSink, {
    capability: params.capability,
    status: "denied",
    reason: "rate_limited",
    at: params.at
  });
  throw new CapabilityDeniedError(`capability ${params.capability} exceeded rate limit`);
}

async function writeCapabilityAudit(
  auditSink: CapabilityAuditSink | undefined,
  record: CapabilityAuditRecord
): Promise<void> {
  await auditSink?.writeCapabilityAudit(record);
}

function validateCapabilityRateLimit(capability: string, limit: CapabilityRateLimit): void {
  if (
    !Number.isInteger(limit.limit) ||
    limit.limit < 1 ||
    !Number.isInteger(limit.windowMs) ||
    limit.windowMs < 1
  ) {
    throw new Error(`capability ${capability} has invalid rate limit`);
  }
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

export function createInvoiceReadProvider(params: {
  tenantId: string;
  store: InvoiceStore;
}): CapabilityProvider {
  return async (input) => {
    const request = parseInvoiceReadInput(input);
    if (request.tenantId !== undefined && request.tenantId !== params.tenantId) {
      throw new CapabilityDeniedError(
        `invoice.read tenant ${request.tenantId} is outside tenant scope`
      );
    }

    const invoice = await params.store.findInvoice({
      tenantId: params.tenantId,
      invoiceId: request.invoiceId
    });
    if (invoice === null) {
      throw new CapabilityDeniedError(`invoice.read invoice ${request.invoiceId} was not found`);
    }
    if (invoice.tenantId !== params.tenantId) {
      throw new CapabilityDeniedError(
        `invoice.read invoice ${request.invoiceId} is outside tenant scope`
      );
    }

    return invoice;
  };
}

export function createEmailSendProvider(params: {
  apiKey: string;
  templates: Record<string, EmailTemplate>;
  deliver: (message: EmailDelivery, apiKey: string) => Promise<void> | void;
}): CapabilityProvider {
  if (params.apiKey.trim().length === 0) {
    throw new Error("email provider API key must not be empty");
  }
  const templates = new Map<string, EmailTemplate>();
  for (const [name, template] of Object.entries(params.templates)) {
    validateEmailTemplate(name, template);
    // Snapshot trusted templates at provider creation so later mutation of a caller-owned
    // configuration object cannot change already-reviewed email content at send time.
    templates.set(name, { subject: template.subject, text: template.text });
  }

  return async (input) => {
    const request = parseEmailSendInput(input);
    const template = templates.get(request.template);
    if (template === undefined) {
      throw new CapabilityDeniedError(`email.send template ${request.template} is unavailable`);
    }

    const message = renderEmailTemplate(request, template);
    // The credential is injected only inside the trusted provider adapter so plugin input,
    // results, errors, and audit records never gain a reference to the raw secret.
    await params.deliver(message, params.apiKey);
    return { ok: true, provider: "email" };
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

  if (name === "email.send") {
    const request = parseEmailSendInput(input);
    const recipientDomain = emailRecipientDomain(request.to);
    const allowedDomains = normalizeEmailGrantValues(grant.recipientDomains, "recipient domain");
    if (!allowedDomains.includes(recipientDomain)) {
      throw new CapabilityDeniedError(
        `email.send recipient domain ${recipientDomain} is outside granted scope`
      );
    }

    const allowedTemplates = normalizeEmailGrantValues(grant.templates, "template");
    if (!allowedTemplates.includes(request.template)) {
      throw new CapabilityDeniedError(
        `email.send template ${request.template} is outside granted scope`
      );
    }
  }

  if (name === "invoice.read") {
    parseInvoiceReadInput(input);
  }
}

function applyResultScope(name: string, grant: CapabilityGrant, result: unknown): unknown {
  if (name !== "invoice.read") {
    return result;
  }

  if (!isRecord(result)) {
    throw new CapabilityDeniedError("invoice.read provider must return an object");
  }

  const allowedFields = grant.fields ?? [];
  if (allowedFields.length === 0) {
    return result;
  }

  const filtered: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(result, field)) {
      filtered[field] = result[field];
    }
  }
  return filtered;
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
    throw new CapabilityInputError("slack.send requires channel and text");
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
    throw new CapabilityInputError(
      "approvals.request requires role, subject, resumeHook, and expiresAt"
    );
  }

  const expiresAt = new Date(input.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new CapabilityInputError("approvals.request expiresAt must be an ISO timestamp");
  }

  return {
    role: input.role,
    subject: input.subject,
    resumeHook: input.resumeHook,
    expiresAt
  };
}

function parseInvoiceReadInput(input: unknown): { tenantId?: string; invoiceId: string } {
  if (!isRecord(input) || typeof input.invoiceId !== "string") {
    throw new CapabilityInputError("invoice.read requires invoiceId");
  }
  if (input.tenantId !== undefined && typeof input.tenantId !== "string") {
    throw new CapabilityInputError("invoice.read tenantId must be a string");
  }

  if (input.tenantId === undefined) {
    return { invoiceId: input.invoiceId };
  }
  return { tenantId: input.tenantId, invoiceId: input.invoiceId };
}

interface EmailSendInput {
  to: string;
  template: string;
  variables: ReadonlyMap<string, string>;
}

function parseEmailSendInput(input: unknown): EmailSendInput {
  if (!isRecord(input)) {
    throw new CapabilityInputError("email.send requires to, template, and variables");
  }
  const supportedFields = new Set(["to", "template", "variables"]);
  if (Object.keys(input).some((field) => !supportedFields.has(field))) {
    throw new CapabilityInputError("email.send contains unsupported input fields");
  }
  if (
    typeof input.to !== "string" ||
    typeof input.template !== "string" ||
    input.template.length === 0 ||
    !isRecord(input.variables)
  ) {
    throw new CapabilityInputError("email.send requires to, template, and variables");
  }

  emailRecipientDomain(input.to);
  // A Map avoids prototype-key behavior from untrusted JSON variable names while retaining
  // deterministic one-pass lookup during rendering.
  const variables = new Map<string, string>();
  for (const [name, value] of Object.entries(input.variables)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string") {
      throw new CapabilityInputError("email.send variables must be named string values");
    }
    variables.set(name, value);
  }
  return { to: input.to, template: input.template, variables };
}

function emailRecipientDomain(address: string): string {
  if (address.trim() !== address || /[\r\n]/.test(address) || address.length > 254) {
    throw new CapabilityInputError("email.send requires a valid recipient email address");
  }
  const separator = address.indexOf("@");
  if (separator < 1 || separator !== address.lastIndexOf("@")) {
    throw new CapabilityInputError("email.send requires a valid recipient email address");
  }
  const local = address.slice(0, separator);
  const domain = address.slice(separator + 1).toLowerCase();
  if (
    local.length > 64 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !isValidEmailDomain(domain)
  ) {
    throw new CapabilityInputError("email.send requires a valid recipient email address");
  }
  return domain;
}

function isValidEmailDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253) {
    return false;
  }
  return domain
    .split(".")
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9-]+$/.test(label) &&
        !label.startsWith("-") &&
        !label.endsWith("-")
    );
}

function normalizeEmailGrantValues(
  value: string | readonly string[] | undefined,
  kind: "recipient domain" | "template"
): string[] {
  const values = value === undefined ? [] : [value].flat();
  if (values.some((entry) => entry.length === 0)) {
    throw new CapabilityDeniedError(`email.send has an invalid ${kind} grant`);
  }
  if (kind === "template") {
    return values;
  }

  const normalized = values.map((entry) => entry.toLowerCase());
  if (normalized.some((entry) => !isValidEmailDomain(entry))) {
    throw new CapabilityDeniedError("email.send has an invalid recipient domain grant");
  }
  return normalized;
}

function validateEmailTemplate(name: string, template: EmailTemplate): void {
  if (name.length === 0 || template.subject.length === 0 || template.text.length === 0) {
    throw new Error(`email template ${name} must define subject and text`);
  }
  for (const source of [template.subject, template.text]) {
    const withoutPlaceholders = source.replace(/\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/g, "");
    if (withoutPlaceholders.includes("{{") || withoutPlaceholders.includes("}}")) {
      throw new Error(`email template ${name} contains an invalid placeholder`);
    }
  }
}

function renderEmailTemplate(request: EmailSendInput, template: EmailTemplate): EmailDelivery {
  const requiredVariables = new Set<string>();
  for (const source of [template.subject, template.text]) {
    for (const match of source.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)) {
      const name = match[1];
      if (name !== undefined) {
        requiredVariables.add(name);
      }
    }
  }
  for (const name of requiredVariables) {
    if (!request.variables.has(name)) {
      throw new CapabilityInputError(`email.send variable ${name} is required`);
    }
  }
  for (const name of request.variables.keys()) {
    if (!requiredVariables.has(name)) {
      throw new CapabilityInputError(`email.send variable ${name} is not used by the template`);
    }
  }

  const render = (source: string): string =>
    source.replace(
      /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g,
      (_placeholder, name: string) => request.variables.get(name) ?? ""
    );
  const subject = render(template.subject);
  if (/[\r\n]/.test(subject)) {
    throw new CapabilityInputError("email.send rendered subject must not contain line breaks");
  }

  return { to: request.to, subject, text: render(template.text) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
