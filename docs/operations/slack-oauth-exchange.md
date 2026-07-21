# Slack OAuth v2 exchange boundary

`createSlackOAuthClient` is the repository-verified HTTP boundary for exchanging a Slack OAuth v2
authorization code. It implements the existing Control Plane `SlackOAuthClient` contract and returns
only the bot access token plus workspace metadata needed by `connectSlackWorkspace`.

This client does not itself expose a callback route or claim a live Slack installation. TenantScript
provides a separate repository-verified [OAuth state store](oauth-state-store.md), authenticated
[install-start route](slack-oauth-install-start.md), and [callback HTTP composition](slack-oauth-callback.md).
The Worker composes those boundaries with encrypted token storage and D1 metadata persistence. Keeping
the contracts separate prevents accountless repository tests from being mistaken for live OAuth evidence.

## Fixed request contract

The client always sends exactly one `POST` to `https://slack.com/api/oauth.v2.access` with redirects
disabled. Slack recommends HTTP Basic authentication for the client ID and client secret; therefore the
form body contains only `code` and `redirect_uri`. The caller cannot replace the origin, path, method,
headers, or retry policy.

`allowedRedirectUris` is an exact allowlist. Each entry must be canonical HTTPS without userinfo or a
fragment, and the request value must match one entry byte-for-byte. Prefixes, wildcard hosts, implicit
subdomains, and caller-selected localhost exceptions are not supported.

Slack documents that the redirect URI used in the access step must match the value used in the authorize
step, and that the temporary code expires quickly. See the official
[`oauth.v2.access` reference](https://docs.slack.dev/reference/methods/oauth.v2.access/) and
[`Installing with OAuth`](https://docs.slack.dev/authentication/installing-with-oauth/).

## Response and failure contract

The response is read as a bounded stream with a 64 KiB ceiling. The timeout remains active through body
completion. A redirect, non-200 response, wrong content type, malformed or oversized JSON, unknown success
field, non-bot token, or missing workspace fails closed.

Enterprise Grid organization-wide installations (`is_enterprise_install: true`) also fail closed. The
current connection record and secret reference are workspace-scoped; accepting an organization-wide token
before enterprise scope is recorded and enforced would make that authority ambiguous.

The returned projection contains only:

- `accessToken`
- `workspaceId`
- optional `workspaceName`
- optional `botUserId`

Token-rotation responses are rejected until refresh credentials have an encrypted persistence and refresh
state machine; accepting the expiring access token while discarding its refresh token would create a
delayed outage. Provider errors, client credentials, authorization codes, access tokens, refresh tokens,
response bodies, and redirect URIs are never placed in the public error object. Stable codes distinguish
invalid configuration, invalid requests, provider rejection, and unavailable or malformed provider
responses. Documented transient Slack method errors (`service_unavailable`, `internal_error`,
`request_timeout`, and `ratelimited`) map to unavailable without exposing the raw provider error, so an
operator can distinguish a retry-later condition from a denied or invalid installation.

The client never retries. A timeout or connection loss after Slack accepted the code has an ambiguous
outcome; replaying the one-time code would hide that state and cannot safely prove whether an installation
was created.

## Production HTTP composition and remaining scope

The production callback composition now provides:

1. the same authenticated browser binding on issue and consume, followed by explicit cookie deletion;
2. `createSlackOAuthCallbackService` for app-, tenant-, actor-, redirect-, and expiry-bound one-time
   consume before this exchange client;
3. Slack client credentials supplied through platform secret bindings;
4. `createDurableObjectNamespaceSecretStore` for encrypted token persistence;
5. tenant-scoped connection metadata persistence selected by server-restored app authority.

Encrypted refresh-token persistence and an expiry-aware refresh state machine are still required before
enabling Slack token rotation. Enterprise-scope connection modeling must precede organization-wide installs,
and live Slack evidence remains in the credential-bearing Tier 2 lane.

Do not call `exchangeCode` directly from an unauthenticated callback, browser bundle, plugin, or capability
input. Never pass its raw token result to logs, diagnostics, audit fields, issues, or pull requests.

## Repository verification

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/control-plane exec vitest run test/slack-oauth-client.test.ts
pnpm --filter @tenantscript/control-plane test:security
pnpm test:security
```

These commands verify fixed-origin request construction, exact redirect matching, complete documented
success fixtures, fail-closed token-rotation responses, response bounds, timeout behavior, non-retry, and
secret-free errors. They also verify enterprise-wide install rejection and transient provider-error
classification. The separate state-store suite verifies OAuth state; these client tests do not contact
Slack and neither suite is live provider evidence.
