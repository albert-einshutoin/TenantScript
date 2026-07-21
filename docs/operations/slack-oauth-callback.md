# Slack OAuth callback composition

`GET /v1/provider-callbacks/slack` is the repository-verified public browser return boundary for a
Slack workspace installation. Its untrusted input is limited to one `state` value, Slack's temporary
authorization `code`, and the server-managed browser-binding cookie. The route invokes
`createSlackOAuthCallbackService` only after the HTTP boundary validates that closed input.

The callback is intentionally separate from authenticated Admin API routes. Slack returns through a
top-level redirect, so requests carrying an `Origin` header fail to the fixed failure destination
before state is consumed. The one-time state and browser binding restore the initiating app, tenant,
actor, and redirect URI without accepting ambient Admin authorization or caller-selected scope.

## Trusted sequencing

The service performs operations in this order:

1. reject unknown or malformed callback fields before Durable Object or provider access;
2. atomically consume state with the initiating browser binding;
3. restore the server-owned app, tenant, actor, and exact redirect URI;
4. call the existing `connectSlackWorkspace` boundary with only that restored scope;
5. let that boundary exchange the code once, write the token only to `SecretStore`, and persist only
   non-secret Slack connection metadata.

The provider code is never sent before state succeeds. This matters because Slack authorization codes
are short-lived and one-shot: consuming them for an invalid or cross-tenant callback would turn a CSRF
attempt into a denial of service and make the outcome ambiguous.

The callback input cannot provide app ID, tenant ID, actor, or redirect URI. Adding any such field is an
invalid request rather than an override. Concurrent calls using the same state allow at most one call to
reach the Slack exchange.

## Error and retry contract

The public error object contains only one stable code:

- `slack_oauth_callback_invalid_request`: malformed or extended callback input;
- `slack_oauth_callback_invalid_state`: unknown, expired, replayed, or browser-mismatched state;
- `slack_oauth_callback_rejected`: Slack explicitly rejected the one-shot exchange;
- `slack_oauth_callback_unavailable`: state storage, provider transport, tenant scope, encrypted secret
  storage, connection storage, or clock failure.

Codes, state values, browser bindings, provider responses, tokens, and internal storage errors are not
reflected. Do not automatically retry after state was consumed: the provider may already have accepted
the code. A new authenticated install-start flow must issue fresh state and obtain a fresh code.

## HTTP and Worker contract

The public route accepts only `GET`, an exact `state`/`code` query, a single exact binding cookie, no
`Origin` header, and browser fetch metadata for a top-level document navigation (`navigate` /
`document`). Query and cookie headers are bounded. This rejects both credentialed fetches and no-CORS
image/script subresources before state consumption. Every exact callback response deletes the binding
cookie and sends `no-store`, a deny-all CSP, `no-referrer`, and `nosniff` headers.

Success and all handled failures use `303` redirects to distinct, canonical HTTPS destinations fixed
in Worker configuration. Neither destination is derived from the callback. An unconfigured or partially
configured callback returns a stable secret-free `503` and still deletes the binding cookie.

Production Worker composition uses the state Durable Object, fixed-origin Slack client, encrypted
provider-secret Durable Object, and the D1 connection store selected by the app ID restored from state.
For sharded deployments, callback query input cannot choose the database. The restored app ID is also
part of the encrypted secret ref and its Durable Object shard, so two app databases may reuse the same
tenant and Slack workspace IDs without sharing or overwriting tokens.

| Name                               | Contract                                                              |
| ---------------------------------- | --------------------------------------------------------------------- |
| `SLACK_OAUTH_CLIENT_SECRET`        | Slack application secret. Provision only as a Worker secret.          |
| `SLACK_OAUTH_SUCCESS_REDIRECT_URI` | Fixed canonical HTTPS destination after a completed connection.       |
| `SLACK_OAUTH_FAILURE_REDIRECT_URI` | Distinct fixed canonical HTTPS destination for every handled failure. |

Enabling any callback-specific value requires all three plus `OAUTH_STATE_STORE_DO`,
`PROVIDER_SECRET_STORE_DO`, `PROVIDER_SECRET_KEYRING_JSON`, `SLACK_OAUTH_CLIENT_ID`, the exact
`SLACK_OAUTH_REDIRECT_URI`, `SLACK_OAUTH_SCOPES`, and either `DB` or `APP_DATABASE_ROUTES_JSON`. The
shipped Worker evaluates install-start and callback composition together, so callback activation also
requires the configured scope set even though the callback does not accept or modify it. Partial
configuration fails closed. The setup renderer does not yet emit provider-specific values, so operators
must review and provision them explicitly.

The Worker parses and imports the provider keyring before registering the callback handler. A malformed,
missing-current, or invalid-length key therefore fails with `503` before one-time state or Slack code is
consumed, allowing the operator to repair configuration and restart the same still-valid callback.

## Remaining production evidence

Credential-bearing Slack and Cloudflare Tier 2 evidence remains blocked on maintainer-owned accounts.
Accountless Worker tests are not proof of a deployed callback, browser cookie policy, or live installation.
Operators should prefer same-site Admin UI and Control Plane hosts because browsers that block all
cross-site cookies can still prevent the install-start binding from being returned.

Refresh-token persistence and refresh lifecycle remain separate. TenantScript continues to reject
organization-wide Enterprise Grid installs until enterprise authority is represented and enforced.

## Repository verification

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/control-plane exec vitest run test/slack-oauth-callback.test.ts
pnpm --filter @tenantscript/control-plane exec vitest run test/slack-oauth-callback-http.test.ts
pnpm --filter @tenantscript/control-plane exec vitest run --config vitest.workers.config.ts test/slack-oauth-callback-http.workers.test.ts
pnpm --filter @tenantscript/control-plane test:security
```

These tests cover closed and bounded HTTP input, state-first sequencing, server-owned scope, cookie
deletion, fixed redirects, database routing, encrypted token storage, replay, stable secret-free failures,
and provider rejection classification. They are accountless evidence and do not prove deployed-browser
cookie behavior or a live Slack installation.
