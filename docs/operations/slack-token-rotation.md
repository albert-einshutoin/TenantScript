# Slack bot token rotation

TenantScript accepts Slack bot OAuth responses containing both `refresh_token` and `expires_in` and
stores the access token, single-use refresh token, absolute expiry, generation, and a non-secret token
ID together in one encrypted provider-secret record. A partial pair, user-token rotation fields,
Enterprise Grid installation, unknown response field, or invalid bound fails closed.

This is repository-verified accountless behavior. It does not prove that token rotation is enabled for
a maintainer-owned Slack app or that a production Cloudflare deployment has refreshed a live token.

## State and refresh contract

The public lifecycle inspection exposes only `status`, `generation`, `tokenId`, and `expiresAt`:

- `ready`: the access token may be resolved while it is unexpired;
- `refreshing`: one writer has consumed the refresh opportunity; the still-unexpired old access token
  remains usable until the replacement is durably committed;
- `intervention_required`: token resolution and further automatic refresh are denied.

Refresh starts in a deterministic window before expiry. A bounded, stable app/tenant/workspace jitter
spreads provider traffic without making tests or operator reasoning nondeterministic. The encrypted
record is changed from `ready` to `refreshing` with CAS before contacting Slack. Concurrent requests or
alarm replays that lose that CAS do not call Slack.

The transport makes exactly one fixed-origin request with HTTP Basic client authentication and
`grant_type=refresh_token`. It follows no redirect and performs no automatic retry. Only a validated new
access/refresh pair is written as the next generation. TenantScript does not call `auth.revoke` for the
old access token: Slack permits overlap and limits the number of active tokens, so repeated early refresh
and eager revocation would create an avoidable outage.

## Failure and recovery

Treat `intervention_required` as a reconnect decision, not as a retry signal. A timeout, connection loss,
5xx, 429, malformed response, stale in-flight attempt, or local persistence failure after Slack may have
accepted the refresh is ambiguous. Reusing the old refresh token can consume Slack's short grace period
twice and lose the only known successor.

Recovery procedure:

1. record only app/tenant/workspace scope, `status`, `generation`, `tokenId`, and `expiresAt`; never copy a
   token, provider response, client secret, or encrypted envelope into an issue or log;
2. verify the provider-secret Durable Object and keyring bindings without reading plaintext values;
3. do not edit the encrypted record, decrement its generation, replay an alarm, or restore an older
   refresh token;
4. start a new authenticated Slack install flow and reconnect the workspace;
5. verify that D1 points to the expected app-scoped `SecretRef`, the new lifecycle is `ready`, and a
   trusted adapter can resolve an unexpired access token;
6. investigate any orphan encrypted record only after the D1 connection result is known. A secret write
   followed by a D1 failure is not a distributed transaction; reconnect overwrites the scoped credential,
   while deletion requires a separately reviewed cleanup operation.

There is no token-state rollback after a provider refresh. The prior refresh token may already be spent,
and the new refresh token may be unknown after a crash gap. Rollback means reconnecting through OAuth,
not restoring an earlier encrypted payload.

## Capability boundary

`createSlackCredentialLifecycleManager(...).resolveAccessToken()` is for a trusted server-side adapter.
It returns only the current access token and only while the state is `ready` or an in-flight refresh still
has an unexpired prior token. Expired, malformed, and intervention-required states return stable,
secret-free errors. Do not expose this resolver to browser, plugin, audit, telemetry, or Admin API input.

## Repository verification

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/control-plane exec vitest run test/slack-token-refresh-client.test.ts
pnpm --filter @tenantscript/control-plane exec vitest run test/slack-credential-lifecycle.test.ts
pnpm --filter @tenantscript/control-plane exec vitest run --config vitest.workers.config.ts test/slack-credential-lifecycle.workers.test.ts
pnpm --filter @tenantscript/control-plane test:security
```

These tests cover fixed transport, no-retry failures, expiry, encrypted CAS, concurrent requests,
capability resolution, persistence failure, and plaintext scans. They use synthetic credentials only.
