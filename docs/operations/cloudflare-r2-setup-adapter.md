# Cloudflare R2 setup adapter

The CLI exposes an accountless provider adapter for the two production setup operations that own R2
buckets:

- `create:artifact-r2` owns the private plugin artifact bucket;
- `create:execution-archive-r2` owns the private execution archive bucket.

The adapter uses the hardened [Cloudflare API transport](cloudflare-api-transport.md). It does not
read credentials, bind buckets to a Worker, configure object lifecycle rules, or prove that a live
Cloudflare account can complete setup.

## Create and resume contract

Create mode requires a separate base name for each authority boundary. The adapter hashes the
persisted operation reconcile key and appends a 24-hex-character (96-bit) suffix. The full setup key
is never exposed in the account-level bucket name. Derived and adopted names enforce R2's
3–63-character, lowercase alphanumeric-and-hyphen naming contract before provider access.

For every reconcile, the adapter first performs an exact-name `GET`:

1. If the bucket exists and its configured jurisdiction and storage class match, it returns
   `created` without replaying `POST`.
2. If Cloudflare returns exactly `404`, it attempts `POST /r2/buckets` once.
3. Any collision, malformed response, property drift, authorization error, or availability error
   remains a stable failure. The adapter never chooses a fallback name.

This ordering makes a lost create response resumable while preserving the transport rule that
mutations are never retried automatically. An exact matching name is interpreted as response-loss
recovery; the 96-bit suffix makes accidental collision negligible, but it is not ownership proof
against another principal with R2 write access in the same account. Restrict that permission to the
trusted setup operator and never pre-create a derived setup name. A provider conflict is surfaced;
the adapter does not choose a fallback name.

## Explicit adoption

Adopt mode requires an exact bucket name for each operation. It performs only `GET`, returns
`adopted`, and relies on the setup executor's per-operation adoption approval. The same adopted
bucket cannot be configured for both artifacts and execution archives.

Adopted buckets are operator-owned. The adapter rejects every cleanup request routed through an
adopt-mode configuration.

## Data location boundary

Automatic data placement and the default storage class remain implicit unless the operator chooses
otherwise. Optional values are closed to Cloudflare's documented values:

- location hint: `apac`, `eeur`, `enam`, `weur`, `wnam`, or `oc`;
- jurisdiction: `default`, `eu`, or `fedramp`;
- storage class: `Standard` or `InfrequentAccess`.

A location hint is best effort and is not used as ownership evidence. A configured jurisdiction is
sent only through the closed `cf-r2-jurisdiction` transport property and must match the provider
response. Cloudflare documents jurisdiction as immutable after creation, so changing it requires an
operator-owned migration, not setup reconciliation.

See Cloudflare's [Create bucket API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/),
[Delete bucket API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/delete/),
and [data location reference](https://developers.cloudflare.com/r2/reference/data-location/).

## Ownership-safe cleanup

Cleanup is allowed only when the persisted journal disposition is `created` and the selected bucket
configuration is create mode. Before provider access, the adapter re-derives the expected name from
the run ID and operation ID and rejects a different `r2:<bucket-name>` resource reference. It then:

1. performs an exact-name `GET` in the configured jurisdiction;
2. validates the observed name and configured properties;
3. attempts `DELETE` once.

An exact `404` is idempotent success for a resumed cleanup. The adapter never empties a bucket,
deletes its objects, changes lifecycle rules, or hides Cloudflare's non-empty-bucket rejection.
Retention periods and legal holds remain operator-owned; follow
[execution retention](execution-retention.md) before enabling archive deletion.

## Accountless verification

<!-- tenantscript-command cwd="." expected-exit="0" -->

```sh
pnpm --filter @tenantscript/cli test:security
```

<!-- tenantscript-command cwd="." expected-exit="0" -->

```sh
pnpm verify
```

These checks cover schema closure, response-loss resume, explicit adoption, secret non-reflection,
and destructive cleanup boundaries. Worker binding, credential flow, lifecycle policy, and
clean-account live evidence remain tracked in
[Issue #34](https://github.com/albert-einshutoin/TenantScript/issues/34).
