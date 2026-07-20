import type { SecretRef, SecretStore } from "./secret-store.js";

export interface ProviderTokenValue {
  id: string;
  value: string;
}

export interface ProviderTokenResolutionSnapshot {
  active: ProviderTokenValue;
  candidate?: ProviderTokenValue;
}

export interface ProviderTokenRotationMetadata {
  activeTokenId: string;
  candidateTokenId?: string;
  retiringTokenId?: string;
}

export interface ProviderTokenRotationManager {
  initialize: (active: ProviderTokenValue) => Promise<ProviderTokenRotationMetadata>;
  stageCandidate: (candidate: ProviderTokenValue) => Promise<ProviderTokenRotationMetadata>;
  promoteCandidate: (candidateTokenId: string) => Promise<ProviderTokenRotationMetadata>;
  abortCandidate: (candidateTokenId: string) => Promise<ProviderTokenRotationMetadata>;
  rollbackToRetiring: (retiringTokenId: string) => Promise<ProviderTokenRotationMetadata>;
  finalizeRetiring: (retiringTokenId: string) => Promise<ProviderTokenRotationMetadata>;
  resolveTokens: () => Promise<ProviderTokenResolutionSnapshot>;
  inspect: () => Promise<ProviderTokenRotationMetadata>;
}

export type ProviderTokenRotationStateErrorCode =
  | "provider_token_state_changed"
  | "provider_token_state_invalid"
  | "provider_token_transition_invalid";

export class ProviderTokenRotationStateError extends Error {
  readonly code: ProviderTokenRotationStateErrorCode;

  constructor(code: ProviderTokenRotationStateErrorCode, message: string) {
    super(message);
    this.name = "ProviderTokenRotationStateError";
    this.code = code;
  }
}

interface ProviderTokenStateV1 {
  version: 1;
  active: ProviderTokenValue;
  candidate?: ProviderTokenValue;
  retiring?: ProviderTokenValue;
}

const PROVIDER_TOKEN_STATE_VERSION = 1;
const MAX_PROVIDER_TOKEN_BYTES = 16_384;
const textEncoder = new TextEncoder();

export function createProviderTokenRotationManager(params: {
  secretStore: SecretStore;
  ref: SecretRef;
}): ProviderTokenRotationManager {
  const mutate = async (
    transition: (state: ProviderTokenStateV1) => ProviderTokenStateV1
  ): Promise<ProviderTokenRotationMetadata> => {
    const currentValue = await params.secretStore.getSecret(params.ref);
    if (currentValue === null) throw invalidState();
    const current = parseProviderTokenState(currentValue);
    const next = transition(current);
    const nextValue = serializeProviderTokenState(next);
    const result = await params.secretStore.compareAndSwapSecret({
      ref: params.ref,
      expectedValue: currentValue,
      nextValue
    });
    // Retrying here could apply an operator decision to a newer OAuth state. The caller must
    // inspect that state and deliberately repeat the transition instead.
    if (!result.matched) throw stateChanged();
    return metadata(next);
  };

  return {
    initialize: async (active) => {
      const state: ProviderTokenStateV1 = {
        version: PROVIDER_TOKEN_STATE_VERSION,
        active: normalizeProviderToken(active, invalidTransition)
      };
      const result = await params.secretStore.compareAndSwapSecret({
        ref: params.ref,
        expectedValue: null,
        nextValue: serializeProviderTokenState(state)
      });
      if (!result.matched) throw stateChanged();
      return metadata(state);
    },
    stageCandidate: (candidate) =>
      mutate((state) => {
        const nextCandidate = normalizeProviderToken(candidate, invalidTransition);
        if (
          state.candidate !== undefined ||
          state.retiring !== undefined ||
          nextCandidate.id === state.active.id
        ) {
          throw invalidTransition();
        }
        return { ...state, candidate: nextCandidate };
      }),
    promoteCandidate: (candidateTokenId) =>
      mutate((state) => {
        if (state.candidate?.id !== candidateTokenId || state.retiring !== undefined) {
          throw invalidTransition();
        }
        return {
          version: PROVIDER_TOKEN_STATE_VERSION,
          active: state.candidate,
          retiring: state.active
        };
      }),
    abortCandidate: (candidateTokenId) =>
      mutate((state) => {
        if (state.candidate?.id !== candidateTokenId) throw invalidTransition();
        return { version: PROVIDER_TOKEN_STATE_VERSION, active: state.active };
      }),
    rollbackToRetiring: (retiringTokenId) =>
      mutate((state) => {
        if (state.retiring?.id !== retiringTokenId || state.candidate !== undefined) {
          throw invalidTransition();
        }
        return {
          version: PROVIDER_TOKEN_STATE_VERSION,
          active: state.retiring,
          retiring: state.active
        };
      }),
    finalizeRetiring: (retiringTokenId) =>
      mutate((state) => {
        if (state.retiring?.id !== retiringTokenId) throw invalidTransition();
        return { version: PROVIDER_TOKEN_STATE_VERSION, active: state.active };
      }),
    resolveTokens: async () => {
      const state = await readState(params.secretStore, params.ref);
      return {
        active: { ...state.active },
        ...(state.candidate === undefined ? {} : { candidate: { ...state.candidate } })
      };
    },
    inspect: async () => metadata(await readState(params.secretStore, params.ref))
  };
}

async function readState(secretStore: SecretStore, ref: SecretRef): Promise<ProviderTokenStateV1> {
  const value = await secretStore.getSecret(ref);
  if (value === null) throw invalidState();
  return parseProviderTokenState(value);
}

function parseProviderTokenState(value: string): ProviderTokenStateV1 {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isClosedRecord(parsed, ["version", "active", "candidate", "retiring"])) {
      throw invalidState();
    }
    if (parsed.version !== PROVIDER_TOKEN_STATE_VERSION) throw invalidState();
    const active = normalizeProviderToken(parsed.active, invalidState);
    const candidate =
      parsed.candidate === undefined
        ? undefined
        : normalizeProviderToken(parsed.candidate, invalidState);
    const retiring =
      parsed.retiring === undefined
        ? undefined
        : normalizeProviderToken(parsed.retiring, invalidState);
    const ids = [active.id, candidate?.id, retiring?.id].filter(
      (id): id is string => id !== undefined
    );
    if (new Set(ids).size !== ids.length || (candidate !== undefined && retiring !== undefined)) {
      throw invalidState();
    }
    return {
      version: PROVIDER_TOKEN_STATE_VERSION,
      active,
      ...(candidate === undefined ? {} : { candidate }),
      ...(retiring === undefined ? {} : { retiring })
    };
  } catch {
    throw invalidState();
  }
}

function serializeProviderTokenState(state: ProviderTokenStateV1): string {
  return JSON.stringify(state);
}

function normalizeProviderToken(
  value: unknown,
  errorFactory: () => ProviderTokenRotationStateError
): ProviderTokenValue {
  try {
    if (!isClosedRecord(value, ["id", "value"])) throw errorFactory();
    const id = value.id;
    const token = value.value;
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id) ||
      typeof token !== "string" ||
      token.length === 0 ||
      // A bounded token keeps malformed OAuth responses from expanding the encrypted state and
      // Durable Object memory without imposing provider-specific token syntax.
      textEncoder.encode(token).byteLength > MAX_PROVIDER_TOKEN_BYTES
    ) {
      throw errorFactory();
    }
    return { id, value: token };
  } catch {
    throw errorFactory();
  }
}

function metadata(state: ProviderTokenStateV1): ProviderTokenRotationMetadata {
  return {
    activeTokenId: state.active.id,
    ...(state.candidate === undefined ? {} : { candidateTokenId: state.candidate.id }),
    ...(state.retiring === undefined ? {} : { retiringTokenId: state.retiring.id })
  };
}

function isClosedRecord(
  value: unknown,
  allowedKeys: readonly string[]
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}

function invalidState(): ProviderTokenRotationStateError {
  return new ProviderTokenRotationStateError(
    "provider_token_state_invalid",
    "provider token state is invalid"
  );
}

function invalidTransition(): ProviderTokenRotationStateError {
  return new ProviderTokenRotationStateError(
    "provider_token_transition_invalid",
    "provider token transition is invalid"
  );
}

function stateChanged(): ProviderTokenRotationStateError {
  return new ProviderTokenRotationStateError(
    "provider_token_state_changed",
    "provider token state changed concurrently"
  );
}
