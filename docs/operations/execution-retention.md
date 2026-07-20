# Execution retention and R2 archive

TenantScript keeps recent execution evidence in D1 for low-latency operational searches and moves
older rows to R2 for lower-cost retention. `createD1R2ExecutionArchiveStore()` provides both the
retention job and a search operation that merges hot D1 rows with matching R2 archives.

## Self-host policy example

Use a dedicated private R2 binding for execution evidence. Do not expose the bucket through a
public custom domain.

```jsonc
{
  "r2_buckets": [
    {
      "binding": "EXECUTION_ARCHIVE",
      "bucket_name": "tenantscript-execution-archives"
    }
  ]
}
```

The application-level policy should be explicit and reviewed with the customer's contractual and
regional requirements:

```ts
const archives = createD1R2ExecutionArchiveStore(env.DB, env.EXECUTION_ARCHIVE, {
  hotRetentionDays: 30,
  batchSize: 100
});

await archives.archiveExpired({
  appId: tenant.appId,
  tenantId: tenant.id,
  now: new Date()
});
```

Run one tenant/app scope per job invocation. Rows whose `created_at` is strictly older than the
calculated cutoff are eligible; a row exactly at the cutoff remains hot until the next run. Keep
the batch small enough for the Worker CPU and D1 statement limits. Re-run until the method returns
`null` to drain a backlog.

The production Worker template schedules this path daily when
`EXECUTION_ARCHIVE_HOT_RETENTION_DAYS` is explicitly configured. One invocation reads at most 50
tenant/app scopes that have expired rows in stable order and archives one batch per scope; drained
scopes leave the candidate set so later invocations continue the remaining backlog. The current
generated composition reads scopes from the compatibility `DB` binding only.
Do not claim retention coverage for databases routed through `APP_DATABASE_ROUTES_JSON` until a
shard-aware scheduler is implemented and verified.

## Failure and consistency contract

1. The job reads one ordered, tenant-scoped batch and serializes it as NDJSON.
2. It calculates SHA-256 and writes a content-addressed R2 object.
3. One D1 batch inserts the immutable manifest and deletes the corresponding hot rows.

R2 is written first. If R2 fails, D1 is untouched. If the D1 batch fails, every hot row remains;
the only possible residue is an unreferenced content-addressed object. Concurrent jobs converge on
the same object key, while the manifest's unique key permits only one D1 commit.

The manifest records tenant/app scope, covered time range, row count, object key, and content hash.
Its D1 row cannot be updated or deleted. Search verifies both the SHA-256 digest and event count
before returning archived evidence, and fails closed if an object is missing or malformed.

## Data and access controls

- Grant bucket access only to the control-plane Worker and backup operators.
- Apply Cloudflare account controls and encryption required by the deployment's compliance policy.
- Treat execution error text as potentially sensitive and prevent secrets from entering it at the
  producer boundary.
- Keep R2 lifecycle deletion disabled until the contractual retention period and legal-hold process
  are defined.
- Monitor failed archive jobs and unreferenced objects; never delete hot D1 rows manually.

Signed compliance export consumes this same verified search path so callers do not need to know
whether evidence is still hot or archived. See [Compliance audit export](audit-export.md).
