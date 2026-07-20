export interface SecretRef {
  provider: string;
  tenantId: string;
  secretId: string;
}

export interface PutSecretRequest {
  ref: SecretRef;
  value: string;
}

export interface SecretStore {
  putSecret: (request: PutSecretRequest) => Promise<SecretRef> | SecretRef;
  getSecret: (ref: SecretRef) => Promise<string | null> | string | null;
}

export interface SecretStoreStorage {
  get: (key: string) => Promise<string | undefined> | string | undefined;
  put: (key: string, value: string) => Promise<void> | void;
}

export interface SecretEncryptionKey {
  id: string;
  key: CryptoKey;
}

export interface SecretEncryptionKeyring {
  currentKey: () => Promise<SecretEncryptionKey> | SecretEncryptionKey;
  keyById: (keyId: string) => Promise<CryptoKey | null> | CryptoKey | null;
}

export type SecretStoreErrorCode =
  | "invalid_secret_record"
  | "secret_encryption_failed"
  | "secret_encryption_key_invalid"
  | "secret_encryption_key_unavailable";

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
      const currentKey = await resolveCurrentKey(keyring);
      const dataKey = await generateAesGcmKey(true);
      const keyIv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
      const dataIv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
      let wrappedKey: ArrayBuffer;
      let ciphertext: ArrayBuffer;
      let rawDataKey: ArrayBuffer | null = null;
      try {
        const exportedDataKey = await crypto.subtle.exportKey("raw", dataKey);
        if (!(exportedDataKey instanceof ArrayBuffer)) {
          throw new Error("unexpected data key format");
        }
        rawDataKey = exportedDataKey;
        wrappedKey = await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: keyIv,
            additionalData: secretAdditionalData("key", request.ref, currentKey.id),
            tagLength: AES_GCM_TAG_BYTES * 8
          },
          currentKey.key,
          exportedDataKey
        );
        ciphertext = await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: dataIv,
            additionalData: secretAdditionalData("data", request.ref),
            tagLength: AES_GCM_TAG_BYTES * 8
          },
          dataKey,
          textEncoder.encode(request.value)
        );
      } catch {
        throw new SecretStoreError("secret_encryption_failed", "secret encryption failed");
      } finally {
        // Web Crypto needs an exportable per-record key for wrapping. Erasing our temporary raw
        // copy minimizes its lifetime; the deployment key itself remains non-extractable.
        if (rawDataKey !== null) new Uint8Array(rawDataKey).fill(0);
      }
      const envelope: SecretEnvelopeV1 = {
        version: SECRET_ENVELOPE_VERSION,
        algorithm: SECRET_ENVELOPE_ALGORITHM,
        keyId: currentKey.id,
        keyIv: encodeBase64Url(keyIv),
        wrappedKey: encodeBase64Url(new Uint8Array(wrappedKey)),
        iv: encodeBase64Url(dataIv),
        ciphertext: encodeBase64Url(new Uint8Array(ciphertext))
      };
      await storage.put(secretKey(request.ref), JSON.stringify(envelope));
      return request.ref;
    },
    getSecret: async (ref) => {
      validateSecretRef(ref);
      const record = await storage.get(secretKey(ref));
      if (record === undefined) return null;

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
        const dataKey = await crypto.subtle.importKey(
          "raw",
          rawDataKey,
          { name: "AES-GCM" },
          false,
          ["decrypt"]
        );
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
  };
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
  // one provider, tenant, and secret identifier without persisting those values in the envelope.
  return new Uint8Array(
    textEncoder.encode(
      JSON.stringify([
        "TenantScript secret envelope",
        SECRET_ENVELOPE_VERSION,
        purpose,
        ...(keyId === undefined ? [] : [keyId]),
        ref.provider,
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

function validateSecretRef(ref: SecretRef): void {
  if (ref.provider.length === 0 || ref.tenantId.length === 0 || ref.secretId.length === 0) {
    throw new Error("secret ref parts must not be empty");
  }
}

function secretKey(ref: SecretRef): string {
  return [ref.provider, ref.tenantId, ref.secretId].map(escapeSecretKeyPart).join(":");
}

function escapeSecretKeyPart(part: string): string {
  return part.replaceAll("%", "%25").replaceAll(":", "%3A");
}
