const SLACK_OAUTH_ACCESS_URL = "https://slack.com/api/oauth.v2.access";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_CREDENTIAL_BYTES = 7_500;

export interface SlackTokenRefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface SlackTokenRefreshClient {
  refresh: (refreshToken: string) => Promise<SlackTokenRefreshResult>;
}

export type SlackTokenRefreshErrorCode =
  | "slack_token_refresh_invalid_configuration"
  | "slack_token_refresh_invalid_request"
  | "slack_token_refresh_intervention_required";

export class SlackTokenRefreshError extends Error {
  override readonly name = "SlackTokenRefreshError";

  constructor(readonly code: SlackTokenRefreshErrorCode) {
    super(code);
  }

  toJSON(): { code: SlackTokenRefreshErrorCode } {
    return { code: this.code };
  }
}

export function createSlackTokenRefreshClient(configuration: {
  clientId: string;
  clientSecret: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): SlackTokenRefreshClient {
  validateConfiguration(configuration);
  const fetcher = configuration.fetcher ?? fetch;
  const timeoutMs = configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    refresh: async (refreshToken) => {
      if (!isBoundedText(refreshToken, MAX_CREDENTIAL_BYTES)) {
        throw new SlackTokenRefreshError("slack_token_refresh_invalid_request");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      try {
        // A refresh token is single-use. Keep every transport choice server-owned and make only
        // one request; any ambiguous outcome is handed to an operator instead of being replayed.
        const response = await fetcher(SLACK_OAUTH_ACCESS_URL, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Authorization: `Basic ${btoa(`${configuration.clientId}:${configuration.clientSecret}`)}`,
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8"
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken
          }).toString()
        });
        if (response.status !== 200 || response.redirected) throw interventionRequired();
        return parseSuccess(await readBoundedJson(response));
      } catch (error) {
        if (error instanceof SlackTokenRefreshError) throw error;
        throw interventionRequired();
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}

function parseSuccess(value: unknown): SlackTokenRefreshResult {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "ok",
      "access_token",
      "token_type",
      "scope",
      "expires_in",
      "refresh_token"
    ]) ||
    value.ok !== true ||
    value.token_type !== "bot" ||
    !isBoundedText(value.access_token, MAX_CREDENTIAL_BYTES) ||
    !isBoundedText(value.refresh_token, MAX_CREDENTIAL_BYTES) ||
    !isBoundedInteger(value.expires_in, 1, 604_800) ||
    (value.scope !== undefined && !isBoundedText(value.scope, 4_096, true))
  ) {
    throw interventionRequired();
  }
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresIn: value.expires_in
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("Content-Type")?.toLowerCase();
  if (contentType === undefined || !contentType.startsWith("application/json")) {
    throw interventionRequired();
  }
  const declaredLength = response.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    throw interventionRequired();
  }
  const body = (response as unknown as { body: ReadableStream<Uint8Array> | null }).body;
  if (body === null) throw interventionRequired();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw interventionRequired();
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
    throw interventionRequired();
  }
}

function validateConfiguration(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["clientId", "clientSecret", "fetcher", "timeoutMs"]) ||
    !isBoundedText(value.clientId, 512) ||
    value.clientId.includes(":") ||
    !isAscii(value.clientId) ||
    !isBoundedText(value.clientSecret, 4_096) ||
    !isAscii(value.clientSecret) ||
    (value.fetcher !== undefined && typeof value.fetcher !== "function") ||
    (value.timeoutMs !== undefined && !isBoundedInteger(value.timeoutMs, 1, 60_000))
  ) {
    throw new SlackTokenRefreshError("slack_token_refresh_invalid_configuration");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    new TextEncoder().encode(value).byteLength <= maximum
  );
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function isAscii(value: string): boolean {
  return /^[\x20-\x7e]+$/u.test(value);
}

function interventionRequired(): SlackTokenRefreshError {
  return new SlackTokenRefreshError("slack_token_refresh_intervention_required");
}
