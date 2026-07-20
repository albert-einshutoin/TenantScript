const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 10 * 60 * 1_000;
const REQUEST_BYTES = 16_384;
const RESPONSE_BYTES = 16_384;
const STATE_BYTES = 32;
const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8"
};
const textEncoder = new TextEncoder();

export type OAuthStateProvider = "slack";

export interface OAuthStateBinding {
  provider: OAuthStateProvider;
  appId: string;
  tenantId: string;
  actorSubject: string;
  redirectUri: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface OAuthStateStore {
  issue: (input: {
    provider: OAuthStateProvider;
    appId: string;
    tenantId: string;
    actorSubject: string;
    browserBinding: string;
    redirectUri: string;
  }) => Promise<{ state: string; expiresAt: Date }>;
  consume: (input: { state: string; browserBinding: string }) => Promise<OAuthStateBinding>;
}

export type OAuthStateStoreErrorCode =
  | "oauth_state_invalid_configuration"
  | "oauth_state_invalid_request"
  | "oauth_state_invalid"
  | "oauth_state_store_unavailable";

export class OAuthStateStoreError extends Error {
  override readonly name = "OAuthStateStoreError";

  constructor(readonly code: OAuthStateStoreErrorCode) {
    super(code);
  }

  toJSON(): { code: OAuthStateStoreErrorCode } {
    return { code: this.code };
  }
}

interface DurableObjectTransactionLike {
  get: <T>(key: string) => Promise<T | undefined>;
  put: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<boolean>;
  list: <T>() => Promise<Map<string, T>>;
  getAlarm: () => Promise<number | null>;
  setAlarm: (scheduledTime: number) => Promise<void>;
  deleteAlarm: () => Promise<void>;
}

interface DurableObjectStateLike {
  storage: DurableObjectTransactionLike & {
    transaction: <T>(
      closure: (transaction: DurableObjectTransactionLike) => Promise<T>
    ) => Promise<T>;
  };
  blockConcurrencyWhile: <T>(closure: () => Promise<T>) => Promise<T>;
}

interface DurableObjectNamespaceLike<TId> {
  idFromName: (name: string) => TId;
  get: (id: TId) => {
    fetch: (input: string, init: RequestInit) => Promise<Response>;
  };
}

interface OAuthStateRecord {
  browserBindingDigest: string;
  provider: OAuthStateProvider;
  appId: string;
  tenantId: string;
  actorSubject: string;
  redirectUri: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

interface OAuthStateRuntime {
  now?: () => Date;
}

export class OAuthStateStoreDurableObject {
  constructor(
    private readonly state: DurableObjectStateLike,
    _env: unknown,
    private readonly runtime: OAuthStateRuntime = {}
  ) {}

  async fetch(request: Request): Promise<Response> {
    const operation = matchOperation(request);
    if (operation === null) return new Response(null, { status: 404, headers: JSON_HEADERS });
    if (request.headers.get("Content-Type") !== "application/json") {
      return errorResponse("oauth_state_invalid_request", 400);
    }
    let input: unknown;
    try {
      input = await readBoundedJson(request, REQUEST_BYTES);
    } catch {
      return errorResponse("oauth_state_invalid_request", 400);
    }
    try {
      return operation === "issue" ? await this.issue(input) : await this.consume(input);
    } catch (error) {
      if (error instanceof OAuthStateStoreError && error.code === "oauth_state_invalid") {
        return errorResponse("oauth_state_invalid", 400);
      }
      return errorResponse("oauth_state_store_unavailable", 503);
    }
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(() =>
      this.state.storage.transaction(async (transaction) => {
        const nowMs = this.nowMs();
        const records = await transaction.list<unknown>();
        for (const [key, value] of records) {
          if (key.startsWith("state:") && isOAuthStateRecord(value) && value.expiresAtMs <= nowMs) {
            await transaction.delete(key);
          }
        }
        await scheduleNextAlarm(transaction);
      })
    );
  }

  private async issue(input: unknown): Promise<Response> {
    if (!isIssueProtocolInput(input)) return errorResponse("oauth_state_invalid_request", 400);
    const nowMs = this.nowMs();
    if (
      Math.abs(input.issuedAtMs - nowMs) > 5_000 ||
      input.expiresAtMs - input.issuedAtMs < MIN_TTL_MS ||
      input.expiresAtMs - input.issuedAtMs > MAX_TTL_MS
    ) {
      return errorResponse("oauth_state_invalid_request", 400);
    }
    const record: OAuthStateRecord = {
      browserBindingDigest: input.browserBindingDigest,
      provider: input.provider,
      appId: input.appId,
      tenantId: input.tenantId,
      actorSubject: input.actorSubject,
      redirectUri: input.redirectUri,
      issuedAtMs: input.issuedAtMs,
      expiresAtMs: input.expiresAtMs
    };
    const created = await this.state.blockConcurrencyWhile(() =>
      this.state.storage.transaction(async (transaction) => {
        const key = stateKey(input.stateDigest);
        if ((await transaction.get(key)) !== undefined) return false;
        await transaction.put(key, record);
        await scheduleEarlierAlarm(transaction, record.expiresAtMs);
        return true;
      })
    );
    if (!created) return errorResponse("oauth_state_store_unavailable", 503);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  private async consume(input: unknown): Promise<Response> {
    if (!isConsumeProtocolInput(input)) return errorResponse("oauth_state_invalid_request", 400);
    const record = await this.state.blockConcurrencyWhile(() =>
      this.state.storage.transaction(async (transaction) => {
        const key = stateKey(input.stateDigest);
        const current = await transaction.get<OAuthStateRecord>(key);
        if (!isOAuthStateRecord(current)) {
          return null;
        }
        if (current.expiresAtMs <= this.nowMs()) {
          await transaction.delete(key);
          return null;
        }
        // A mismatched browser must not be able to invalidate a legitimate in-flight flow. The
        // high-entropy state remains one-time consumable only by its original browser session.
        if (current.browserBindingDigest !== input.browserBindingDigest) return null;
        await transaction.delete(key);
        return current;
      })
    );
    if (record === null) throw invalidState();
    return Response.json(publicRecord(record), { headers: JSON_HEADERS });
  }

  private nowMs(): number {
    const value = (this.runtime.now?.() ?? new Date()).getTime();
    if (!Number.isSafeInteger(value)) throw unavailable();
    return value;
  }
}

async function scheduleEarlierAlarm(
  transaction: DurableObjectTransactionLike,
  expiresAtMs: number
): Promise<void> {
  const scheduled = await transaction.getAlarm();
  if (scheduled === null || expiresAtMs < scheduled) await transaction.setAlarm(expiresAtMs);
}

async function scheduleNextAlarm(transaction: DurableObjectTransactionLike): Promise<void> {
  const records = await transaction.list<unknown>();
  let earliest: number | undefined;
  for (const [key, value] of records) {
    if (!key.startsWith("state:") || !isOAuthStateRecord(value)) continue;
    earliest = earliest === undefined ? value.expiresAtMs : Math.min(earliest, value.expiresAtMs);
  }
  if (earliest === undefined) await transaction.deleteAlarm();
  else await transaction.setAlarm(earliest);
}

export function createDurableObjectNamespaceOAuthStateStore<TId>(
  namespace: DurableObjectNamespaceLike<TId>,
  options: { ttlMs?: number; now?: () => Date } = {}
): OAuthStateStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!isBoundedInteger(ttlMs, MIN_TTL_MS, MAX_TTL_MS)) {
    throw new OAuthStateStoreError("oauth_state_invalid_configuration");
  }
  const now = options.now ?? (() => new Date());

  return {
    issue: async (input) => {
      if (!isIssueInput(input)) throw new OAuthStateStoreError("oauth_state_invalid_request");
      const issuedAtMs = readNow(now);
      const state = encodeBase64Url(crypto.getRandomValues(new Uint8Array(STATE_BYTES)));
      // Persist and route only by a digest. The opaque bearer value and browser-session binding
      // never cross the internal Durable Object protocol or appear in storage.
      const stateDigest = await digest(state);
      const browserBindingDigest = await digest(input.browserBinding);
      const expiresAtMs = issuedAtMs + ttlMs;
      const response = await internalRequest(namespace, stateDigest, "issue", {
        stateDigest,
        browserBindingDigest,
        provider: input.provider,
        appId: input.appId,
        tenantId: input.tenantId,
        actorSubject: input.actorSubject,
        redirectUri: input.redirectUri,
        issuedAtMs,
        expiresAtMs
      });
      if (response.status !== 204) throw unavailable();
      return { state, expiresAt: new Date(expiresAtMs) };
    },
    consume: async (input) => {
      if (!isConsumeInput(input)) throw new OAuthStateStoreError("oauth_state_invalid_request");
      const stateDigest = await digest(input.state);
      const browserBindingDigest = await digest(input.browserBinding);
      const response = await internalRequest(namespace, stateDigest, "consume", {
        stateDigest,
        browserBindingDigest
      });
      if (response.status === 400) throw invalidState();
      if (response.status !== 200) throw unavailable();
      const value = await readBoundedJson(response, RESPONSE_BYTES);
      if (!isPublicRecord(value)) throw unavailable();
      return {
        provider: value.provider,
        appId: value.appId,
        tenantId: value.tenantId,
        actorSubject: value.actorSubject,
        redirectUri: value.redirectUri,
        issuedAt: new Date(value.issuedAtMs),
        expiresAt: new Date(value.expiresAtMs)
      };
    }
  };
}

async function internalRequest<TId>(
  namespace: DurableObjectNamespaceLike<TId>,
  stateDigest: string,
  operation: "issue" | "consume",
  body: unknown
): Promise<Response> {
  try {
    // The digest prefix spreads callback lookups across 256 objects without exposing or trusting a
    // tenant identifier before state validation has restored the server-owned binding.
    const stub = namespace.get(namespace.idFromName(`oauth-state-v1-${stateDigest.slice(0, 2)}`));
    return await stub.fetch(`https://oauth-state-store.internal/v1/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: encodeBoundedJson(body, REQUEST_BYTES)
    });
  } catch (error) {
    if (error instanceof OAuthStateStoreError) throw error;
    throw unavailable();
  }
}

function publicRecord(record: OAuthStateRecord): Record<string, unknown> {
  return {
    provider: record.provider,
    appId: record.appId,
    tenantId: record.tenantId,
    actorSubject: record.actorSubject,
    redirectUri: record.redirectUri,
    issuedAtMs: record.issuedAtMs,
    expiresAtMs: record.expiresAtMs
  };
}

function isPublicRecord(value: unknown): value is Omit<OAuthStateRecord, "browserBindingDigest"> {
  return (
    isExactRecord(value, [
      "provider",
      "appId",
      "tenantId",
      "actorSubject",
      "redirectUri",
      "issuedAtMs",
      "expiresAtMs"
    ]) &&
    value.provider === "slack" &&
    isIdentifier(value.appId) &&
    isIdentifier(value.tenantId) &&
    isIdentifier(value.actorSubject) &&
    isCanonicalHttpsRedirect(value.redirectUri) &&
    isTimestamp(value.issuedAtMs) &&
    isTimestamp(value.expiresAtMs) &&
    value.expiresAtMs > value.issuedAtMs
  );
}

function isOAuthStateRecord(value: unknown): value is OAuthStateRecord {
  return (
    isExactRecord(value, [
      "browserBindingDigest",
      "provider",
      "appId",
      "tenantId",
      "actorSubject",
      "redirectUri",
      "issuedAtMs",
      "expiresAtMs"
    ]) &&
    isDigest(value.browserBindingDigest) &&
    isPublicRecord(publicRecordFromUnknown(value))
  );
}

function publicRecordFromUnknown(value: Record<string, unknown>): unknown {
  return {
    provider: value.provider,
    appId: value.appId,
    tenantId: value.tenantId,
    actorSubject: value.actorSubject,
    redirectUri: value.redirectUri,
    issuedAtMs: value.issuedAtMs,
    expiresAtMs: value.expiresAtMs
  };
}

function isIssueInput(value: unknown): value is {
  provider: OAuthStateProvider;
  appId: string;
  tenantId: string;
  actorSubject: string;
  browserBinding: string;
  redirectUri: string;
} {
  return (
    isExactRecord(value, [
      "provider",
      "appId",
      "tenantId",
      "actorSubject",
      "browserBinding",
      "redirectUri"
    ]) &&
    value.provider === "slack" &&
    isIdentifier(value.appId) &&
    isIdentifier(value.tenantId) &&
    isIdentifier(value.actorSubject) &&
    isBrowserBinding(value.browserBinding) &&
    isCanonicalHttpsRedirect(value.redirectUri)
  );
}

function isConsumeInput(value: unknown): value is { state: string; browserBinding: string } {
  return (
    isExactRecord(value, ["state", "browserBinding"]) &&
    typeof value.state === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(value.state) &&
    isBrowserBinding(value.browserBinding)
  );
}

function isIssueProtocolInput(value: unknown): value is {
  stateDigest: string;
  browserBindingDigest: string;
  provider: OAuthStateProvider;
  appId: string;
  tenantId: string;
  actorSubject: string;
  redirectUri: string;
  issuedAtMs: number;
  expiresAtMs: number;
} {
  return (
    isExactRecord(value, [
      "stateDigest",
      "browserBindingDigest",
      "provider",
      "appId",
      "tenantId",
      "actorSubject",
      "redirectUri",
      "issuedAtMs",
      "expiresAtMs"
    ]) &&
    isDigest(value.stateDigest) &&
    isDigest(value.browserBindingDigest) &&
    value.provider === "slack" &&
    isIdentifier(value.appId) &&
    isIdentifier(value.tenantId) &&
    isIdentifier(value.actorSubject) &&
    isCanonicalHttpsRedirect(value.redirectUri) &&
    isTimestamp(value.issuedAtMs) &&
    isTimestamp(value.expiresAtMs)
  );
}

function isConsumeProtocolInput(
  value: unknown
): value is { stateDigest: string; browserBindingDigest: string } {
  return (
    isExactRecord(value, ["stateDigest", "browserBindingDigest"]) &&
    isDigest(value.stateDigest) &&
    isDigest(value.browserBindingDigest)
  );
}

function matchOperation(request: Request): "issue" | "consume" | null {
  if (request.method !== "POST") return null;
  const match = new URL(request.url).pathname.match(/^\/v1\/(issue|consume)$/u);
  return (match?.[1] as "issue" | "consume" | undefined) ?? null;
}

function isBrowserBinding(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,512}$/u.test(value);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/u.test(value)
  );
}

function isCanonicalHttpsRedirect(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      url.toString() === value
    );
  } catch {
    return false;
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function stateKey(stateDigest: string): string {
  return `state:${stateDigest}`;
}

function readNow(now: () => Date): number {
  const value = now().getTime();
  if (!Number.isSafeInteger(value)) throw unavailable();
  return value;
}

function encodeBoundedJson(value: unknown, limit: number): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw unavailable();
  }
  if (textEncoder.encode(encoded).byteLength > limit) throw unavailable();
  return encoded;
}

async function readBoundedJson(source: Request | Response, limit: number): Promise<unknown> {
  const declared = source.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    throw unavailable();
  }
  if (source.body === null) throw unavailable();
  const reader = (source.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw unavailable();
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
    ) as unknown;
  } catch {
    throw unavailable();
  }
}

function errorResponse(code: OAuthStateStoreErrorCode, status: number): Response {
  return Response.json({ error: { code } }, { status, headers: JSON_HEADERS });
}

function invalidState(): OAuthStateStoreError {
  return new OAuthStateStoreError("oauth_state_invalid");
}

function unavailable(): OAuthStateStoreError {
  return new OAuthStateStoreError("oauth_state_store_unavailable");
}
