# Production Wrangler template

This directory is the accountless, minimal production template for the currently wired
`cloudflare-workers` Control Plane composition. Start with
[`wrangler-input.example.json`](wrangler-input.example.json), replace the synthetic D1 name and ID,
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

Only bindings consumed by `packages/control-plane/src/worker-entry.ts` are generated today:

- `DB`
- `ADMIN_MUTATION_RATE_LIMITER_DO`

Artifact/archive R2, provider secret store, approval Workflow, Analytics Engine usage, and tenant
runtime bindings remain `integration-required`. They are deliberately absent until their production
composition exists. See [the self-host production guide](../../../docs/operations/self-host-production.md)
for migration, secret, RBAC, retention, budget, and verification boundaries.
