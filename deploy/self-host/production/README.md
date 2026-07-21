# Production Wrangler template

This directory is the accountless, minimal production template for the currently wired
`cloudflare-workers` Control Plane composition. Start with
[`wrangler-input.example.json`](wrangler-input.example.json), replace the synthetic setup run ID, D1
name and ID, execution archive base bucket name, and reviewed hot-retention period,
then render from the repository root:

```sh
ext setup \
  --profile production \
  --runtime cloudflare-workers \
  --dry-run true \
  --wrangler-input deploy/self-host/production/wrangler-input.json \
  --output wrangler.jsonc
```

The renderer rejects unknown fields, unresolved placeholders, invalid names/IDs, output outside the
repository root, and an existing output file. It never accepts or emits credentials. The committed
`wrangler.example.jsonc` uses a
synthetic D1 ID only for accountless Wrangler bundle validation; do not deploy it unchanged.
Input schema version 5 adds the one-time OAuth state-store Durable Object binding and SQLite class
declaration. Version 4 remains accepted without enabling OAuth state storage, version 3 remains
accepted without enabling provider secret storage, version 2
does not enable Analytics Engine, and version 1 renders the previous D1/Worker-only configuration
without enabling R2 or a Cron Trigger.

The CLI also exposes a closed pinned-Wrangler deploy process, documented in the
[Worker deploy process runbook](../../../docs/operations/wrangler-worker-deploy-process.md). It does
compose with an accountless remote Worker ownership adapter, but neither boundary is wired into a
credential-bearing `ext setup` command or a replacement for the manual reviewed deployment flow.

Only bindings consumed by `packages/control-plane/src/worker-entry.ts` are generated today:

- `DB`
- `EXECUTION_ARCHIVE`
- `ADMIN_MUTATION_RATE_LIMITER_DO`
- `PROVIDER_SECRET_STORE_DO`
- `OAUTH_STATE_STORE_DO`
- `USAGE_ANALYTICS`

The execution archive name is derived from the same setup run and operation key used by the
ownership-aware R2 adapter. The daily scheduled trigger archives at most one batch for each of 50
stable tenant/app scopes with expired rows per invocation. Retention is explicit through
`EXECUTION_ARCHIVE_HOT_RETENTION_DAYS`; the Worker does not infer a legal or contractual policy.
This first composition uses the compatibility `DB` binding and is not evidence for sharded app
databases.

All Durable Object bindings and SQLite `exports` declarations are deployed as part of the Control
Plane Worker. They are not separate setup resources, and automatic rollback does not emit a
destructive class tombstone. Before using provider connections, provision
`PROVIDER_SECRET_KEYRING_JSON` with `wrangler secret put`; never place its key material in this input
or the generated config.

To enable authenticated Slack install-start, also set the non-secret `SLACK_OAUTH_CLIENT_ID`,
comma-separated least-privilege `SLACK_OAUTH_SCOPES`, and exact HTTPS
`SLACK_OAUTH_REDIRECT_URI` Worker variables. All three variables and `OAUTH_STATE_STORE_DO` are
required together; partial configuration fails closed. The strict setup input does not yet render
provider-specific variables, so add them through a reviewed deployment change.

Artifact R2, provider-facing OAuth callback composition after install-start, approval Workflow, and tenant runtime bindings
remain `integration-required`. The Analytics Engine dataset is binding-owned and appears after its first
data point write; it is not a separately created or automatically deleted setup resource. See
[the self-host production guide](../../../docs/operations/self-host-production.md) for migration,
secret, RBAC, retention, budget, and verification boundaries.
