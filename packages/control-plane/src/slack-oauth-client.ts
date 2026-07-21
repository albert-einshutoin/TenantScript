import type { SlackOAuthClient, SlackOAuthTokenResponse } from "./api.js";

const SLACK_OAUTH_ACCESS_URL = "https://slack.com/api/oauth.v2.access";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_ROTATING_CREDENTIAL_BYTES = 7_500;
const TRANSIENT_PROVIDER_ERRORS = new Set([
  "service_unavailable",
  "internal_error",
  "request_timeout",
  "ratelimited"
]);

export type SlackOAuthExchangeErrorCode =
  | "slack_oauth_invalid_configuration"
  | "slack_oauth_invalid_request"
  | "slack_oauth_exchange_rejected"
  | "slack_oauth_exchange_unavailable";

export class SlackOAuthExchangeError extends Error {
  override readonly name = "SlackOAuthExchangeError";

  constructor(readonly code: SlackOAuthExchangeErrorCode) {
    super(code);
  }

  toJSON(): { code: SlackOAuthExchangeErrorCode } {
    return { code: this.code };
  }
}

export interface SlackOAuthClientConfiguration {
  clientId: string;
  clientSecret: string;
  allowedRedirectUris: readonly string[];
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export function createSlackOAuthClient(
  configuration: SlackOAuthClientConfiguration
): SlackOAuthClient {
  validateConfiguration(configuration);
  const fetcher = configuration.fetcher ?? fetch;
  const allowedRedirectUris = new Set(configuration.allowedRedirectUris);
  const timeoutMs = configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    exchangeCode: async (request): Promise<SlackOAuthTokenResponse> => {
      if (!isExchangeRequest(request) || !allowedRedirectUris.has(request.redirectUri)) {
        throw new SlackOAuthExchangeError("slack_oauth_invalid_request");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      try {
        // The origin, path, method, and headers are deliberately not caller-controlled: this
        // boundary holds both the Slack client secret and a one-time authorization code.
        const response = await fetcher(SLACK_OAUTH_ACCESS_URL, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Authorization: `Basic ${btoa(`${configuration.clientId}:${configuration.clientSecret}`)}`,
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8"
          },
          body: new URLSearchParams({
            code: request.code,
            redirect_uri: request.redirectUri
          }).toString()
        });
        if (response.status !== 200 || response.redirected) throw unavailable();
        const value = await readBoundedJson(response);
        if (isRecord(value) && value.ok === false) {
          // Keep provider details private, but preserve whether an operator can retry the
          // installation later instead of presenting a transient Slack outage as user rejection.
          throw typeof value.error === "string" && TRANSIENT_PROVIDER_ERRORS.has(value.error)
            ? unavailable()
            : rejected();
        }
        return parseSuccess(value);
      } catch (error) {
        if (error instanceof SlackOAuthExchangeError) throw error;
        // OAuth authorization codes are one-shot. An ambiguous network failure must be surfaced
        // for an operator decision instead of replaying a code that Slack may already have used.
        throw unavailable();
      } finally {
        // The timer stays armed while the response stream is read so a server cannot send headers
        // and then hold a Worker isolate indefinitely with a stalled body.
        clearTimeout(timeout);
      }
    }
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("Content-Type")?.toLowerCase();
  if (contentType === undefined || !contentType.startsWith("application/json")) {
    throw unavailable();
  }
  const declaredLength = response.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    throw unavailable();
  }
  const body = (response as unknown as { body: ReadableStream<Uint8Array> | null }).body;
  if (body === null) throw unavailable();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw unavailable();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
    ) as unknown;
  } catch {
    throw unavailable();
  }
}

function parseSuccess(value: unknown): SlackOAuthTokenResponse {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "ok",
      "access_token",
      "token_type",
      "scope",
      "bot_user_id",
      "app_id",
      "expires_in",
      "refresh_token",
      "team",
      "enterprise",
      "authed_user",
      "is_enterprise_install"
    ]) ||
    value.ok !== true ||
    value.token_type !== "bot" ||
    !isBoundedText(value.access_token, MAX_ROTATING_CREDENTIAL_BYTES) ||
    !isBoundedText(value.scope, 4_096, true) ||
    !isBoundedText(value.app_id, 128) ||
    !isRotationCredentialPair(value) ||
    !isTeam(value.team) ||
    !isAuthedUser(value.authed_user) ||
    (value.bot_user_id !== undefined && !isBoundedText(value.bot_user_id, 128)) ||
    (value.enterprise !== undefined &&
      value.enterprise !== null &&
      !isEnterprise(value.enterprise)) ||
    (value.is_enterprise_install !== undefined &&
      typeof value.is_enterprise_install !== "boolean") ||
    // The connection record is workspace-scoped today. Accepting an org-wide token without
    // recording and enforcing that scope would silently weaken the tenant boundary.
    value.is_enterprise_install === true
  ) {
    throw unavailable();
  }
  return {
    accessToken: value.access_token,
    ...(value.refresh_token === undefined
      ? {}
      : { refreshToken: value.refresh_token, expiresIn: value.expires_in }),
    workspaceId: value.team.id,
    ...(value.team.name === undefined ? {} : { workspaceName: value.team.name }),
    ...(value.bot_user_id === undefined ? {} : { botUserId: value.bot_user_id })
  };
}

function isTeam(value: unknown): value is { id: string; name?: string } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "name"]) &&
    isBoundedText(value.id, 128) &&
    (value.name === undefined || isBoundedText(value.name, 512))
  );
}

function isEnterprise(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "name"]) &&
    isBoundedText(value.id, 128) &&
    (value.name === undefined || isBoundedText(value.name, 512))
  );
}

function isAuthedUser(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "scope", "access_token", "token_type"]) &&
    isBoundedText(value.id, 128) &&
    isBoundedText(value.scope, 4_096, true) &&
    (value.access_token === undefined || isBoundedText(value.access_token, 16_384)) &&
    (value.token_type === undefined || value.token_type === "user")
  );
}

function isRotationCredentialPair(
  value: Record<string, unknown>
): value is Record<string, unknown> & { refresh_token?: string; expires_in?: number } {
  if (value.refresh_token === undefined && value.expires_in === undefined) return true;
  return (
    isBoundedText(value.refresh_token, MAX_ROTATING_CREDENTIAL_BYTES) &&
    isBoundedInteger(value.expires_in, 1, 604_800)
  );
}

function isBoundedText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    new TextEncoder().encode(value).byteLength <= maximum
  );
}

function validateConfiguration(value: unknown): asserts value is SlackOAuthClientConfiguration {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "clientId",
      "clientSecret",
      "allowedRedirectUris",
      "fetcher",
      "timeoutMs"
    ]) ||
    !isClientId(value.clientId) ||
    !isClientSecret(value.clientSecret) ||
    !Array.isArray(value.allowedRedirectUris) ||
    value.allowedRedirectUris.length === 0 ||
    value.allowedRedirectUris.length > 16 ||
    !value.allowedRedirectUris.every(isCanonicalHttpsRedirect) ||
    new Set(value.allowedRedirectUris).size !== value.allowedRedirectUris.length ||
    (value.fetcher !== undefined && typeof value.fetcher !== "function") ||
    (value.timeoutMs !== undefined && !isBoundedInteger(value.timeoutMs, 1, 60_000))
  ) {
    throw new SlackOAuthExchangeError("slack_oauth_invalid_configuration");
  }
}

function isExchangeRequest(value: unknown): value is { code: string; redirectUri: string } {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["code", "redirectUri"]) &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    value.code.length <= 4_096 &&
    /^[\x21-\x7e]+$/u.test(value.code) &&
    isCanonicalHttpsRedirect(value.redirectUri)
  );
}

function isClientId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9._-]+$/u.test(value)
  );
}

function isClientSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    /^[\x21-\x7e]+$/u.test(value)
  );
}

function isCanonicalHttpsRedirect(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.length > 0 &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      url.toString() === value
    );
  } catch {
    return false;
  }
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function rejected(): SlackOAuthExchangeError {
  return new SlackOAuthExchangeError("slack_oauth_exchange_rejected");
}

function unavailable(): SlackOAuthExchangeError {
  return new SlackOAuthExchangeError("slack_oauth_exchange_unavailable");
}
