export interface CapabilityGrant {
  channel?: string | readonly string[];
  fields?: readonly string[];
  methods?: string | readonly string[];
  origins?: string | readonly string[];
  recipientDomains?: string | readonly string[];
  requestHeaders?: string | readonly string[];
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

export interface HttpFetchTransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpFetchTransportResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpFetchCredential {
  name: string;
  value: string;
}

export type WebFetchFunction = (input: string, init: RequestInit) => Promise<Response>;

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

export function createHttpFetchProvider(params: {
  allowedOrigins: readonly string[];
  allowedMethods: readonly string[];
  credentials?: Readonly<Record<string, HttpFetchCredential>>;
  transport: (
    request: HttpFetchTransportRequest
  ) => Promise<HttpFetchTransportResponse> | HttpFetchTransportResponse;
  maxRedirects?: number;
}): CapabilityProvider {
  const allowedOrigins = normalizeHttpOrigins(params.allowedOrigins, "provider");
  const allowedMethods = normalizeHttpProviderMethods(params.allowedMethods);
  const credentials = new Map<string, HttpFetchCredential>();
  for (const [configuredOrigin, credential] of Object.entries(params.credentials ?? {})) {
    const [origin] = normalizeHttpOrigins([configuredOrigin], "credential");
    if (origin === undefined || !allowedOrigins.includes(origin)) {
      throw new Error(`http.fetch credential origin ${configuredOrigin} is not allowed`);
    }
    const name = normalizeHttpHeaderName(credential.name);
    if (
      isUnsafeCredentialHeader(name) ||
      credential.value.length === 0 ||
      /[\r\n]/.test(credential.value)
    ) {
      throw new Error(`http.fetch credential for ${origin} is invalid`);
    }
    if (new URL(origin).protocol !== "https:") {
      throw new Error(`http.fetch credential origin ${origin} must use HTTPS`);
    }
    if (credentials.has(origin)) {
      throw new Error(`http.fetch credential origin ${origin} is duplicated`);
    }
    // Credentials are snapshotted by exact origin so redirects never carry one
    // provider's authority to a different destination.
    credentials.set(origin, { name, value: credential.value });
  }

  const maxRedirects = params.maxRedirects ?? 5;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw new Error("http.fetch maxRedirects must be between 0 and 10");
  }

  return async (input) => {
    const request = parseHttpFetchInput(input);
    assertHttpProviderMethod(request.method, allowedMethods);
    let destination = parseHttpFetchUrl(request.url);
    assertHttpFetchDestination(destination, allowedOrigins);
    let method = request.method;
    let body = request.body;
    let headers = new Map(request.headers);

    for (let redirectCount = 0; ; redirectCount += 1) {
      const credential = credentials.get(destination.origin);
      if (credential !== undefined && headers.has(credential.name)) {
        throw new CapabilityDeniedError(
          `http.fetch header ${credential.name} cannot be supplied by the plugin`
        );
      }
      const transportHeaders = Object.fromEntries(headers);
      if (credential !== undefined) {
        transportHeaders[credential.name] = credential.value;
      }

      const transportRequest: HttpFetchTransportRequest = {
        url: destination.href,
        method,
        headers: transportHeaders
      };
      if (body !== undefined) {
        transportRequest.body = body;
      }
      const response = await params.transport(transportRequest);
      validateHttpFetchResponse(response);

      const location = redirectLocation(response);
      if (!isRedirectStatus(response.status) || location === undefined) {
        return sanitizeHttpFetchResponse(response);
      }
      if (redirectCount >= maxRedirects) {
        throw new CapabilityDeniedError("http.fetch exceeded redirect limit");
      }

      destination = resolveHttpRedirect(location, destination);
      assertHttpFetchDestination(destination, allowedOrigins);
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === "POST")
      ) {
        method = "GET";
        assertHttpProviderMethod(method, allowedMethods);
        body = undefined;
        headers = new Map(headers);
        headers.delete("content-type");
      }
    }
  };
}

function normalizeHttpProviderMethods(methods: readonly string[]): string[] {
  const normalized = methods.map((method) => method.toUpperCase());
  if (normalized.length === 0 || normalized.some((method) => !supportedHttpMethods.has(method))) {
    throw new Error("http.fetch provider methods are invalid");
  }
  return [...new Set(normalized)];
}

function assertHttpProviderMethod(method: string, allowedMethods: readonly string[]): void {
  if (!allowedMethods.includes(method)) {
    throw new CapabilityDeniedError(`http.fetch method ${method} is outside provider scope`);
  }
}

export function createWebFetchHttpTransport(
  fetcher: WebFetchFunction
): (request: HttpFetchTransportRequest) => Promise<HttpFetchTransportResponse> {
  return async (request) => {
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      redirect: "manual",
      credentials: "omit"
    };
    if (request.body !== undefined) {
      init.body = request.body;
    }
    const response = await fetcher(request.url, init);
    const result: HttpFetchTransportResponse = {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries())
    };
    // Redirect bodies are never exposed and need not be buffered because the provider
    // validates the next hop before issuing another request.
    if (!isRedirectStatus(response.status)) {
      result.body = await response.text();
    }
    return result;
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

  if (name === "http.fetch") {
    const request = parseHttpFetchInput(input);
    const destination = parseHttpFetchUrl(request.url);
    const allowedOrigins = normalizeHttpOrigins(grant.origins, "grant");
    assertHttpFetchDestination(destination, allowedOrigins);

    const allowedMethods = normalizeHttpGrantValues(grant.methods, "method", (value) =>
      value.toUpperCase()
    );
    if (!allowedMethods.includes(request.method)) {
      throw new CapabilityDeniedError(
        `http.fetch method ${request.method} is outside granted scope`
      );
    }

    const allowedHeaders = normalizeHttpGrantValues(
      grant.requestHeaders,
      "request header",
      normalizeHttpHeaderName
    );
    for (const header of request.headers.keys()) {
      if (!allowedHeaders.includes(header)) {
        throw new CapabilityDeniedError(`http.fetch header ${header} is outside granted scope`);
      }
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

interface HttpFetchInput {
  url: string;
  method: string;
  headers: ReadonlyMap<string, string>;
  body?: string;
}

const pluginForbiddenHttpHeaders = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const supportedHttpMethods = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);

function parseHttpFetchInput(input: unknown): HttpFetchInput {
  if (!isRecord(input)) {
    throw new CapabilityInputError("http.fetch requires url and method");
  }
  const supportedFields = new Set(["url", "method", "headers", "body"]);
  if (Object.keys(input).some((field) => !supportedFields.has(field))) {
    throw new CapabilityInputError("http.fetch contains unsupported input fields");
  }
  if (
    typeof input.url !== "string" ||
    typeof input.method !== "string" ||
    (input.headers !== undefined && !isRecord(input.headers)) ||
    (input.body !== undefined && typeof input.body !== "string")
  ) {
    throw new CapabilityInputError("http.fetch requires url and method");
  }

  const method = input.method.toUpperCase();
  if (!supportedHttpMethods.has(method)) {
    throw new CapabilityInputError("http.fetch method is invalid");
  }
  if ((method === "GET" || method === "HEAD") && input.body !== undefined) {
    throw new CapabilityInputError(`http.fetch ${method} requests must not include a body`);
  }

  const headers = new Map<string, string>();
  for (const [rawName, value] of Object.entries(input.headers ?? {})) {
    if (typeof value !== "string" || /[\r\n]/.test(value)) {
      throw new CapabilityInputError("http.fetch headers must contain string values");
    }
    const name = normalizeHttpHeaderName(rawName);
    if (isRoutingHttpHeader(name)) {
      throw new CapabilityInputError(`http.fetch header ${name} cannot be supplied by the plugin`);
    }
    if (headers.has(name)) {
      throw new CapabilityInputError(`http.fetch header ${name} is duplicated`);
    }
    headers.set(name, value);
  }

  const parsed: HttpFetchInput = { url: input.url, method, headers };
  if (input.body !== undefined) {
    parsed.body = input.body;
  }
  return parsed;
}

function normalizeHttpHeaderName(name: string): string {
  const normalized = name.toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(normalized)) {
    throw new CapabilityInputError(`http.fetch header ${name} is invalid`);
  }
  return normalized;
}

function isRoutingHttpHeader(name: string): boolean {
  return (
    pluginForbiddenHttpHeaders.has(name) ||
    name.startsWith("proxy-") ||
    name.startsWith("sec-") ||
    name.startsWith("cf-") ||
    name.startsWith("x-forwarded-")
  );
}

function isUnsafeCredentialHeader(name: string): boolean {
  return (
    name === "connection" ||
    name === "content-length" ||
    name === "host" ||
    name === "te" ||
    name === "trailer" ||
    name === "transfer-encoding" ||
    name === "upgrade" ||
    name.startsWith("proxy-") ||
    name.startsWith("sec-") ||
    name.startsWith("cf-") ||
    name.startsWith("x-forwarded-")
  );
}

function normalizeHttpGrantValues(
  value: string | readonly string[] | undefined,
  kind: "method" | "request header",
  normalize: (value: string) => string
): string[] {
  const values = value === undefined ? [] : [value].flat();
  if (values.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new CapabilityDeniedError(`http.fetch has an invalid ${kind} grant`);
  }
  try {
    const normalized = values.map(normalize);
    if (
      (kind === "method" && normalized.some((entry) => !supportedHttpMethods.has(entry))) ||
      (kind === "request header" && normalized.some(isRoutingHttpHeader))
    ) {
      throw new Error("invalid grant value");
    }
    return [...new Set(normalized)];
  } catch {
    throw new CapabilityDeniedError(`http.fetch has an invalid ${kind} grant`);
  }
}

function normalizeHttpOrigins(
  value: string | readonly string[] | undefined,
  source: "credential" | "grant" | "provider"
): string[] {
  const values = value === undefined ? [] : [value].flat();
  const origins: string[] = [];
  for (const entry of values) {
    if (typeof entry !== "string") {
      throw httpOriginConfigurationError(source, String(entry));
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw httpOriginConfigurationError(source, entry);
    }
    if (
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== "/" ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      !isPublicHttpDestination(url)
    ) {
      throw httpOriginConfigurationError(source, entry);
    }
    origins.push(url.origin);
  }
  return [...new Set(origins)];
}

function httpOriginConfigurationError(
  source: "credential" | "grant" | "provider",
  value: string
): Error {
  const message = `http.fetch ${source} origin ${value} is invalid`;
  return source === "grant" ? new CapabilityDeniedError(message) : new Error(message);
}

function parseHttpFetchUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CapabilityInputError("http.fetch requires a valid URL");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new CapabilityInputError("http.fetch URL must not contain credentials");
  }
  url.hash = "";
  return url;
}

function assertHttpFetchDestination(destination: URL, allowedOrigins: readonly string[]): void {
  if (!isPublicHttpDestination(destination)) {
    throw new CapabilityDeniedError(`http.fetch destination ${destination.origin} is not public`);
  }
  if (!allowedOrigins.includes(destination.origin)) {
    throw new CapabilityDeniedError(
      `http.fetch origin ${destination.origin} is outside granted scope`
    );
  }
}

function isPublicHttpDestination(url: URL): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return false;
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".home.arpa") ||
    hostname === "metadata.google.internal" ||
    hostname === "::" ||
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    /^fe[89ab]/.test(hostname) ||
    hostname.startsWith("::ffff:") ||
    hostname.startsWith("2001:db8:") ||
    hostname.startsWith("ff")
  ) {
    return false;
  }
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return true;
  }
  const octets = parts.map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return !(
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && octets[2] === 100) ||
    (first === 203 && second === 0 && octets[2] === 113) ||
    first >= 224
  );
}

function validateHttpFetchResponse(response: HttpFetchTransportResponse): void {
  if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599) {
    throw new Error("http.fetch transport returned an invalid status");
  }
}

function redirectLocation(response: HttpFetchTransportResponse): string | undefined {
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    if (name.toLowerCase() === "location") {
      return value;
    }
  }
  return undefined;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function resolveHttpRedirect(location: string, current: URL): URL {
  try {
    return parseHttpFetchUrl(new URL(location, current).href);
  } catch (error) {
    if (error instanceof CapabilityDeniedError) {
      throw error;
    }
    throw new CapabilityDeniedError("http.fetch redirect location is invalid");
  }
}

function sanitizeHttpFetchResponse(
  response: HttpFetchTransportResponse
): HttpFetchTransportResponse {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    const normalized = name.toLowerCase();
    if (
      normalized !== "set-cookie" &&
      normalized !== "set-cookie2" &&
      normalized !== "proxy-authenticate" &&
      normalized !== "www-authenticate"
    ) {
      headers[normalized] = value;
    }
  }
  const result: HttpFetchTransportResponse = { status: response.status, headers };
  if (response.body !== undefined) {
    result.body = response.body;
  }
  return result;
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
