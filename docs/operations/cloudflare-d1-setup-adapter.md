# Cloudflare D1 setup adapter

TenantScript's CLI includes an ownership-aware adapter for the two D1 operations currently present
in the production setup plan:

- `create:control-plane-d1` creates or explicitly adopts the Control Plane database;
- `declare:app-database-boundary` records the app-database declaration without a provider mutation.

The adapter uses the hardened [Cloudflare API transport](cloudflare-api-transport.md). It is a
resource-specific building block composed through the fail-closed
[setup provider router](setup-provider-router.md). The accountless
[D1 migration adapter](cloudflare-d1-migrations.md) handles the next operation, but neither adapter
is a complete `ext setup` command. Worker bindings, a live migration runner, credential input, the
remaining Cloudflare resources, and clean-account Tier 2 evidence are still required before
TenantScript can claim live self-host setup completion.

## Permission and endpoints

Use a scoped API token with `D1 Write` only when create or cleanup is required. Cloudflare's current
references document:

| Operation                             | Endpoint                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Find a deterministic create target    | [List D1 databases](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/list/)    |
| Create the Control Plane database     | [Create D1 database](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/) |
| Verify an adopted or cleanup target   | [Get D1 database](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/get/)       |
| Remove a database created by this run | [Delete D1 database](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/delete/) |

The adapter never accepts an API URL, account ID, or token. Those remain inside the fixed-origin
transport. Provider response messages are not copied into adapter errors or setup journals.

## Create mode

Create mode accepts a lowercase base name and an optional `eu` or `fedramp` jurisdiction. The final
database name appends a 96-bit digest of the setup operation's persisted reconcile key. The full key
is not exposed in the Cloudflare resource name.

Before creating, the adapter searches page 1 with `per_page=10` and filters for the exact derived
name:

- zero exact matches: send one `POST` create request;
- one exact match: return the same `created` resource reference on crash resume;
- multiple exact matches or an invalid response: fail closed without another mutation.

The shared transport never retries `POST`. If the process terminates after Cloudflare creates the
database but before the journal checkpoint, the resumed operation derives the same name and
reconciles it through `GET` instead of replaying create.

## Adopt mode

Adopt mode accepts only a canonical D1 UUID. It verifies that exact resource through `GET` and
returns `adopted`; it never creates or deletes a database. The setup executor still requires the
operator to approve `create:control-plane-d1` in `approvedAdoptionOperationIds`. Selecting adopt mode
does not broaden that approval.

Do not switch between create and adopt mode while resuming one setup journal. Configuration drift
must be reviewed as a new operator decision.

## Cleanup boundary

Cleanup accepts only the canonical create operation and a `d1:<uuid>` journal reference. Before
`DELETE`, the adapter gets the database and verifies both UUID and the exact deterministic name for
the original reconcile operation. A mismatched name fails as `cloudflare_d1_ownership_mismatch` and
is never deleted.

A `404` during cleanup lookup is treated as idempotent success. This handles a lost successful
delete response without sending another mutation. Adopt-mode adapters, declaration operations,
malformed references, unknown response fields, and non-empty delete results fail closed.

## Stable adapter errors

The adapter serializes only these codes:

- `cloudflare_d1_invalid_configuration`
- `cloudflare_d1_invalid_request`
- `cloudflare_d1_invalid_response`
- `cloudflare_d1_ownership_mismatch`
- `cloudflare_d1_unsupported_operation`

Transport failures retain the stable `cloudflare_api_*` codes documented in the transport runbook.
Never wrap either error family with provider bodies, API tokens, account IDs, or customer data.

## Accountless verification

<!-- tenantscript-command cwd="." expected-exit="0" -->

```sh
pnpm --filter @tenantscript/cli test:security
```

<!-- tenantscript-command cwd="." expected-exit="0" -->

```sh
pnpm verify
```

These checks use injected transports and synthetic identifiers. They prove request selection,
schema validation, retry boundaries, ownership checks, and cleanup behavior without making a live
Cloudflare request. Track full setup composition and Tier 2 evidence in
[Issue #34](https://github.com/albert-einshutoin/TenantScript/issues/34).
