import type { SecretRef, SecretStore } from "./secret-store.js";
import type { SlackTokenRefreshClient } from "./slack-token-refresh-client.js";

const STATE_VERSION = 1;
const DEFAULT_REFRESH_SKEW_MS = 5 * 60_000;
const DEFAULT_MAX_JITTER_MS = 30_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 60_000;
const MAX_CREDENTIAL_BYTES = 7_500;

interface SlackCredentialReadyStateV1 {
  version: 1;
  status: "ready";
  generation: number;
  tokenId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

interface SlackCredentialRefreshingStateV1 extends Omit<SlackCredentialReadyStateV1, "status"> {
  status: "refreshing";
  startedAt: string;
}

interface SlackCredentialInterventionStateV1
  extends Omit<SlackCredentialReadyStateV1, "status"> {
  status: "intervention_required";
}

type SlackCredentialStateV1 =
  | SlackCredentialReadyStateV1
  | SlackCredentialRefreshingStateV1
  | SlackCredentialInterventionStateV1;

export interface SlackCredentialLifecycleMetadata {
  status: SlackCredentialStateV1["status"];
  generation: number;
  tokenId: string;
  expiresAt: string;
}

export interface SlackCredentialRefreshResult extends SlackCredentialLifecycleMetadata {
  refreshed: boolean;
}

export interface SlackCredentialLifecycleManager {
  inspect: () => Promise<SlackCredentialLifecycleMetadata>;
  resolveAccessToken: () => Promise<string>;
  refreshIfDue: () => Promise<SlackCredentialRefreshResult>;
}

export type SlackCredentialLifecycleErrorCode =
  | "slack_credential_expired"
  | "slack_credential_intervention_required"
  | "slack_credential_state_changed"
  | "slack_credential_state_invalid";

export class SlackCredentialLifecycleError extends Error {
  override readonly name = "SlackCredentialLifecycleError";

  constructor(readonly code: SlackCredentialLifecycleErrorCode) {
    super(code);
  }

  toJSON(): { code: SlackCredentialLifecycleErrorCode } {
    return { code: this.code };
  }
}

export async function initializeSlackCredentialLifecycle(params: {
  secretStore: SecretStore;
  ref: SecretRef;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  issuedAt: Date;
}): Promise<void> {
  if (
    !isCredential(params.accessToken) ||
    !isCredential(params.refreshToken) ||
    !isBoundedInteger(params.expiresIn, 1, 604_800) ||
    !Number.isFinite(params.issuedAt.getTime())
  ) {
    throw invalidState();
  }
  const state: SlackCredentialReadyStateV1 = {
    version: STATE_VERSION,
    status: "ready",
    generation: 1,
    tokenId: await credentialTokenId(params.accessToken),
    accessToken: params.accessToken,
    refreshToken: params.refreshToken,
    expiresAt: new Date(params.issuedAt.getTime() + params.expiresIn * 1_000).toISOString()
  };
  // Access and refresh credentials must become durable in one encrypted write. Splitting them
  // would let a Worker crash leave an access token that can expire without its one-use successor.
  await params.secretStore.putSecret({ ref: params.ref, value: JSON.stringify(state) });
}

export function createSlackCredentialLifecycleManager(params: {
  secretStore: SecretStore;
  ref: SecretRef;
  refreshClient: SlackTokenRefreshClient;
  now?: () => Date;
  refreshSkewMs?: number;
  maxJitterMs?: number;
  attemptTimeoutMs?: number;
}): SlackCredentialLifecycleManager {
  const now = params.now ?? (() => new Date());
  const refreshSkewMs = params.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const maxJitterMs = params.maxJitterMs ?? DEFAULT_MAX_JITTER_MS;
  const attemptTimeoutMs = params.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  if (
    !isBoundedInteger(refreshSkewMs, 0, 3_600_000) ||
    !isBoundedInteger(attemptTimeoutMs, 1_000, 600_000)
  ) {
    throw invalidState();
  }
  const jitterMs = stableJitter(params.ref, maxJitterMs);

  return {
    inspect: async () => metadata((await readState(params.secretStore, params.ref)).state),
    resolveAccessToken: async () => {
      const { state } = await readState(params.secretStore, params.ref);
      if (state.status === "intervention_required") throw interventionRequired();
      if (Date.parse(state.expiresAt) <= currentTime(now)) {
        throw new SlackCredentialLifecycleError("slack_credential_expired");
      }
      // A refresh is staged before the provider call. Slack keeps the previous access token usable
      // briefly, so callers can continue only until the replacement is durably committed.
      return state.accessToken;
    },
    refreshIfDue: async () => {
      const currentTimeMs = currentTime(now);
      const current = await readState(params.secretStore, params.ref);
      if (current.state.status === "intervention_required") throw interventionRequired();
      if (current.state.status === "refreshing") {
        if (currentTimeMs - Date.parse(current.state.startedAt) >= attemptTimeoutMs) {
          await persistIntervention(params.secretStore, params.ref, current);
          throw interventionRequired();
        }
        return { ...metadata(current.state), refreshed: false };
      }
      if (currentTimeMs < Date.parse(current.state.expiresAt) - refreshSkewMs - jitterMs) {
        return { ...metadata(current.state), refreshed: false };
      }

      const refreshing: SlackCredentialRefreshingStateV1 = {
        ...current.state,
        status: "refreshing",
        startedAt: new Date(currentTimeMs).toISOString()
      };
      const stagedValue = JSON.stringify(refreshing);
      const staged = await params.secretStore.compareAndSwapSecret({
        ref: params.ref,
        expectedValue: current.serialized,
        nextValue: stagedValue
      });
      if (!staged.matched) {
        const winner = await readState(params.secretStore, params.ref);
        return { ...metadata(winner.state), refreshed: false };
      }

      try {
        const replacement = await params.refreshClient.refresh(refreshing.refreshToken);
        if (
          !isCredential(replacement.accessToken) ||
          !isCredential(replacement.refreshToken) ||
          !isBoundedInteger(replacement.expiresIn, 1, 604_800)
        ) {
          throw new Error("invalid Slack refresh credential replacement");
        }
        const ready: SlackCredentialReadyStateV1 = {
          version: STATE_VERSION,
          status: "ready",
          generation: refreshing.generation + 1,
          tokenId: await credentialTokenId(replacement.accessToken),
          accessToken: replacement.accessToken,
          refreshToken: replacement.refreshToken,
          expiresAt: new Date(currentTimeMs + replacement.expiresIn * 1_000).toISOString()
        };
        const persisted = await params.secretStore.compareAndSwapSecret({
          ref: params.ref,
          expectedValue: stagedValue,
          nextValue: JSON.stringify(ready)
        });
        if (!persisted.matched) throw stateChanged();
        return { ...metadata(ready), refreshed: true };
      } catch (error) {
        if (error instanceof SlackCredentialLifecycleError) throw error;
        await persistIntervention(params.secretStore, params.ref, {
          state: refreshing,
          serialized: stagedValue
        });
        throw interventionRequired();
      }
    }
  };
}

async function persistIntervention(
  secretStore: SecretStore,
  ref: SecretRef,
  current: { state: SlackCredentialStateV1; serialized: string }
): Promise<void> {
  const intervention: SlackCredentialInterventionStateV1 = {
    version: STATE_VERSION,
    status: "intervention_required",
    generation: current.state.generation,
    tokenId: current.state.tokenId,
    accessToken: current.state.accessToken,
    refreshToken: current.state.refreshToken,
    expiresAt: current.state.expiresAt
  };
  const result = await secretStore.compareAndSwapSecret({
    ref,
    expectedValue: current.serialized,
    nextValue: JSON.stringify(intervention)
  });
  if (!result.matched) throw stateChanged();
}

async function readState(
  secretStore: SecretStore,
  ref: SecretRef
): Promise<{ state: SlackCredentialStateV1; serialized: string }> {
  const serialized = await secretStore.getSecret(ref);
  if (serialized === null) throw invalidState();
  return { state: parseState(serialized), serialized };
}

function parseState(serialized: string): SlackCredentialStateV1 {
  try {
    const value = JSON.parse(serialized) as Record<string, unknown>;
    const refreshing = value.status === "refreshing";
    const allowed = new Set([
      "version",
      "status",
      "generation",
      "tokenId",
      "accessToken",
      "refreshToken",
      "expiresAt",
      ...(refreshing ? ["startedAt"] : [])
    ]);
    if (
      Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.has(key)) ||
      value.version !== STATE_VERSION ||
      !["ready", "refreshing", "intervention_required"].includes(String(value.status)) ||
      !Number.isSafeInteger(value.generation) ||
      Number(value.generation) < 1 ||
      !isTokenId(value.tokenId) ||
      !isCredential(value.accessToken) ||
      !isCredential(value.refreshToken) ||
      !isCanonicalDate(value.expiresAt) ||
      (refreshing && !isCanonicalDate(value.startedAt))
    ) {
      throw invalidState();
    }
    return value as unknown as SlackCredentialStateV1;
  } catch {
    throw invalidState();
  }
}

function metadata(state: SlackCredentialStateV1): SlackCredentialLifecycleMetadata {
  return {
    status: state.status,
    generation: state.generation,
    tokenId: state.tokenId,
    expiresAt: state.expiresAt
  };
}

async function credentialTokenId(accessToken: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken))
  );
  let binary = "";
  for (const byte of digest.slice(0, 12)) binary += String.fromCharCode(byte);
  return `slack_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
}

function isTokenId(value: unknown): value is string {
  return typeof value === "string" && /^slack_[A-Za-z0-9_-]{16}$/u.test(value);
}

function stableJitter(ref: SecretRef, maximum: number): number {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 300_000) throw invalidState();
  if (maximum === 0) return 0;
  let hash = 2166136261;
  for (const character of `${ref.appId}:${ref.tenantId}:${ref.secretId}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % (maximum + 1);
}

function currentTime(now: () => Date): number {
  const value = now().getTime();
  if (!Number.isFinite(value)) throw invalidState();
  return value;
}

function isCredential(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_CREDENTIAL_BYTES
  );
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function invalidState(): SlackCredentialLifecycleError {
  return new SlackCredentialLifecycleError("slack_credential_state_invalid");
}

function interventionRequired(): SlackCredentialLifecycleError {
  return new SlackCredentialLifecycleError("slack_credential_intervention_required");
}

function stateChanged(): SlackCredentialLifecycleError {
  return new SlackCredentialLifecycleError("slack_credential_state_changed");
}
