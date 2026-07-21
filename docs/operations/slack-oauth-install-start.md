# Slack OAuth install-start

`POST /v1/admin/provider-connections/slack/oauth/start` is the repository-verified browser entrypoint
for a Slack workspace installation. It authenticates the tenant-scoped administrator before issuing
one-time state, derives every authority-bearing value server-side, and returns a fixed-origin Slack
authorization URL together with a hardened browser-binding cookie.

## Authentication and request contract

The endpoint requires an exact Bearer identity with app, tenant, and subject claims plus the
`provider-connection:manage` operation. `owner`, `admin`, the compatibility `manager`, and
`tenant-admin` may start the flow; `operator` and `viewer` may not. A narrower service token must
explicitly include the operation even when its role would otherwise allow it.

After authentication, RBAC, and closed-input validation, state issuance reserves the
`provider-oauth-start` Admin mutation budget for the authenticated app, tenant, and actor. Missing
or unavailable rate-limit protection fails closed before state allocation.

The request is `POST` with no query string and no body. App ID, tenant ID, actor, redirect URI,
client ID, scopes, state, and browser binding are never accepted from the caller. Unknown query or
body input returns `slack_oauth_install_start_invalid_request` before state storage.

The successful `201` JSON body contains only:

```json
{
  "authorizationUrl": "https://slack.com/oauth/v2/authorize?...",
  "expiresAt": "2026-07-21T01:05:00.000Z"
}
```

The origin and path are fixed to `https://slack.com/oauth/v2/authorize`. `client_id`, sorted
least-privilege bot scopes, exact HTTPS `redirect_uri`, and one-time `state` come only from trusted
Worker configuration and the state store. Slack requires the authorize and exchange redirect URI
values to match when a redirect is supplied; see [Installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth/).

## Browser binding cookie

Every start rotates a fresh 256-bit browser binding. The value is sent only in the
`__Host-tenantscript-slack-oauth-binding` cookie:

```text
Path=/; Max-Age=<state lifetime>; Expires=<state expiry>; Secure; HttpOnly; SameSite=None
```

There is no `Domain` attribute, and neither the JSON body nor authorization URL contains the
binding. `SameSite=None` is required because an allowlisted Admin UI may start the flow through a
cross-site CORS subresource request; `Lax` cookies are not reliably created by that response. The
`__Host-` prefix requires `Secure`, root path, and no domain, limiting sibling-host confusion. The
one-time state and browser-binding digest remain the CSRF boundary. These attributes follow the
cookie security model in [RFC 6265](https://datatracker.ietf.org/doc/html/rfc6265).

For a cross-origin Admin UI, call the endpoint with browser credentials enabled so the browser may
accept `Set-Cookie`. The Worker returns `Access-Control-Allow-Credentials: true` only after matching
the exact configured origin; wildcard origins remain forbidden. Browser policies that block all
cross-site cookies can still prevent this flow, so operators should prefer same-site Admin UI and
Control Plane hosts when possible. Starting another flow in the same browser intentionally rotates
the single binding, so an older outstanding callback becomes invalid.

## Worker configuration

All four values are required together. A partial or invalid configuration fails closed without
issuing state or a cookie.

| Name                       | Contract                                                                 |
| -------------------------- | ------------------------------------------------------------------------ |
| `OAUTH_STATE_STORE_DO`     | Sharded SQLite Durable Object binding owned by the Control Plane Worker. |
| `SLACK_OAUTH_CLIENT_ID`    | Slack application client ID; non-secret bounded ASCII value.             |
| `SLACK_OAUTH_SCOPES`       | Comma-separated, unique least-privilege bot scopes without whitespace.   |
| `SLACK_OAUTH_REDIRECT_URI` | Canonical HTTPS callback URL without credentials or fragment.            |

Do not place the Slack client secret in these variables. Code exchange and encrypted token storage
use separate server-only boundaries.

## Failure and callback handoff

Endpoint-specific errors are limited to `slack_oauth_install_start_invalid_request`,
`slack_oauth_install_start_forbidden`, and `slack_oauth_install_start_unavailable`. State, cookie,
Bearer token, tenant data, configuration values, and Durable Object errors are never reflected.
Shared authentication, origin, and Admin mutation rate-limit errors retain their documented Control
Plane codes.

The repository-verified [callback route](slack-oauth-callback.md) parses the bounded `GET`, reads and
clears this exact cookie, invokes `createSlackOAuthCallbackService`, and redirects only to fixed
success/failure destinations. Slack client-secret and provider-KEK provisioning remain operator-owned
secret steps. Refresh-token lifecycle and credentialed Slack/Cloudflare evidence remain incomplete.

## Repository verification

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/control-plane exec vitest run test/slack-oauth-install-start.test.ts test/slack-oauth-install-start-http.test.ts
pnpm --filter @tenantscript/control-plane exec vitest run --config vitest.workers.config.ts test/slack-oauth-install-start.workers.test.ts
pnpm --filter @tenantscript/control-plane test:security
```

The workerd test uses the production Worker entrypoint and real OAuth state Durable Object, then
consumes state with the returned cookie binding exactly once. It is accountless evidence and does
not prove a deployed browser or live Slack installation.
