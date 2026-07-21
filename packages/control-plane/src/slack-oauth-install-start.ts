import type { OAuthStateStore } from "./oauth-state-store.js";

const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const BROWSER_BINDING_BYTES = 32;
const MIN_STATE_LIFETIME_MS = 60_000;
const MAX_STATE_LIFETIME_MS = 10 * 60 * 1_000;

export const SLACK_OAUTH_BROWSER_BINDING_COOKIE = "__Host-tenantscript-slack-oauth-binding";

export type SlackOAuthInstallStartErrorCode =
  | "slack_oauth_install_start_invalid_configuration"
  | "slack_oauth_install_start_invalid_request"
  | "slack_oauth_install_start_unavailable";

export class SlackOAuthInstallStartError extends Error {
  override readonly name = "SlackOAuthInstallStartError";

  constructor(readonly code: SlackOAuthInstallStartErrorCode) {
    super(code);
  }

  toJSON(): { code: SlackOAuthInstallStartErrorCode } {
    return { code: this.code };
  }
}

export interface SlackOAuthInstallStartService {
  start: (input: { appId: string; tenantId: string; actorSubject: string }) => Promise<{
    authorizationUrl: string;
    expiresAt: Date;
    browserBindingCookie: string;
  }>;
}

export function createSlackOAuthInstallStartService(options: {
  stateStore: OAuthStateStore;
  clientId: string;
  scopes: readonly string[];
  redirectUri: string;
  now?: () => Date;
  randomBytes?: (length: number) => Uint8Array;
}): SlackOAuthInstallStartService {
  const configuration = validateConfiguration(options);
  const now = options.now ?? (() => new Date());
  const randomBytes =
    options.randomBytes ?? ((length: number) => crypto.getRandomValues(new Uint8Array(length)));

  return {
    start: async (input) => {
      if (!isStartInput(input)) throw invalidRequest();
      try {
        const issueStartedAt = readNow(now);
        const browserBinding = createBrowserBinding(randomBytes);
        // Scope is issued only after trusted identity validation, and none of these authority
        // fields can come from the HTTP query or body. This prevents cross-tenant OAuth grants.
        const issued = await options.stateStore.issue({
          provider: "slack",
          appId: input.appId,
          tenantId: input.tenantId,
          actorSubject: input.actorSubject,
          browserBinding,
          redirectUri: configuration.redirectUri
        });
        const issueCompletedAt = readNow(now);
        const expiresAtMs = issued.expiresAt.getTime();
        const remainingLifetimeMs = expiresAtMs - issueCompletedAt.getTime();
        // The store chooses its expiry during the awaited issue call. Bracketing that call avoids
        // treating normal adapter/DO latency as TTL while still enforcing the 1-10 minute policy.
        if (
          !isState(issued.state) ||
          !Number.isSafeInteger(expiresAtMs) ||
          issueCompletedAt.getTime() < issueStartedAt.getTime() ||
          expiresAtMs < issueStartedAt.getTime() + MIN_STATE_LIFETIME_MS ||
          expiresAtMs > issueCompletedAt.getTime() + MAX_STATE_LIFETIME_MS ||
          remainingLifetimeMs < 1_000
        ) {
          throw unavailable();
        }
        const authorizationUrl = new URL(SLACK_AUTHORIZE_URL);
        authorizationUrl.searchParams.set("client_id", configuration.clientId);
        authorizationUrl.searchParams.set("scope", configuration.scopes.join(","));
        authorizationUrl.searchParams.set("redirect_uri", configuration.redirectUri);
        authorizationUrl.searchParams.set("state", issued.state);

        return {
          authorizationUrl: authorizationUrl.toString(),
          expiresAt: new Date(issued.expiresAt),
          // SameSite=Lax is intentional: the callback is a top-level cross-site navigation from
          // Slack, while Secure/HttpOnly/__Host- keep script and sibling-domain access closed.
          browserBindingCookie: serializeBrowserBindingCookie(
            browserBinding,
            issued.expiresAt,
            remainingLifetimeMs
          )
        };
      } catch (error) {
        if (
          error instanceof SlackOAuthInstallStartError &&
          error.code === "slack_oauth_install_start_invalid_request"
        ) {
          throw error;
        }
        throw unavailable();
      }
    }
  };
}

function validateConfiguration(options: {
  clientId: string;
  scopes: readonly string[];
  redirectUri: string;
}): { clientId: string; scopes: readonly string[]; redirectUri: string } {
  if (
    !isClientId(options.clientId) ||
    !Array.isArray(options.scopes) ||
    options.scopes.length === 0 ||
    options.scopes.length > 64 ||
    !options.scopes.every(isScope) ||
    new Set(options.scopes).size !== options.scopes.length ||
    !isCanonicalHttpsRedirect(options.redirectUri)
  ) {
    throw new SlackOAuthInstallStartError("slack_oauth_install_start_invalid_configuration");
  }
  return {
    clientId: options.clientId,
    scopes: [...options.scopes].sort(),
    redirectUri: options.redirectUri
  };
}

function isStartInput(value: unknown): value is {
  appId: string;
  tenantId: string;
  actorSubject: string;
} {
  return (
    isExactRecord(value, ["appId", "tenantId", "actorSubject"]) &&
    isBoundedOpaqueIdentityField(value.appId) &&
    isBoundedOpaqueIdentityField(value.tenantId) &&
    isBoundedOpaqueIdentityField(value.actorSubject)
  );
}

function isBoundedOpaqueIdentityField(value: unknown): value is string {
  // Identity providers own the subject syntax, so punctuation must remain opaque here. The
  // bounded length protects the state store without silently rewriting a trusted identifier.
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isClientId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(value)
  );
}

function isScope(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[a-z][a-z0-9._-]*(?::[a-z][a-z0-9._-]*)?$/u.test(value)
  );
}

function isCanonicalHttpsRedirect(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      url.toString() === value
    );
  } catch {
    return false;
  }
}

function createBrowserBinding(randomBytes: (length: number) => Uint8Array): string {
  const bytes = randomBytes(BROWSER_BINDING_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== BROWSER_BINDING_BYTES) {
    throw unavailable();
  }
  return encodeBase64Url(bytes);
}

function readNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) throw unavailable();
  return new Date(value);
}

function serializeBrowserBindingCookie(
  browserBinding: string,
  expiresAt: Date,
  lifetimeMs: number
): string {
  const maxAge = String(Math.floor(lifetimeMs / 1_000));
  return `${SLACK_OAUTH_BROWSER_BINDING_COOKIE}=${browserBinding}; Path=/; Max-Age=${maxAge}; Expires=${expiresAt.toUTCString()}; Secure; HttpOnly; SameSite=Lax`;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function isState(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function invalidRequest(): SlackOAuthInstallStartError {
  return new SlackOAuthInstallStartError("slack_oauth_install_start_invalid_request");
}

function unavailable(): SlackOAuthInstallStartError {
  return new SlackOAuthInstallStartError("slack_oauth_install_start_unavailable");
}
