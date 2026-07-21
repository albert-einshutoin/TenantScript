# Slack OAuth callback composition

`createSlackOAuthCallbackService` is the repository-verified orchestration boundary between the
one-time OAuth state store and the existing Slack connection flow. Its untrusted input is limited to
`state`, the server-managed browser binding, and Slack's temporary authorization `code`.

This service is not an HTTP route and does not issue a browser session or cookie. It is the safe core
that a future management callback must call after reading those values from the request and its
authenticated session.

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

## Remaining production boundary

Before exposing this service to a browser, implement a reviewed management HTTP flow that provides:

- an authenticated install-start endpoint deriving app, tenant, actor, and redirect server-side;
- a high-entropy `Secure`, `HttpOnly`, `SameSite=Lax` or stricter browser-session binding;
- a bounded callback parser and stable success/failure redirect without query reflection;
- Worker composition of the state, Slack client, encrypted provider-secret DO, and D1 connection store;
- credential-bearing Slack and Cloudflare Tier 2 evidence.

Refresh-token persistence and refresh lifecycle remain separate. TenantScript continues to reject
organization-wide Enterprise Grid installs until enterprise authority is represented and enforced.

## Repository verification

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/control-plane exec vitest run test/slack-oauth-callback.test.ts
pnpm --filter @tenantscript/control-plane test:security
```

These tests cover closed input, state-first sequencing, server-owned scope, concurrent replay, stable
secret-free failures, and provider rejection classification. They are accountless evidence and do not
prove cookie behavior, a deployed callback, or a live Slack installation.
