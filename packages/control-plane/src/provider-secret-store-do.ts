import {
  createAesGcmSecretEncryptionKeyring,
  createDurableObjectSecretStore,
  type AesGcmSecretEncryptionKeyringConfig,
  type CompareAndSwapSecretResult,
  type RewrapSecretResult,
  type SecretEncryptionKeyring,
  type SecretRef,
  type SecretStore,
  type SecretStoreStorage
} from "./secret-store.js";

const PROVIDER_SECRET_REQUEST_BYTES = 65_536;
const PROVIDER_SECRET_RESPONSE_BYTES = 65_536;
const PROVIDER_SECRET_VALUE_BYTES = 16_384;
const textEncoder = new TextEncoder();
const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8"
};

interface ProviderSecretStoreEnv {
  PROVIDER_SECRET_KEYRING_JSON?: string;
}

interface DurableObjectTransactionLike {
  get: <T>(key: string) => Promise<T | undefined>;
  put: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<boolean>;
}

interface DurableObjectStateLike {
  storage: {
    get: <T>(key: string) => Promise<T | undefined>;
    put: (key: string, value: string) => Promise<void>;
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

type ProviderSecretOperation = "put" | "get" | "compare-and-swap" | "rewrap";

export class ProviderSecretStoreDurableObject {
  private keyring?: Promise<SecretEncryptionKeyring>;

  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly env: ProviderSecretStoreEnv
  ) {}

  async fetch(request: Request): Promise<Response> {
    const operation = matchOperation(request);
    if (operation === null) return new Response(null, { status: 404, headers: JSON_HEADERS });
    let input: unknown;
    try {
      input = await readBoundedJson(request, PROVIDER_SECRET_REQUEST_BYTES);
      if (!isOperationInput(operation, input)) return invalidRequestResponse();
    } catch {
      return invalidRequestResponse();
    }
    try {
      const store = createDurableObjectSecretStore(
        createDurableObjectStorage(this.state),
        await this.resolveKeyring()
      );
      return await runOperation(store, operation, input);
    } catch {
      // This internal boundary handles plaintext provider tokens and key configuration. Keep every
      // failure stable so neither input nor platform error text can cross back to the caller.
      return Response.json(
        { error: { code: "provider_secret_store_unavailable" } },
        { status: 503, headers: JSON_HEADERS }
      );
    }
  }

  private resolveKeyring(): Promise<SecretEncryptionKeyring> {
    // A deployment-owned secret is immutable for the lifetime of one DO isolate. Cache imported,
    // non-extractable CryptoKeys so every token operation does not repeatedly decode key material.
    this.keyring ??= createAesGcmSecretEncryptionKeyring(
      parseKeyringConfiguration(this.env.PROVIDER_SECRET_KEYRING_JSON)
    );
    return this.keyring;
  }
}

function invalidRequestResponse(): Response {
  return Response.json(
    { error: { code: "provider_secret_store_invalid_request" } },
    { status: 400, headers: JSON_HEADERS }
  );
}

export function createDurableObjectNamespaceSecretStore<TId>(
  namespace: DurableObjectNamespaceLike<TId>
): SecretStore {
  const request = async (operation: ProviderSecretOperation, input: unknown): Promise<unknown> => {
    const ref = operationRef(input);
    if (!isSecretRef(ref)) throw unavailable();
    const objectName = await tenantObjectName(ref.tenantId);
    const body = encodeBoundedJson(input, PROVIDER_SECRET_REQUEST_BYTES);
    try {
      const stub = namespace.get(namespace.idFromName(objectName));
      const response = await stub.fetch(`https://provider-secret-store.internal/v1/${operation}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      });
      const expectedStatus = operation === "put" ? 204 : 200;
      if (response.status !== expectedStatus) throw unavailable();
      if (expectedStatus === 204) return undefined;
      return await readBoundedJson(response, PROVIDER_SECRET_RESPONSE_BYTES);
    } catch {
      throw unavailable();
    }
  };

  return {
    putSecret: async (input) => {
      await request("put", input);
      return input.ref;
    },
    getSecret: async (ref) => {
      const value = await request("get", { ref });
      if (
        !isExactRecord(value, ["value"]) ||
        (value.value !== null && typeof value.value !== "string")
      ) {
        throw unavailable();
      }
      return value.value;
    },
    compareAndSwapSecret: async (input) => {
      const value = await request("compare-and-swap", input);
      if (!isCompareAndSwapResult(value)) throw unavailable();
      return value;
    },
    rewrapSecret: async (ref) => {
      const value = await request("rewrap", { ref });
      if (!isExactRecord(value, ["result"])) throw unavailable();
      if (value.result === null) return null;
      if (!isRewrapResult(value.result)) throw unavailable();
      return value.result;
    }
  };
}

function createDurableObjectStorage(state: DurableObjectStateLike): SecretStoreStorage {
  return {
    get: (key) => state.storage.get<string>(key),
    put: (key, value) => state.storage.put(key, value),
    replaceIfUnchanged: (key, expected, next) =>
      state.blockConcurrencyWhile(() =>
        state.storage.transaction(async (transaction) => {
          const current = await transaction.get<string>(key);
          if (current !== expected) return false;
          if (next === undefined) await transaction.delete(key);
          else await transaction.put(key, next);
          return true;
        })
      )
  };
}

async function runOperation(
  store: SecretStore,
  operation: ProviderSecretOperation,
  input: unknown
): Promise<Response> {
  if (operation === "put") {
    if (!isPutRequest(input)) throw unavailable();
    await store.putSecret(input);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  if (operation === "get") {
    const ref = parseRefRequest(input);
    return Response.json({ value: await store.getSecret(ref) }, { headers: JSON_HEADERS });
  }
  if (operation === "compare-and-swap") {
    if (!isCompareAndSwapRequest(input)) throw unavailable();
    return Response.json(await store.compareAndSwapSecret(input), { headers: JSON_HEADERS });
  }
  const ref = parseRefRequest(input);
  return Response.json({ result: await store.rewrapSecret(ref) }, { headers: JSON_HEADERS });
}

function isOperationInput(operation: ProviderSecretOperation, input: unknown): boolean {
  if (operation === "put") return isPutRequest(input);
  if (operation === "compare-and-swap") return isCompareAndSwapRequest(input);
  return isExactRecord(input, ["ref"]) && isSecretRef(input.ref);
}

function matchOperation(request: Request): ProviderSecretOperation | null {
  if (request.method !== "POST") return null;
  const match = new URL(request.url).pathname.match(/^\/v1\/(put|get|compare-and-swap|rewrap)$/u);
  return (match?.[1] as ProviderSecretOperation | undefined) ?? null;
}

function operationRef(input: unknown): unknown {
  if (!isRecord(input)) return undefined;
  return input.ref;
}

function parseRefRequest(input: unknown): SecretRef {
  if (!isExactRecord(input, ["ref"]) || !isSecretRef(input.ref)) throw unavailable();
  return input.ref;
}

function isPutRequest(input: unknown): input is { ref: SecretRef; value: string } {
  return (
    isExactRecord(input, ["ref", "value"]) &&
    isSecretRef(input.ref) &&
    isProviderSecretValue(input.value)
  );
}

function isCompareAndSwapRequest(input: unknown): input is {
  ref: SecretRef;
  expectedValue: string | null;
  nextValue: string | null;
} {
  return (
    isExactRecord(input, ["ref", "expectedValue", "nextValue"]) &&
    isSecretRef(input.ref) &&
    isOptionalSecret(input.expectedValue) &&
    isOptionalSecret(input.nextValue)
  );
}

function isOptionalSecret(value: unknown): value is string | null {
  return value === null || isProviderSecretValue(value);
}

function isProviderSecretValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    textEncoder.encode(value).byteLength <= PROVIDER_SECRET_VALUE_BYTES
  );
}

function isSecretRef(value: unknown): value is SecretRef {
  return (
    isExactRecord(value, ["provider", "tenantId", "secretId"]) &&
    isBoundedText(value.provider) &&
    isBoundedText(value.tenantId) &&
    isBoundedText(value.secretId)
  );
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isCompareAndSwapResult(value: unknown): value is CompareAndSwapSecretResult {
  return (
    isExactRecord(value, ["matched", "changed"]) &&
    typeof value.matched === "boolean" &&
    typeof value.changed === "boolean"
  );
}

function isRewrapResult(value: unknown): value is RewrapSecretResult {
  return (
    isExactRecord(value, ["ref", "previousKeyId", "currentKeyId", "changed"]) &&
    isSecretRef(value.ref) &&
    isBoundedText(value.previousKeyId) &&
    isBoundedText(value.currentKeyId) &&
    typeof value.changed === "boolean"
  );
}

function parseKeyringConfiguration(value: string | undefined): AesGcmSecretEncryptionKeyringConfig {
  if (value === undefined || value.length > PROVIDER_SECRET_REQUEST_BYTES) throw unavailable();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw unavailable();
  }
  if (
    !isExactRecord(parsed, ["currentKeyId", "keys"]) ||
    typeof parsed.currentKeyId !== "string" ||
    !Array.isArray(parsed.keys) ||
    !parsed.keys.every(
      (key) =>
        isExactRecord(key, ["id", "material"]) &&
        typeof key.id === "string" &&
        typeof key.material === "string"
    )
  ) {
    throw unavailable();
  }
  return {
    currentKeyId: parsed.currentKeyId,
    keys: parsed.keys as { id: string; material: string }[]
  };
}

async function tenantObjectName(tenantId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(tenantId));
  return `provider-secrets-v1-${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
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
  const length = source.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit)) throw unavailable();
  if (source.body === null) throw unavailable();
  const reader = (source.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  try {
    while (!done) {
      const item = await reader.read();
      done = item.done;
      if (!item.done) {
        size += item.value.byteLength;
        if (size > limit) throw unavailable();
        chunks.push(item.value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw unavailable();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function unavailable(): Error {
  return new Error("provider secret store unavailable");
}
