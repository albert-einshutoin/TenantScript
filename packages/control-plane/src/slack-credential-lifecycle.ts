import type { SecretRef, SecretStore } from "./secret-store.js";

interface SlackCredentialReadyStateV1 {
  version: 1;
  status: "ready";
  generation: number;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export async function initializeSlackCredentialLifecycle(params: {
  secretStore: SecretStore;
  ref: SecretRef;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  issuedAt: Date;
}): Promise<void> {
  const state: SlackCredentialReadyStateV1 = {
    version: 1,
    status: "ready",
    generation: 1,
    accessToken: params.accessToken,
    refreshToken: params.refreshToken,
    expiresAt: new Date(params.issuedAt.getTime() + params.expiresIn * 1_000).toISOString()
  };
  // Access and refresh credentials must become durable in one encrypted write. Splitting them
  // would let a Worker crash leave an access token that can expire without its one-use successor.
  await params.secretStore.putSecret({ ref: params.ref, value: JSON.stringify(state) });
}
