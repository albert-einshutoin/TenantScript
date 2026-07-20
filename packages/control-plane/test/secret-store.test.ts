import { describe, expect, it } from "vitest";
import {
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

function mapStorage(records: Map<string, string>): SecretStoreStorage {
  return {
    get: (key) => records.get(key),
    put: (key, value) => {
      records.set(key, value);
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
