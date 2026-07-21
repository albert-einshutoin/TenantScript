import type { ConnectSlackWorkspaceRequest } from "./api.js";
import { OAuthStateStoreError, type OAuthStateStore } from "./oauth-state-store.js";
import type { SlackConnectionRecord } from "./slack-connection-store.js";
import { SlackOAuthExchangeError } from "./slack-oauth-client.js";

export type SlackOAuthCallbackErrorCode =
  | "slack_oauth_callback_invalid_request"
  | "slack_oauth_callback_invalid_state"
  | "slack_oauth_callback_rejected"
  | "slack_oauth_callback_unavailable";

export class SlackOAuthCallbackError extends Error {
  override readonly name = "SlackOAuthCallbackError";

  constructor(readonly code: SlackOAuthCallbackErrorCode) {
    super(code);
  }

  toJSON(): { code: SlackOAuthCallbackErrorCode } {
    return { code: this.code };
  }
}

export interface SlackOAuthCallbackService {
  complete: (input: {
    state: string;
    browserBinding: string;
    code: string;
  }) => Promise<SlackConnectionRecord>;
}

export function createSlackOAuthCallbackService(options: {
  stateStore: OAuthStateStore;
  connectSlackWorkspace: (
    request: ConnectSlackWorkspaceRequest
  ) => Promise<SlackConnectionRecord> | SlackConnectionRecord;
  now?: () => Date;
}): SlackOAuthCallbackService {
  const now = options.now ?? (() => new Date());

  return {
    complete: async (input) => {
      if (!isCallbackInput(input)) throw invalidRequest();
      const connectedAt = readNow(now);
      let binding;
      try {
        // Consume state before touching the one-shot provider code. This restores the trusted
        // tenant/app/redirect binding and ensures concurrent callbacks cannot both reach Slack.
        binding = await options.stateStore.consume({
          state: input.state,
          browserBinding: input.browserBinding
        });
      } catch (error) {
        if (error instanceof OAuthStateStoreError && error.code === "oauth_state_invalid") {
          throw invalidState();
        }
        throw unavailable();
      }
      try {
        // Caller-controlled scope is deliberately absent: only the server-owned state record can
        // select the tenant, app, and exact redirect URI used by exchange and encrypted storage.
        return await options.connectSlackWorkspace({
          appId: binding.appId,
          tenantId: binding.tenantId,
          code: input.code,
          redirectUri: binding.redirectUri,
          connectedAt
        });
      } catch (error) {
        if (
          error instanceof SlackOAuthExchangeError &&
          error.code === "slack_oauth_exchange_rejected"
        ) {
          throw rejected();
        }
        throw unavailable();
      }
    }
  };
}

function isCallbackInput(value: unknown): value is {
  state: string;
  browserBinding: string;
  code: string;
} {
  return (
    isExactRecord(value, ["state", "browserBinding", "code"]) &&
    typeof value.state === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(value.state) &&
    typeof value.browserBinding === "string" &&
    /^[A-Za-z0-9_-]{32,512}$/u.test(value.browserBinding) &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    value.code.length <= 4_096 &&
    /^[\x21-\x7e]+$/u.test(value.code)
  );
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function readNow(now: () => Date): Date {
  try {
    const value = now();
    if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) throw unavailable();
    return new Date(value);
  } catch {
    throw unavailable();
  }
}

function invalidRequest(): SlackOAuthCallbackError {
  return new SlackOAuthCallbackError("slack_oauth_callback_invalid_request");
}

function invalidState(): SlackOAuthCallbackError {
  return new SlackOAuthCallbackError("slack_oauth_callback_invalid_state");
}

function rejected(): SlackOAuthCallbackError {
  return new SlackOAuthCallbackError("slack_oauth_callback_rejected");
}

function unavailable(): SlackOAuthCallbackError {
  return new SlackOAuthCallbackError("slack_oauth_callback_unavailable");
}
