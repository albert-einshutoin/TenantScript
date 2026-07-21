export interface SecretRef {
  provider: string;
  appId: string;
  tenantId: string;
  secretId: string;
}

export interface PutSecretRequest {
  ref: SecretRef;
  value: string;
}

export interface CompareAndSwapSecretRequest {
  ref: SecretRef;
  expectedValue: string | null;
  nextValue: string | null;
}

export interface CompareAndSwapSecretResult {
  matched: boolean;
  changed: boolean;
}

export interface SecretStore {
  putSecret: (request: PutSecretRequest) => Promise<SecretRef> | SecretRef;
  getSecret: (ref: SecretRef) => Promise<string | null> | string | null;
  compareAndSwapSecret: (
    request: CompareAndSwapSecretRequest
  ) => Promise<CompareAndSwapSecretResult>;
  rewrapSecret: (ref: SecretRef) => Promise<RewrapSecretResult | null>;
}

export interface RewrapSecretResult {
  ref: SecretRef;
  previousKeyId: string;
  currentKeyId: string;
  changed: boolean;
}

export interface SecretStoreStorage {
  get: (key: string) => Promise<string | undefined> | string | undefined;
  put: (key: string, value: string) => Promise<void> | void;
  // A rewrap must not overwrite an OAuth reconnect or token refresh that wins the race.
  // Production adapters therefore need one transactional compare-and-swap operation.
  replaceIfUnchanged: (
    key: string,
    expected: string | undefined,
    next: string | undefined
  ) => Promise<boolean> | boolean;
}

export interface SecretEncryptionKey {
  id: string;
  key: CryptoKey;
}

export interface SecretEncryptionKeyring {
  currentKey: () => Promise<SecretEncryptionKey> | SecretEncryptionKey;
  keyById: (keyId: string) => Promise<CryptoKey | null> | CryptoKey | null;
}

export interface EncodedSecretEncryptionKey {
  id: string;
  material: string;
}

export interface AesGcmSecretEncryptionKeyringConfig {
  currentKeyId: string;
  keys: readonly EncodedSecretEncryptionKey[];
}

export type SecretStoreErrorCode =
  | "invalid_secret_record"
  | "secret_encryption_failed"
  | "secret_encryption_key_configuration_invalid"
  | "secret_encryption_key_invalid"
  | "secret_encryption_key_unavailable"
  | "secret_record_changed";

export class SecretStoreError extends Error {
  readonly code: SecretStoreErrorCode;

  constructor(code: SecretStoreErrorCode, message: string) {
    super(message);
    this.name = "SecretStoreError";
    this.code = code;
  }
}

interface SecretEnvelopeV1 {
  version: 1;
  algorithm: "A256GCM";
  keyId: string;
  keyIv: string;
  wrappedKey: string;
  iv: string;
  ciphertext: string;
}

const SECRET_ENVELOPE_VERSION = 1;
const SECRET_ENVELOPE_ALGORITHM = "A256GCM";
const AES_256_KEY_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function createInMemorySecretStore(): SecretStore {
  const secrets = new Map<string, string>();
  const keyId = "in-memory-v1";
  const key = generateAesGcmKey();
  return createDurableObjectSecretStore(
    {
      get: (storageKey) => secrets.get(storageKey),
      put: (storageKey, value) => {
        secrets.set(storageKey, value);
      },
      replaceIfUnchanged: (storageKey, expected, next) => {
        if (secrets.get(storageKey) !== expected) return false;
        if (next === undefined) secrets.delete(storageKey);
        else secrets.set(storageKey, next);
        return true;
      }
    },
    {
      currentKey: async () => ({ id: keyId, key: await key }),
      keyById: async (requestedKeyId) => (requestedKeyId === keyId ? await key : null)
    }
  );
}

export function createDurableObjectSecretStore(
  storage: SecretStoreStorage,
  keyring: SecretEncryptionKeyring
): SecretStore {
  return {
    putSecret: async (request) => {
      validateSecretRef(request.ref);
      if (request.value.length === 0) {
        throw new Error("secret value must not be empty");
      }
      const record = await encryptSecretValue(request.ref, request.value, keyring);
      await storage.put(secretKey(request.ref), record);
      return request.ref;
    },
    getSecret: async (ref) => {
      validateSecretRef(ref);
      const record = await storage.get(secretKey(ref));
      if (record === undefined) return null;

      return decryptSecretRecord(ref, record, keyring);
    },
    compareAndSwapSecret: async (request) => {
      validateSecretRef(request.ref);
      validateOptionalSecretValue(request.expectedValue);
      validateOptionalSecretValue(request.nextValue);
      const storageKey = secretKey(request.ref);
      const record = await storage.get(storageKey);
      if (record === undefined) {
        if (request.expectedValue !== null) return { matched: false, changed: false };
        if (request.nextValue === null) return { matched: true, changed: false };
      } else {
        if (request.expectedValue === null) return { matched: false, changed: false };
        const currentValue = await decryptSecretRecord(request.ref, record, keyring);
        if (currentValue !== request.expectedValue) return { matched: false, changed: false };
        if (request.nextValue === currentValue) return { matched: true, changed: false };
      }

      const nextRecord =
        request.nextValue === null
          ? undefined
          : await encryptSecretValue(request.ref, request.nextValue, keyring);
      // The ciphertext observed above is the revision token. One storage transaction must compare
      // and replace it so an OAuth reconnect cannot be lost between decrypt and write.
      const replaced = await storage.replaceIfUnchanged(storageKey, record, nextRecord);
      return replaced ? { matched: true, changed: true } : { matched: false, changed: false };
    },
    rewrapSecret: async (ref) => {
      validateSecretRef(ref);
      const storageKey = secretKey(ref);
      const record = await storage.get(storageKey);
      if (record === undefined) return null;

      const envelope = parseSecretEnvelope(record);
      const currentKey = await resolveCurrentKey(keyring);
      // The current key is authoritative for its ID. Authenticating with it prevents a custom
      // keyring from hiding different key material behind the same public identifier.
      const previousKey =
        envelope.keyId === currentKey.id
          ? currentKey.key
          : await resolveDecryptionKey(keyring, envelope.keyId);
      const rawDataKey = await unwrapDataKey(envelope, ref, previousKey);
      try {
        if (envelope.keyId === currentKey.id) {
          return {
            ref,
            previousKeyId: envelope.keyId,
            currentKeyId: currentKey.id,
            changed: false
          };
        }
        const rewrapped = await wrapDataKey(rawDataKey, ref, currentKey);
        const nextRecord = JSON.stringify({
          ...envelope,
          keyId: currentKey.id,
          keyIv: rewrapped.keyIv,
          wrappedKey: rewrapped.wrappedKey
        } satisfies SecretEnvelopeV1);
        if (!(await storage.replaceIfUnchanged(storageKey, record, nextRecord))) {
          throw new SecretStoreError(
            "secret_record_changed",
            "secret record changed during rewrap"
          );
        }
        return {
          ref,
          previousKeyId: envelope.keyId,
          currentKeyId: currentKey.id,
          changed: true
        };
      } finally {
        new Uint8Array(rawDataKey).fill(0);
      }
    }
  };
}

async function encryptSecretValue(
  ref: SecretRef,
  value: string,
  keyring: SecretEncryptionKeyring
): Promise<string> {
  const currentKey = await resolveCurrentKey(keyring);
  const dataKey = await generateAesGcmKey(true);
  const keyIv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const dataIv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  let wrappedKey: ArrayBuffer;
  let ciphertext: ArrayBuffer;
  let rawDataKey: ArrayBuffer | null = null;
  try {
    const exportedDataKey = await crypto.subtle.exportKey("raw", dataKey);
    if (!(exportedDataKey instanceof ArrayBuffer)) throw new Error("unexpected data key format");
    rawDataKey = exportedDataKey;
    wrappedKey = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: keyIv,
        additionalData: secretAdditionalData("key", ref, currentKey.id),
        tagLength: AES_GCM_TAG_BYTES * 8
      },
      currentKey.key,
      exportedDataKey
    );
    ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: dataIv,
        additionalData: secretAdditionalData("data", ref),
        tagLength: AES_GCM_TAG_BYTES * 8
      },
      dataKey,
      textEncoder.encode(value)
    );
  } catch {
    throw new SecretStoreError("secret_encryption_failed", "secret encryption failed");
  } finally {
    // Web Crypto needs an exportable per-record key for wrapping. Erasing our temporary raw
    // copy minimizes its lifetime; the deployment key itself remains non-extractable.
    if (rawDataKey !== null) new Uint8Array(rawDataKey).fill(0);
  }
  return JSON.stringify({
    version: SECRET_ENVELOPE_VERSION,
    algorithm: SECRET_ENVELOPE_ALGORITHM,
    keyId: currentKey.id,
    keyIv: encodeBase64Url(keyIv),
    wrappedKey: encodeBase64Url(new Uint8Array(wrappedKey)),
    iv: encodeBase64Url(dataIv),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext))
  } satisfies SecretEnvelopeV1);
}

async function decryptSecretRecord(
  ref: SecretRef,
  record: string,
  keyring: SecretEncryptionKeyring
): Promise<string> {
  const envelope = parseSecretEnvelope(record);
  const key = await resolveDecryptionKey(keyring, envelope.keyId);
  let rawDataKey: ArrayBuffer | null = null;
  try {
    rawDataKey = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decodeBase64Url(envelope.keyIv),
        additionalData: secretAdditionalData("key", ref, envelope.keyId),
        tagLength: AES_GCM_TAG_BYTES * 8
      },
      key,
      decodeBase64Url(envelope.wrappedKey)
    );
    if (rawDataKey.byteLength !== AES_256_KEY_BYTES) throw invalidSecretRecord();
    const dataKey = await crypto.subtle.importKey("raw", rawDataKey, { name: "AES-GCM" }, false, [
      "decrypt"
    ]);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decodeBase64Url(envelope.iv),
        additionalData: secretAdditionalData("data", ref),
        tagLength: AES_GCM_TAG_BYTES * 8
      },
      dataKey,
      decodeBase64Url(envelope.ciphertext)
    );
    return textDecoder.decode(plaintext);
  } catch {
    // Authentication, malformed ciphertext, and decoding errors share one public error so
    // storage corruption cannot become an oracle for key or plaintext information.
    throw invalidSecretRecord();
  } finally {
    if (rawDataKey !== null) new Uint8Array(rawDataKey).fill(0);
  }
}

export async function createAesGcmSecretEncryptionKeyring(
  config: AesGcmSecretEncryptionKeyringConfig
): Promise<SecretEncryptionKeyring> {
  try {
    const currentKeyId = config.currentKeyId;
    validateKeyId(currentKeyId);
    if (config.keys.length === 0) throw new Error("missing keys");
    const keys = new Map<string, CryptoKey>();
    for (const encoded of config.keys) {
      validateKeyId(encoded.id);
      if (keys.has(encoded.id)) throw new Error("duplicate key id");
      const material = decodeBase64Url(encoded.material);
      try {
        if (material.byteLength !== AES_256_KEY_BYTES) throw new Error("invalid key length");
        keys.set(
          encoded.id,
          await crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
            "encrypt",
            "decrypt"
          ])
        );
      } finally {
        material.fill(0);
      }
    }
    if (!keys.has(currentKeyId)) throw new Error("current key is missing");
    return {
      currentKey: () => {
        const key = keys.get(currentKeyId);
        if (key === undefined) throw invalidKeyConfiguration();
        return { id: currentKeyId, key };
      },
      keyById: (keyId) => keys.get(keyId) ?? null
    };
  } catch {
    throw invalidKeyConfiguration();
  }
}

async function unwrapDataKey(
  envelope: SecretEnvelopeV1,
  ref: SecretRef,
  key: CryptoKey
): Promise<ArrayBuffer> {
  try {
    const rawDataKey = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decodeBase64Url(envelope.keyIv),
        additionalData: secretAdditionalData("key", ref, envelope.keyId),
        tagLength: AES_GCM_TAG_BYTES * 8
      },
      key,
      decodeBase64Url(envelope.wrappedKey)
    );
    if (rawDataKey.byteLength !== AES_256_KEY_BYTES) throw invalidSecretRecord();
    return rawDataKey;
  } catch {
    throw invalidSecretRecord();
  }
}

async function wrapDataKey(
  rawDataKey: ArrayBuffer,
  ref: SecretRef,
  currentKey: SecretEncryptionKey
): Promise<{ keyIv: string; wrappedKey: string }> {
  const keyIv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  try {
    const wrappedKey = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: keyIv,
        additionalData: secretAdditionalData("key", ref, currentKey.id),
        tagLength: AES_GCM_TAG_BYTES * 8
      },
      currentKey.key,
      rawDataKey
    );
    return {
      keyIv: encodeBase64Url(keyIv),
      wrappedKey: encodeBase64Url(new Uint8Array(wrappedKey))
    };
  } catch {
    throw new SecretStoreError("secret_encryption_failed", "secret encryption failed");
  }
}

async function resolveCurrentKey(keyring: SecretEncryptionKeyring): Promise<SecretEncryptionKey> {
  let current: SecretEncryptionKey;
  try {
    current = await keyring.currentKey();
  } catch {
    throw new SecretStoreError(
      "secret_encryption_key_unavailable",
      "secret encryption key is unavailable"
    );
  }
  validateKeyId(current.id);
  validateAesGcmKey(current.key, "encrypt");
  return current;
}

async function resolveDecryptionKey(
  keyring: SecretEncryptionKeyring,
  keyId: string
): Promise<CryptoKey> {
  let key: CryptoKey | null;
  try {
    key = await keyring.keyById(keyId);
  } catch {
    key = null;
  }
  if (key === null) {
    throw new SecretStoreError(
      "secret_encryption_key_unavailable",
      "secret encryption key is unavailable"
    );
  }
  validateAesGcmKey(key, "decrypt");
  return key;
}

function validateAesGcmKey(key: CryptoKey, usage: "encrypt" | "decrypt"): void {
  const algorithm = key.algorithm;
  if (
    key.type !== "secret" ||
    key.extractable ||
    algorithm.name !== "AES-GCM" ||
    !("length" in algorithm) ||
    algorithm.length !== 256 ||
    !key.usages.includes(usage)
  ) {
    throw new SecretStoreError("secret_encryption_key_invalid", "secret encryption key is invalid");
  }
}

async function generateAesGcmKey(extractable = false): Promise<CryptoKey> {
  const generated = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: AES_256_KEY_BYTES * 8 },
    extractable,
    ["encrypt", "decrypt"]
  );
  if ("publicKey" in generated) {
    throw new SecretStoreError("secret_encryption_key_invalid", "secret encryption key is invalid");
  }
  return generated;
}

function parseSecretEnvelope(record: string): SecretEnvelopeV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record);
  } catch {
    throw invalidSecretRecord();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidSecretRecord();
  }
  const value = parsed as Record<string, unknown>;
  if (
    !hasOnlyEnvelopeKeys(value) ||
    value.version !== SECRET_ENVELOPE_VERSION ||
    value.algorithm !== SECRET_ENVELOPE_ALGORITHM ||
    typeof value.keyId !== "string" ||
    typeof value.keyIv !== "string" ||
    typeof value.wrappedKey !== "string" ||
    typeof value.iv !== "string" ||
    typeof value.ciphertext !== "string"
  ) {
    throw invalidSecretRecord();
  }
  try {
    validateKeyId(value.keyId);
    const keyIv = decodeBase64Url(value.keyIv);
    const wrappedKey = decodeBase64Url(value.wrappedKey);
    const iv = decodeBase64Url(value.iv);
    const ciphertext = decodeBase64Url(value.ciphertext);
    if (
      keyIv.byteLength !== AES_GCM_IV_BYTES ||
      wrappedKey.byteLength !== AES_256_KEY_BYTES + AES_GCM_TAG_BYTES ||
      iv.byteLength !== AES_GCM_IV_BYTES ||
      ciphertext.byteLength <= AES_GCM_TAG_BYTES
    ) {
      throw invalidSecretRecord();
    }
  } catch {
    throw invalidSecretRecord();
  }
  return {
    version: SECRET_ENVELOPE_VERSION,
    algorithm: SECRET_ENVELOPE_ALGORITHM,
    keyId: value.keyId,
    keyIv: value.keyIv,
    wrappedKey: value.wrappedKey,
    iv: value.iv,
    ciphertext: value.ciphertext
  };
}

function hasOnlyEnvelopeKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return keys.join(",") === "algorithm,ciphertext,iv,keyId,keyIv,version,wrappedKey";
}

function validateKeyId(keyId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(keyId)) {
    throw new SecretStoreError("secret_encryption_key_invalid", "secret encryption key is invalid");
  }
}

function secretAdditionalData(
  purpose: "data" | "key",
  ref: SecretRef,
  keyId?: string
): Uint8Array<ArrayBuffer> {
  // Length-delimited JSON avoids ambiguous concatenation and binds a valid ciphertext to exactly
  // one provider, app, tenant, and secret identifier without persisting those values in the envelope.
  return new Uint8Array(
    textEncoder.encode(
      JSON.stringify([
        "TenantScript secret envelope",
        SECRET_ENVELOPE_VERSION,
        purpose,
        ...(keyId === undefined ? [] : [keyId]),
        ref.provider,
        ref.appId,
        ref.tenantId,
        ref.secretId
      ])
    )
  );
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw invalidSecretRecord();
  }
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw invalidSecretRecord();
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (encodeBase64Url(bytes) !== value) throw invalidSecretRecord();
  return bytes;
}

function invalidSecretRecord(): SecretStoreError {
  return new SecretStoreError("invalid_secret_record", "secret record is invalid");
}

function invalidKeyConfiguration(): SecretStoreError {
  return new SecretStoreError(
    "secret_encryption_key_configuration_invalid",
    "secret encryption key configuration is invalid"
  );
}

function validateOptionalSecretValue(value: string | null): void {
  if (value !== null && value.length === 0) throw new Error("secret value must not be empty");
}

function validateSecretRef(ref: SecretRef): void {
  if (
    ref.provider.length === 0 ||
    ref.appId.length === 0 ||
    ref.tenantId.length === 0 ||
    ref.secretId.length === 0
  ) {
    throw new Error("secret ref parts must not be empty");
  }
}

function secretKey(ref: SecretRef): string {
  return [ref.provider, ref.appId, ref.tenantId, ref.secretId].map(escapeSecretKeyPart).join(":");
}

function escapeSecretKeyPart(part: string): string {
  return part.replaceAll("%", "%25").replaceAll(":", "%3A");
}
