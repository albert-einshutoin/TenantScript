# Production self-host baseline

This guide converts the accountless setup plan into the smallest reproducible Control Plane Worker
that the repository currently implements. It is a deployment baseline, not clean-account Tier 2
evidence and not a claim that every planned Cloudflare resource is wired.

## 1. Review the plan

Choose the runtime explicitly and review resource, permission, cost, and reverse cleanup boundaries.

```sh
ext setup \
  --profile production \
  --runtime cloudflare-workers \
  --dry-run true
```

The first production template intentionally supports only `cloudflare-workers`. ADR-001 still tracks
the externally blocked runtime decision; Dynamic Workers and Workers for Platforms require separate
templates and live evidence.

## 2. Create D1 and render Wrangler config

Create a production D1 database through the operator's normal Cloudflare process. Copy
`deploy/self-host/production/wrangler-input.example.json` to an ignored local file, replace the
synthetic database name/ID, and run the command documented in the deployment README. Resource IDs are
deployment metadata, but the repository still does not commit account-specific values.

The renderer uses an exact input schema and emits only:

- the Control Plane Worker entrypoint;
- D1 binding `DB` and its migration directory;
- SQLite Durable Object binding `ADMIN_MUTATION_RATE_LIMITER_DO` and class declaration.

It writes an explicit `.jsonc` output only at the repository root and only when the target does not
exist. Wrangler resolves entrypoint and migration paths from the config location, so nested or
external output is rejected rather than generating a broken deployment. Keep an existing config and
review the generated diff rather than overwriting it.

## 3. Apply and verify migrations

Review every SQL file before applying it, then use the generated Wrangler config:

```sh
pnpm wrangler d1 migrations apply tenantscript-control-plane --remote --config wrangler.jsonc
pnpm wrangler deploy --dry-run --config wrangler.jsonc
pnpm wrangler deploy --config wrangler.jsonc
```

Do not treat `deploy --dry-run` as live resource, permission, migration, or request-path evidence.
After deployment, collect a secret-free doctor report through a trusted adapter and evaluate it with
`ext doctor --report`.

## 4. Provision secrets outside config

Never add API tokens, KEKs, bootstrap identity tokens, service tokens, `ADMIN_CURSOR_SECRET`, or
provider credentials to Wrangler `vars`, input JSON, issue comments, CI logs, or committed files. Use
the operator-controlled secret mechanism (for example `wrangler secret put`) and follow the relevant
rotation runbook. The template does not guess or generate secrets.

## 5. Production checklist

- **RBAC:** bootstrap only through a time-bounded operator path, create least-privilege service
  tokens, verify viewer/operator/manager/admin scope, then remove unnecessary bootstrap access.
- **Origins:** set the exact Admin UI origins; never use a wildcard production allowlist.
- **Budget:** choose Admin mutation rate limits and runtime budgets from observed workload behavior;
  alert before provider or Cloudflare limits are exhausted.
- **Retention:** document D1 hot retention and legal-hold requirements before enabling R2 archival.
  R2 remains unwired in this baseline, so do not claim long-term archive coverage.
- **Telemetry:** TenantScript telemetry remains opt-in and off by default. Review the privacy contract
  before enabling it.
- **Recovery:** retain the setup plan and operator-owned resource journal. Never delete an adopted
  resource merely because it appears in a cleanup example. Follow the
  [setup run journal recovery contract](setup-run-journal.md) and the
  [Cloudflare transport boundary](cloudflare-api-transport.md); resource-specific live Cloudflare
  apply remains unimplemented.
- **Verification:** run accountless `pnpm verify`, Wrangler dry-run, migration inspection, the
  secret-free doctor flow, and a live tenant-isolation smoke test in the operator account.

## Known integration gaps

The following planned resources are absent because their Worker composition is incomplete: artifact
R2, execution archive R2, provider secret-store Durable Object, approval Workflow, Analytics Engine
usage, and tenant runtime/dispatch binding. Track the remaining setup/IaC/Tier 2 work in
[Issue #34](https://github.com/albert-einshutoin/TenantScript/issues/34). Their absence must remain
visible in reviews and release evidence.
