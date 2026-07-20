# Cloudflare API transport boundary

TenantScript's CLI exposes an account-scoped JSON transport for future live setup adapters. The
transport is intentionally narrower than a general Cloudflare client: callers provide validated
path segments, not a URL, and every request is rooted at
`https://api.cloudflare.com/client/v4/accounts/<account-id>/`.

This transport does not provision resources by itself. The ownership-aware
[D1 setup adapter](cloudflare-d1-setup-adapter.md) and
[R2 setup adapter](cloudflare-r2-setup-adapter.md) implement ownership-aware resource slices, while
the [D1 migration adapter](cloudflare-d1-migrations.md) pins resumable schema history. Workers,
Workflows, Analytics Engine, live composition, and Tier 2 verification remain before `ext setup` can
claim a successful deployment.

## Credential and permission boundary

Use a scoped API token; do not use a Global API key. Supply the token at runtime through an
operator-controlled secret mechanism. Never place it in setup plans, journals, Wrangler variables,
issues, or CI logs. The transport sends it only as `Authorization: Bearer <token>` and discards
Cloudflare `errors` and `messages` instead of reflecting provider text into diagnostics.

Grant only permissions required by the selected adapter. Current Cloudflare references identify:

| Adapter action               | Official endpoint reference                                                                                                             | Required permission shown by Cloudflare |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Create D1 database           | [Create D1 database](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/)                          | `D1 Write`                              |
| Read D1 migration history    | [Query D1 database](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)                            | `D1 Read` or `D1 Write`                 |
| Create R2 bucket             | [Create R2 bucket](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/)                             | `Workers R2 Storage Write`              |
| Delete R2 bucket             | [Delete R2 bucket](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/delete/)                             | `Workers R2 Storage Write`              |
| Upload Worker script content | [Put script content](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/update/) | `Workers Scripts Write`                 |

Treat that table as a reference starting point, not a request to grant every permission. Each live
adapter must document and test its exact least-privilege token before it is enabled.

## Retry and idempotency contract

The transport retries only `GET`, with at most three total attempts by default:

- network errors and `5xx` use bounded exponential delays;
- `429` is retried only when `Retry-After` is an integer number of seconds within the configured
  10-second ceiling;
- invalid, missing, or excessive `Retry-After` fails immediately as `cloudflare_api_rate_limited`;
- `POST`, `PUT`, `PATCH`, and `DELETE` are attempted exactly once.

Cloudflare documents `retry-after` as seconds until capacity is available and publishes global API
limits in its [rate-limit reference](https://developers.cloudflare.com/fundamentals/api/reference/limits/).
The current D1 create reference does not document an idempotency key or an exactly-once guarantee.
TenantScript therefore does not infer that retrying a mutation is safe. A resource adapter must
reconcile provider state and prove whether the current run created or adopted a resource before the
[setup executor](setup-run-journal.md) records ownership.

## Bounded response and stable errors

Requests and responses default to a 1 MiB maximum. Responses are read as a stream and rejected when
the declared or observed size exceeds the limit. Successful JSON must be an object with
`success: true` and an own `result` field; only `result` crosses the transport boundary.

Callers receive only these stable error codes:

| Code                              | Meaning                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| `cloudflare_api_invalid_request`  | Local configuration, path, query, or request body is invalid.            |
| `cloudflare_api_unauthorized`     | Cloudflare returned `401` or `403`.                                      |
| `cloudflare_api_rate_limited`     | Cloudflare returned `429` and safe retries are exhausted or unavailable. |
| `cloudflare_api_unavailable`      | Network, timeout, or Cloudflare `5xx` failure.                           |
| `cloudflare_api_invalid_response` | Oversized, malformed, or unexpected success response.                    |
| `cloudflare_api_request_failed`   | Other Cloudflare rejection or `success: false`.                          |

Do not wrap these errors with provider response bodies, request bodies, account IDs, or tokens.

The only provider-specific header surface is the optional closed `r2Jurisdiction` request property.
It accepts `default`, `eu`, or `fedramp`, is projected to `cf-r2-jurisdiction`, and is rejected for
non-R2 bucket paths. Callers cannot inject arbitrary headers.

## Accountless verification

<!-- tenantscript-command cwd="." expected-exit="0" -->

```sh
pnpm --filter @tenantscript/cli test:security
```

<!-- tenantscript-command cwd="." expected-exit="0" -->

```sh
pnpm verify
```

These checks validate the transport boundary without a Cloudflare account. Live permission,
rate-limit, reconciliation, and cleanup evidence remains Tier 2 work tracked by
[Issue #34](https://github.com/albert-einshutoin/TenantScript/issues/34).
