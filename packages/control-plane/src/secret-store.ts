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

export function createInMemorySecretStore(): SecretStore {
  const secrets = new Map<string, string>();
  return createDurableObjectSecretStore({
    get: (key) => secrets.get(key),
    put: (key, value) => {
      secrets.set(key, value);
    }
  });
}

export function createDurableObjectSecretStore(storage: SecretStoreStorage): SecretStore {
  return {
    putSecret: async (request) => {
      validateSecretRef(request.ref);
      if (request.value.length === 0) {
        throw new Error("secret value must not be empty");
      }
      await storage.put(secretKey(request.ref), request.value);
      return request.ref;
    },
    getSecret: async (ref) => {
      validateSecretRef(ref);
      return (await storage.get(secretKey(ref))) ?? null;
    }
  };
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
