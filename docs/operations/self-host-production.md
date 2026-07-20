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

Create a production D1 database and private execution archive R2 bucket through the operator's
normal Cloudflare process. Copy
`deploy/self-host/production/wrangler-input.example.json` to an ignored local file, replace the
synthetic setup run ID, database name/ID, archive base bucket name, and reviewed hot-retention days,
then run the command documented in the deployment README. Worker and R2 names are derived from their
base names and 96-bit digests of operation-specific reconcile keys, so deploy and future
ownership-aware cleanup share stable targets without exposing the run ID or full keys.
Resource IDs are deployment metadata, but the repository still does not commit account-specific
values.

Use input schema version 3 for the complete accountless baseline. It adds the explicit
`USAGE_ANALYTICS` dataset binding. Version 2 remains readable without enabling Analytics Engine;
version 1 also deliberately renders the earlier D1/Worker-only baseline without an R2 binding or
scheduled trigger. Upgrading the schema never enables data movement or telemetry implicitly.

The renderer uses an exact input schema and emits only:

- the Control Plane Worker entrypoint;
- D1 binding `DB` and its migration directory;
- private R2 binding `EXECUTION_ARCHIVE`, the explicit hot-retention value, and a daily trigger;
- Analytics Engine dataset binding `USAGE_ANALYTICS`;
- SQLite Durable Object binding `ADMIN_MUTATION_RATE_LIMITER_DO` and declarative `exports` lifecycle.

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

The [D1 migration adapter and runner](cloudflare-d1-migrations.md) pin the repository catalog,
perform resume-safe prefix verification, and expose a fail-closed Wrangler process boundary. The
runner is not yet composed into a credential-bearing `ext setup` command, so operators must still
run and verify the command above.

The accountless [pinned Worker deploy process](wrangler-worker-deploy-process.md) fixes strict,
non-autoconfiguring Wrangler arguments and closes process output. It is not yet composed with remote
Worker ownership reconciliation, so it does not replace the reviewed operator command or authorize
automatic cleanup.

The setup plan models the Control Plane Worker as a create/adopt ownership resource distinct from
the selected tenant runtime Worker. The accountless
[Worker setup adapter](cloudflare-worker-setup-adapter.md) now provides deterministic create/resume
and ownership-verified cleanup. It is not yet composed into a credential-bearing `ext setup`
command, and it is not live Cloudflare evidence.

The rate-limiter Durable Object is not a separately created setup resource. Its binding and SQLite
class lifecycle are reconciled atomically by the Control Plane Worker deploy through Wrangler
`exports`. Automatic rollback never emits a destructive Durable Object tombstone, and deleting the
Worker must not be reported as proof that Durable Object data was deleted.

Do not treat `deploy --dry-run` as live resource, permission, migration, or request-path evidence.
After deployment, collect a secret-free doctor report through a trusted adapter and evaluate it with
`ext doctor --report`.

The public `createCloudflareDoctorCollector` helper composes value-free binding and secret presence
readers with a trusted migration-history reader. The binary reads DB/DO presence from the reviewed
local Wrangler config and requires the operator to attest only whether `ADMIN_CURSOR_SECRET` was
provisioned. Cloudflare Worker settings and secret response schemas may contain secret text, so the
binary never requests any Worker or secret endpoint. It intentionally reports Cloudflare
permission evidence as `unverified`: a successful resource read does not prove the exact write
authority required for deployment. See the canonical [doctor report contract](../reference/doctor-report.md#cloudflare-read-only-collector).

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
  The accountless [R2 setup adapter](cloudflare-r2-setup-adapter.md) can reconcile separate buckets,
  and the generated baseline now wires only the execution archive bucket. Each daily invocation
  processes at most one archive batch for each of 50 stable tenant/app scopes with expired rows
  from `DB`; drained scopes leave the candidate set and later runs continue the backlog. This is not
  sharded app-database or live long-term archive evidence.
- **Telemetry:** TenantScript telemetry remains opt-in and off by default. Review the privacy contract
  before enabling it.
- **Recovery:** retain the setup plan and operator-owned resource journal. Never delete an adopted
  resource merely because it appears in a cleanup example. Follow the
  [setup run journal recovery contract](setup-run-journal.md) and the
  [Cloudflare transport boundary](cloudflare-api-transport.md). The
  [D1 setup adapter](cloudflare-d1-setup-adapter.md) and
  [migration adapter and runner](cloudflare-d1-migrations.md), together with the
  [R2 setup adapter](cloudflare-r2-setup-adapter.md), are accountless resource slices; full live
  Cloudflare apply remains unimplemented.
- **Verification:** run accountless `pnpm verify`, Wrangler dry-run, migration inspection, the
  secret-free doctor flow, and a live tenant-isolation smoke test in the operator account.

## Known integration gaps

Artifact and execution archive R2 have an accountless create/adopt/cleanup adapter. Execution
archive R2 is wired for the compatibility `DB`; artifact storage and sharded retention composition
remain absent. Analytics Engine usage now has D1-backed daily summaries, a production Worker query
path, and an explicit Wrangler binding. Cloudflare creates the dataset on its first write, so setup
does not model a separate create/delete lifecycle. Other missing composition includes the provider
secret-store Durable Object, approval Workflow, the execution-recording caller, and tenant
runtime/dispatch binding. Track the remaining
setup/IaC/Tier 2 work in
[Issue #34](https://github.com/albert-einshutoin/TenantScript/issues/34). Their absence must remain
visible in reviews and release evidence.
