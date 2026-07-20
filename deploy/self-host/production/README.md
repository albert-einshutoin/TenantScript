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
Input schema version 3 adds the explicit Analytics Engine dataset binding used by production usage
metering. Version 2 remains accepted without enabling Analytics Engine; version 1 also renders the
previous D1/Worker-only configuration without enabling R2 or a Cron Trigger.

The CLI also exposes a closed pinned-Wrangler deploy process, documented in the
[Worker deploy process runbook](../../../docs/operations/wrangler-worker-deploy-process.md). It does
compose with an accountless remote Worker ownership adapter, but neither boundary is wired into a
credential-bearing `ext setup` command or a replacement for the manual reviewed deployment flow.

Only bindings consumed by `packages/control-plane/src/worker-entry.ts` are generated today:

- `DB`
- `EXECUTION_ARCHIVE`
- `ADMIN_MUTATION_RATE_LIMITER_DO`
- `USAGE_ANALYTICS`

The execution archive name is derived from the same setup run and operation key used by the
ownership-aware R2 adapter. The daily scheduled trigger archives at most one batch for each of 50
stable tenant/app scopes with expired rows per invocation. Retention is explicit through
`EXECUTION_ARCHIVE_HOT_RETENTION_DAYS`; the Worker does not infer a legal or contractual policy.
This first composition uses the compatibility `DB` binding and is not evidence for sharded app
databases.

The Durable Object binding and SQLite `exports` declaration are deployed as part of the Control
Plane Worker. They are not a separate setup resource, and automatic rollback does not emit a
destructive class tombstone.

Artifact R2, provider secret store, approval Workflow, and tenant runtime bindings remain
`integration-required`. The Analytics Engine dataset is binding-owned and appears after its first
data point write; it is not a separately created or automatically deleted setup resource. See
[the self-host production guide](../../../docs/operations/self-host-production.md) for migration,
secret, RBAC, retention, budget, and verification boundaries.
