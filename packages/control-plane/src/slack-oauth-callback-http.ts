import type { SlackOAuthCallbackService } from "./slack-oauth-callback.js";
import { SLACK_OAUTH_BROWSER_BINDING_COOKIE } from "./slack-oauth-install-start.js";

export const PROVIDER_CALLBACK_HTTP_ENDPOINT_CONTRACTS = [
  {
    id: "slackOAuthCallback",
    path: "/v1/provider-callbacks/slack",
    methods: ["GET"],
    isolation: "oauth-state-browser-binding"
  }
] as const;

export const SLACK_OAUTH_CALLBACK_PATH = PROVIDER_CALLBACK_HTTP_ENDPOINT_CONTRACTS[0].path;

const MAX_QUERY_BYTES = 8_192;
const MAX_COOKIE_HEADER_BYTES = 8_192;
const CLEAR_BROWSER_BINDING_COOKIE = `${SLACK_OAUTH_BROWSER_BINDING_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=None`;

export interface SlackOAuthCallbackHttpConfiguration {
  service: SlackOAuthCallbackService;
  successRedirectUri: string;
  failureRedirectUri: string;
}

export type SlackOAuthCallbackHttpHandler = (request: Request, url: URL) => Promise<Response>;

export function createSlackOAuthCallbackHttpHandler(
  configuration: SlackOAuthCallbackHttpConfiguration
): SlackOAuthCallbackHttpHandler {
  validateConfiguration(configuration);

  return async (request, url) => {
    if (request.method !== "GET") {
      return callbackResponse(405, { Allow: "GET" });
    }
    // Slack returns through a top-level redirect, which has no Origin header. Rejecting Origin
    // requests keeps credentialed cross-site fetches from consuming a stolen state as a subresource.
    if (request.headers.get("Origin") !== null) {
      return redirectResponse(configuration.failureRedirectUri);
    }
    const input = parseCallbackInput(request, url);
    if (input === null) return redirectResponse(configuration.failureRedirectUri);
    try {
      await configuration.service.complete(input);
      return redirectResponse(configuration.successRedirectUri);
    } catch {
      // Provider, state, tenant, storage, and transport errors can contain secrets. Browser
      // callers receive one fixed destination so neither headers nor URL disclose a classification.
      return redirectResponse(configuration.failureRedirectUri);
    }
  };
}

export function slackOAuthCallbackUnavailableResponse(): Response {
  return Response.json(
    {
      error: {
        code: "slack_oauth_callback_unavailable",
        message: "Slack OAuth callback unavailable"
      }
    },
    {
      status: 503,
      headers: callbackHeaders()
    }
  );
}

function parseCallbackInput(
  request: Request,
  url: URL
): { state: string; browserBinding: string; code: string } | null {
  if (
    url.hash !== "" ||
    new TextEncoder().encode(url.search).byteLength > MAX_QUERY_BYTES ||
    !hasExactSingleQueryValues(url.searchParams, ["state", "code"])
  ) {
    return null;
  }
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const browserBinding = readBrowserBinding(request.headers.get("Cookie"));
  return isState(state) && isCode(code) && browserBinding !== null
    ? { state, browserBinding, code }
    : null;
}

function hasExactSingleQueryValues(params: URLSearchParams, keys: readonly string[]): boolean {
  const actual = [...params.keys()];
  return (
    actual.length === keys.length &&
    keys.every((key) => params.getAll(key).length === 1) &&
    actual.every((key) => keys.includes(key))
  );
}

function readBrowserBinding(cookieHeader: string | null): string | null {
  if (
    cookieHeader === null ||
    new TextEncoder().encode(cookieHeader).byteLength > MAX_COOKIE_HEADER_BYTES
  ) {
    return null;
  }
  const matches: string[] = [];
  for (const segment of cookieHeader.split(";")) {
    const item = segment.trim();
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    if (item.slice(0, separator) === SLACK_OAUTH_BROWSER_BINDING_COOKIE) {
      matches.push(item.slice(separator + 1));
    }
  }
  return matches.length === 1 && /^[A-Za-z0-9_-]{43}$/u.test(matches[0] as string)
    ? (matches[0] as string)
    : null;
}

function isState(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function isCode(value: string | null): value is string {
  return (
    value !== null && value.length > 0 && value.length <= 4_096 && /^[\x21-\x7e]+$/u.test(value)
  );
}

function redirectResponse(location: string): Response {
  return callbackResponse(303, { Location: location });
}

function callbackResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status,
    headers: {
      ...callbackHeaders(),
      ...headers
    }
  });
}

function callbackHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'",
    "Referrer-Policy": "no-referrer",
    "Set-Cookie": CLEAR_BROWSER_BINDING_COOKIE,
    "X-Content-Type-Options": "nosniff"
  };
}

function validateConfiguration(configuration: SlackOAuthCallbackHttpConfiguration): void {
  if (
    typeof configuration.service.complete !== "function" ||
    !isCanonicalHttpsUri(configuration.successRedirectUri) ||
    !isCanonicalHttpsUri(configuration.failureRedirectUri) ||
    configuration.successRedirectUri === configuration.failureRedirectUri
  ) {
    throw new Error("invalid Slack OAuth callback HTTP configuration");
  }
}

function isCanonicalHttpsUri(value: unknown): value is string {
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
