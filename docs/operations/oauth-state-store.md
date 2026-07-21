# OAuth state store

`createDurableObjectNamespaceOAuthStateStore` is the repository-verified CSRF state boundary for a
future provider OAuth callback. It issues a 256-bit opaque value, stores only digests, and atomically
restores the server-owned provider, app, tenant, actor, redirect URI, issue time, and expiry binding
exactly once.

This is not an HTTP callback. The repository-verified [Slack install-start](slack-oauth-install-start.md)
authenticates the initiating administrator, creates the fixed-origin authorization URL, and supplies
the server-managed browser binding. The [Slack callback composition service](slack-oauth-callback.md)
consumes state before provider access and uses only its returned scope.

## State and browser binding contract

The public state value is 32 random bytes encoded as 43 unpadded base64url characters. It contains no
tenant ID, actor ID, redirect URI, timestamp, JSON, or signature metadata. The browser binding must be a
server-managed, high-entropy session value of 32 through 512 base64url characters. Do not use an email,
user ID, tenant ID, short cookie, or browser-supplied arbitrary string as that binding.

The Durable Object protocol receives SHA-256 digests of both values. State records contain only:

- the browser-binding digest;
- provider (`slack` in the current closed contract);
- app, tenant, and actor identifiers;
- one canonical HTTPS redirect URI;
- server issue and expiry timestamps.

The state digest prefix selects one of 256 SQLite Durable Object shards. This lets a callback locate the
record without accepting a tenant ID as pre-validation authority and avoids putting every deployment flow
through one global object.

## One-time and expiry behavior

The default lifetime is five minutes. A deployment may configure 60 seconds through ten minutes in the
trusted factory options; the Durable Object independently rejects timestamps outside that range or more
than five seconds from its own clock.

Successful consume deletes the record in the same storage transaction that reads it. Concurrent consumers
therefore produce one success at most. Unknown, expired, already consumed, and browser-mismatched values
all return the same non-reflective `oauth_state_invalid` error. A browser mismatch does not delete the
record, because an attacker who learned only the state must not be able to invalidate the legitimate
browser's flow.

Each shard keeps its earliest expiry in a Durable Object alarm. The alarm removes expired valid records and
schedules the next expiry. Alarms are cleanup only; consume checks expiry against the server clock even if
an alarm is delayed. Cloudflare alarms are at-least-once, so cleanup is deliberately idempotent. See the
[Cloudflare alarm contract](https://developers.cloudflare.com/durable-objects/api/alarms/).

## Protocol and error boundary

The internal namespace adapter sends only exact-schema JSON `POST` requests to fixed internal paths. Bodies
are limited to 16 KiB, UTF-8 decoding is fatal, responses are `no-store`, and provider/session/state values
are never reflected by errors. Stable public codes are:

- `oauth_state_invalid_configuration`: invalid trusted TTL configuration;
- `oauth_state_invalid_request`: malformed issue or consume input;
- `oauth_state_invalid`: unknown, expired, mismatched, or already consumed state;
- `oauth_state_store_unavailable`: storage, protocol, or platform failure.

Slack requires a returned state value to match the value sent at authorization, and OAuth Security BCP
requires one-time CSRF tokens bound to the user agent when another equivalent defense is unavailable. See
[Slack Installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth/), the Slack
[`StateStore` contract](https://docs.slack.dev/tools/node-slack-sdk/reference/oauth/interfaces/StateStore/),
and [RFC 9700](https://datatracker.ietf.org/doc/html/rfc9700).

## Production composition still required

The install-start route now completes the first two items. Before completing the OAuth browser flow,
add all of the following in a separate reviewed slice:

1. an HTTP callback that invokes `createSlackOAuthCallbackService` and compares returned authority to the
   authenticated session;
2. explicit callback deletion of the `Secure`, `HttpOnly`, `SameSite=Lax` binding cookie;
3. Worker composition of the fixed-origin Slack exchange client and encrypted provider secret store;
4. stable user-facing callback responses without code, state, token, or provider-error reflection;
5. live credential-bearing Tier 2 evidence.

Do not disable state verification for Enterprise Grid. TenantScript currently also rejects organization-wide
Slack installs until enterprise scope is modeled and enforced.

## Repository verification

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/control-plane exec vitest run test/oauth-state-store.test.ts
pnpm --filter @tenantscript/control-plane exec vitest run --config vitest.workers.config.ts test/oauth-state-store.workers.test.ts
pnpm --filter @tenantscript/control-plane test:security
```

These tests cover digest-only persistence, exact binding restoration, one-time and concurrent consume,
expiry, alarms, malformed protocol input, and secret-free errors. They are accountless evidence and do not
prove browser cookie behavior, a deployed callback, or a real Slack installation.
