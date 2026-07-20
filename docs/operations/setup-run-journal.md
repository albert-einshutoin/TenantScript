# Setup run journal and recovery

TenantScript's production setup executor records every planned operation before and after provider
reconciliation. The journal is the ownership boundary for future live Cloudflare setup: it prevents
cleanup from deleting resources that existed before the current run.

The executor and file journal are accountless orchestration foundations. The hardened
[Cloudflare API transport](cloudflare-api-transport.md), ownership-aware
[D1 setup adapter](cloudflare-d1-setup-adapter.md), and exact-ID
[provider routing](setup-provider-router.md) are available. The
[D1 migration adapter](cloudflare-d1-migrations.md) verifies a pinned catalog and resumable history,
but its live runner, credential flow, remaining resource adapters, CLI live composition, and
clean-account Tier 2 evidence are not implemented yet. Do not represent an injected adapter run as a
successful deployment.

## Ownership dispositions

Each completed operation has exactly one disposition:

| Disposition | Meaning                                                               | Automatic cleanup |
| ----------- | --------------------------------------------------------------------- | ----------------- |
| `created`   | The provider adapter proved this run created the resource.            | Eligible          |
| `adopted`   | The resource already existed and remains operator-owned.              | Never             |
| `applied`   | A declaration, migration, or binding completed without new ownership. | Never             |

Cleanup walks the canonical setup plan in reverse and calls the adapter only for `created` entries.
This rule is derived from persisted disposition, not resource name matching. A provider error cannot
change an adopted resource into a created resource.

Adoption is explicit per operation. The executor persists canonical
`approvedAdoptionOperationIds` when a run starts and rejects an adapter's `adopted` result for any
unapproved operation. A broad adapter setting cannot silently expand the operator's approved set on
resume.

## Idempotency and crash recovery

The executor derives a fixed-length SHA-256 idempotency key from run ID, operation ID, and action.
The same key is reused when a process resumes an `in-progress` reconcile or `cleaning` cleanup.
Adapters must make both calls idempotent before they are used against a live account.

Resume with the same plan, runtime, run ID, journal, and adapter configuration. The executor rejects
plan fingerprint, operation order, runtime, or run ID drift. Completed operations are skipped. A
failed run resumes cleanup; it does not silently restart resource creation.

If cleanup returns `setup_cleanup_incomplete`, preserve the journal and resolve provider access or
availability before retrying the same run. Do not edit `adopted` into `created`, change resource
references, or start a new cleanup journal.

## File safety and concurrency

The file store uses a closed version-1 schema, a 64 KiB read limit, monotonically increasing revision
CAS, and a same-directory `0600` temporary file followed by atomic rename. A lock file rejects a
concurrent/stale writer. If a process terminates while holding `<journal>.lock`, first verify that no
setup process is still active and preserve a copy of the journal before removing only the stale lock.
Never delete the journal to bypass a revision conflict.

Journal resource references are operational metadata, not a secret store. The parser rejects
credential-shaped identifiers, and provider error text is reduced to stable failure codes and
operation IDs. API tokens, KEKs, OAuth tokens, customer payloads, and provider responses must never
be written to the journal, issues, or CI logs.

## Accountless verification

<!-- tenantscript-command cwd="." expected-exit="0" -->

```sh
pnpm --filter @tenantscript/cli test:security
```

<!-- tenantscript-command cwd="." expected-exit="0" -->

```sh
pnpm verify
```

These checks prove orchestration, parser, crash/retry, ownership, and cleanup contracts only. Track
live apply, rollback journal validation against real provider behavior, and clean-account Tier 2 in
[Issue #34](https://github.com/albert-einshutoin/TenantScript/issues/34).
