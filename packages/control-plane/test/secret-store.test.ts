import { describe, expect, it, vi } from "vitest";
import {
  createAesGcmSecretEncryptionKeyring,
  createDurableObjectSecretStore,
  type SecretEncryptionKeyring,
  type SecretRef,
  type SecretStoreStorage
} from "../src/secret-store.js";

describe("encrypted secret store", () => {
  it("stores only a versioned randomized envelope and decrypts the original value", async () => {
    const records = new Map<string, string>();
    const store = createDurableObjectSecretStore(mapStorage(records), await keyring("key-v1", 11));
    const ref = secretRef("tenant_1", "workspace_1");

    await expect(store.getSecret(ref)).resolves.toBeNull();
    await store.putSecret({ ref, value: "xoxb-synthetic-secret" });
    const firstRecord = onlyRecord(records);
    expect(firstRecord).not.toContain("xoxb-synthetic-secret");
    const envelope = JSON.parse(firstRecord) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      version: 1,
      algorithm: "A256GCM",
      keyId: "key-v1"
    });
    expect(typeof envelope.keyIv).toBe("string");
    expect(typeof envelope.wrappedKey).toBe("string");
    expect(typeof envelope.iv).toBe("string");
    expect(typeof envelope.ciphertext).toBe("string");
    await expect(store.getSecret(ref)).resolves.toBe("xoxb-synthetic-secret");

    await store.putSecret({ ref, value: "xoxb-synthetic-secret" });
    expect(onlyRecord(records)).not.toBe(firstRecord);
  });

  it("binds ciphertext to the complete secret ref", async () => {
    const records = new Map<string, string>();
    const keys = await keyring("key-v1", 22);
    const store = createDurableObjectSecretStore(mapStorage(records), keys);
    const sourceRef = secretRef("tenant_1", "workspace_1");
    const targetRef = secretRef("tenant_2", "workspace_1");

    await store.putSecret({ ref: sourceRef, value: "tenant-bound-secret" });
    const sourceRecord = onlyRecord(records);
    await store.putSecret({ ref: targetRef, value: "placeholder" });
    const targetKey = [...records.keys()].find((key) => records.get(key) !== sourceRecord);
    expect(targetKey).toBeDefined();
    records.set(targetKey ?? "", sourceRecord);

    await expect(store.getSecret(targetRef)).rejects.toThrow("secret record is invalid");
    await expect(store.getSecret(sourceRef)).resolves.toBe("tenant-bound-secret");
  });

  it("rejects tampered wrapped keys and ciphertext without exposing cryptographic details", async () => {
    const records = new Map<string, string>();
    const store = createDurableObjectSecretStore(mapStorage(records), await keyring("key-v1", 33));
    const ref = secretRef("tenant_1", "workspace_1");
    await store.putSecret({ ref, value: "tamper-evident-secret" });

    const [recordKey, rawRecord] = onlyEntry(records);
    const envelope = JSON.parse(rawRecord) as { ciphertext: string };
    envelope.ciphertext = replaceFirstBase64UrlCharacter(envelope.ciphertext);
    records.set(recordKey, JSON.stringify(envelope));

    await expect(store.getSecret(ref)).rejects.toThrow("secret record is invalid");

    const wrappedKeyEnvelope = JSON.parse(rawRecord) as { wrappedKey: string };
    wrappedKeyEnvelope.wrappedKey = replaceFirstBase64UrlCharacter(wrappedKeyEnvelope.wrappedKey);
    records.set(recordKey, JSON.stringify(wrappedKeyEnvelope));
    await expect(store.getSecret(ref)).rejects.toThrow("secret record is invalid");
  });

  it("decrypts an old envelope after the current encryption key rotates", async () => {
    const records = new Map<string, string>();
    const oldKey = await importSyntheticKey(44);
    const newKey = await importSyntheticKey(55);
    const ref = secretRef("tenant_1", "workspace_1");
    const oldStore = createDurableObjectSecretStore(
      mapStorage(records),
      staticKeyring("key-v1", new Map([["key-v1", oldKey]]))
    );
    await oldStore.putSecret({ ref, value: "rotation-safe-secret" });

    const rotatedStore = createDurableObjectSecretStore(
      mapStorage(records),
      staticKeyring(
        "key-v2",
        new Map([
          ["key-v1", oldKey],
          ["key-v2", newKey]
        ])
      )
    );
    await expect(rotatedStore.getSecret(ref)).resolves.toBe("rotation-safe-secret");
    const newRef = secretRef("tenant_1", "workspace_2");
    await rotatedStore.putSecret({ ref: newRef, value: "new-key-secret" });
    const newEnvelope = [...records.values()]
      .map((record) => JSON.parse(record) as Record<string, unknown>)
      .find((record) => record.keyId === "key-v2");
    expect(newEnvelope).toBeDefined();
    await expect(rotatedStore.getSecret(newRef)).resolves.toBe("new-key-secret");

    const missingOldKeyStore = createDurableObjectSecretStore(
      mapStorage(records),
      staticKeyring("key-v2", new Map([["key-v2", newKey]]))
    );
    await expect(missingOldKeyStore.getSecret(ref)).rejects.toThrow(
      "secret encryption key is unavailable"
    );
  });

  it("rewraps only the DEK so the old KEK can be retired", async () => {
    const records = new Map<string, string>();
    const oldKey = await importSyntheticKey(91);
    const newKey = await importSyntheticKey(92);
    const ref = secretRef("tenant_1", "workspace_1");
    const oldStore = createDurableObjectSecretStore(
      mapStorage(records),
      staticKeyring("key-v1", new Map([["key-v1", oldKey]]))
    );
    await oldStore.putSecret({ ref, value: "rewrap-without-data-decrypt" });
    const before = JSON.parse(onlyRecord(records)) as Record<string, unknown>;

    const rotatedStore = createDurableObjectSecretStore(
      mapStorage(records),
      staticKeyring(
        "key-v2",
        new Map([
          ["key-v1", oldKey],
          ["key-v2", newKey]
        ])
      )
    );
    await expect(rotatedStore.rewrapSecret(ref)).resolves.toEqual({
      ref,
      previousKeyId: "key-v1",
      currentKeyId: "key-v2",
      changed: true
    });

    const after = JSON.parse(onlyRecord(records)) as Record<string, unknown>;
    expect(after.keyId).toBe("key-v2");
    expect(after.iv).toBe(before.iv);
    expect(after.ciphertext).toBe(before.ciphertext);
    expect(after.keyIv).not.toBe(before.keyIv);
    expect(after.wrappedKey).not.toBe(before.wrappedKey);

    const newKeyOnlyStore = createDurableObjectSecretStore(
      mapStorage(records),
      staticKeyring("key-v2", new Map([["key-v2", newKey]]))
    );
    await expect(newKeyOnlyStore.getSecret(ref)).resolves.toBe("rewrap-without-data-decrypt");
  });

  it("does not overwrite a concurrent secret update during rewrap", async () => {
    const oldKey = await importSyntheticKey(93);
    const newKey = await importSyntheticKey(94);
    const ref = secretRef("tenant_1", "workspace_1");
    const records = new Map<string, string>();
    const originalStore = createDurableObjectSecretStore(
      mapStorage(records),
      staticKeyring("key-v1", new Map([["key-v1", oldKey]]))
    );
    await originalStore.putSecret({ ref, value: "original-secret" });

    const concurrentRecords = new Map<string, string>();
    const concurrentStore = createDurableObjectSecretStore(
      mapStorage(concurrentRecords),
      staticKeyring("key-v1", new Map([["key-v1", oldKey]]))
    );
    await concurrentStore.putSecret({ ref, value: "concurrent-secret" });
    const concurrentRecord = onlyRecord(concurrentRecords);
    const storage = mapStorage(records);
    storage.replaceIfUnchanged = vi.fn((key: string) => {
      records.set(key, concurrentRecord);
      return false;
    });
    const rotatedStore = createDurableObjectSecretStore(
      storage,
      staticKeyring(
        "key-v2",
        new Map([
          ["key-v1", oldKey],
          ["key-v2", newKey]
        ])
      )
    );

    await expect(rotatedStore.rewrapSecret(ref)).rejects.toThrow(
      "secret record changed during rewrap"
    );
    await expect(originalStore.getSecret(ref)).resolves.toBe("concurrent-secret");
  });

  it("returns null for a missing rewrap and validates an already-current envelope", async () => {
    const records = new Map<string, string>();
    const storage = mapStorage(records);
    const replaceIfUnchanged = vi.spyOn(storage, "replaceIfUnchanged");
    const store = createDurableObjectSecretStore(storage, await keyring("key-v1", 95));
    const ref = secretRef("tenant_1", "workspace_1");

    await expect(store.rewrapSecret(ref)).resolves.toBeNull();
    await store.putSecret({ ref, value: "already-current" });
    await expect(store.rewrapSecret(ref)).resolves.toEqual({
      ref,
      previousKeyId: "key-v1",
      currentKeyId: "key-v1",
      changed: false
    });
    expect(replaceIfUnchanged).not.toHaveBeenCalled();
  });

  it("rejects an inconsistent current key instead of treating the same key id as current", async () => {
    const records = new Map<string, string>();
    const originalKey = await importSyntheticKey(96);
    const inconsistentKey = await importSyntheticKey(97);
    const ref = secretRef("tenant_1", "workspace_1");
    const originalStore = createDurableObjectSecretStore(
      mapStorage(records),
      staticKeyring("key-v1", new Map([["key-v1", originalKey]]))
    );
    await originalStore.putSecret({ ref, value: "same-id-different-key" });

    const inconsistentStore = createDurableObjectSecretStore(mapStorage(records), {
      currentKey: () => ({ id: "key-v1", key: inconsistentKey }),
      keyById: () => originalKey
    });
    await expect(inconsistentStore.rewrapSecret(ref)).rejects.toThrow("secret record is invalid");
  });

  it("rejects keys that are not non-extractable AES-256-GCM keys", async () => {
    const shortKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(16).fill(77),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
    const extractableKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32).fill(88),
      { name: "AES-GCM" },
      true,
      ["encrypt", "decrypt"]
    );

    for (const invalidKey of [shortKey, extractableKey]) {
      const records = new Map<string, string>();
      const store = createDurableObjectSecretStore(
        mapStorage(records),
        staticKeyring("key-v1", new Map([["key-v1", invalidKey]]))
      );
      await expect(
        store.putSecret({ ref: secretRef("tenant_1", "workspace_1"), value: "secret" })
      ).rejects.toThrow("secret encryption key is invalid");
      expect(records.size).toBe(0);
    }
  });

  it.each([
    ["legacy plaintext", "legacy-plaintext-token"],
    ["malformed JSON", "{"],
    ["unknown version", serializedEnvelope({ version: 2 })],
    ["unknown algorithm", serializedEnvelope({ algorithm: "AES-CBC" })],
    ["invalid base64url", serializedEnvelope({ iv: "not+base64" })],
    ["additional fields", serializedEnvelope({ plaintext: "must-not-be-accepted" })]
  ])("fails closed for %s records", async (_name, rawRecord) => {
    const records = new Map<string, string>();
    const store = createDurableObjectSecretStore(mapStorage(records), await keyring("key-v1", 66));
    const ref = secretRef("tenant_1", "workspace_1");
    await store.putSecret({ ref, value: "seed" });
    const [recordKey] = onlyEntry(records);
    records.set(recordKey, rawRecord);

    await expect(store.getSecret(ref)).rejects.toThrow("secret record is invalid");
  });
});

describe("AES-GCM secret encryption keyring", () => {
  it("imports current and retained 256-bit keys as non-extractable KEKs", async () => {
    const keyring = await createAesGcmSecretEncryptionKeyring({
      currentKeyId: "key-v2",
      keys: [
        { id: "key-v1", material: syntheticKeyMaterial(101, 32) },
        { id: "key-v2", material: syntheticKeyMaterial(102, 32) }
      ]
    });

    const current = await keyring.currentKey();
    expect(current.id).toBe("key-v2");
    expect(current.key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(current.key.extractable).toBe(false);
    expect(await keyring.keyById("key-v1")).toBeInstanceOf(CryptoKey);
    expect(await keyring.keyById("missing")).toBeNull();
  });

  it.each([
    ["empty keyring", "key-v1", []],
    ["missing current key", "key-v2", [{ id: "key-v1", material: syntheticKeyMaterial(1, 32) }]],
    [
      "duplicate key id",
      "key-v1",
      [
        { id: "key-v1", material: syntheticKeyMaterial(1, 32) },
        { id: "key-v1", material: syntheticKeyMaterial(2, 32) }
      ]
    ],
    ["invalid key id", "bad key", [{ id: "bad key", material: syntheticKeyMaterial(1, 32) }]],
    ["padded material", "key-v1", [{ id: "key-v1", material: `${syntheticKeyMaterial(1, 32)}=` }]],
    ["short material", "key-v1", [{ id: "key-v1", material: syntheticKeyMaterial(1, 31) }]],
    ["long material", "key-v1", [{ id: "key-v1", material: syntheticKeyMaterial(1, 33) }]],
    ["invalid encoding", "key-v1", [{ id: "key-v1", material: "not+base64url" }]]
  ])("rejects %s without echoing key material", async (_name, currentKeyId, keys) => {
    let caught: unknown;
    try {
      await createAesGcmSecretEncryptionKeyring({ currentKeyId, keys });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("secret encryption key configuration is invalid");
    for (const key of keys) expect((caught as Error).message).not.toContain(key.material);
  });
});

function mapStorage(records: Map<string, string>): SecretStoreStorage {
  return {
    get: (key) => records.get(key),
    put: (key, value) => {
      records.set(key, value);
    },
    replaceIfUnchanged: (key, expected, next) => {
      if (records.get(key) !== expected) return false;
      records.set(key, next);
      return true;
    }
  };
}

async function keyring(currentKeyId: string, fill: number): Promise<SecretEncryptionKeyring> {
  return staticKeyring(currentKeyId, new Map([[currentKeyId, await importSyntheticKey(fill)]]));
}

function staticKeyring(
  currentKeyId: string,
  keys: ReadonlyMap<string, CryptoKey>
): SecretEncryptionKeyring {
  return {
    currentKey: () => {
      const key = keys.get(currentKeyId);
      if (key === undefined) throw new Error("synthetic current key is missing");
      return { id: currentKeyId, key };
    },
    keyById: (keyId) => Promise.resolve(keys.get(keyId) ?? null)
  };
}

function importSyntheticKey(fill: number): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(32).fill(fill), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt"
  ]);
}

function secretRef(tenantId: string, workspaceId: string): SecretRef {
  return { provider: "slack", tenantId, secretId: `slack:${workspaceId}` };
}

function onlyRecord(records: ReadonlyMap<string, string>): string {
  return onlyEntry(records)[1];
}

function onlyEntry(records: ReadonlyMap<string, string>): [string, string] {
  expect(records.size).toBe(1);
  const entry = records.entries().next().value;
  if (entry === undefined) throw new Error("expected one stored record");
  return entry;
}

function replaceFirstBase64UrlCharacter(value: string): string {
  const first = value[0];
  if (first === undefined) throw new Error("expected ciphertext");
  return `${first === "A" ? "B" : "A"}${value.slice(1)}`;
}

function serializedEnvelope(overrides: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({
    version: 1,
    algorithm: "A256GCM",
    keyId: "key-v1",
    keyIv: "AAAAAAAAAAAAAAAA",
    wrappedKey: "A".repeat(64),
    iv: "AAAAAAAAAAAAAAAA",
    ciphertext: "A".repeat(23),
    ...overrides
  });
}

function syntheticKeyMaterial(fill: number, length: number): string {
  const bytes = new Uint8Array(length).fill(fill);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
