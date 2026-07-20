# Cloudflare D1 migration setup adapter

TenantScript's CLI includes an accountless adapter and production runner for
`apply:control-plane-migrations`. It verifies the repository's canonical SQL catalog, compares remote
applied names as an exact prefix, applies only the missing suffix through pinned Wrangler, and
re-reads history before reporting `applied`.

The library does not prompt for credentials or compose a complete live `ext setup` command. Its
accountless tests prove the read/process boundary, not clean-account Tier 2 behavior.

## Why Wrangler remains the mutation boundary

Cloudflare documents that `wrangler d1 migrations apply` records applied migration names in the
`d1_migrations` table, applies pending files sequentially, captures a backup, and rolls back the
failing migration while preserving earlier successful migrations. TenantScript does not split SQL
on semicolons or reimplement those transaction and backup semantics. Several canonical migrations
contain trigger bodies whose internal semicolons must remain intact.

- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Wrangler D1 migration commands](https://developers.cloudflare.com/d1/wrangler-commands/#d1-migrations-apply)

## Pinned catalog

`CONTROL_PLANE_MIGRATION_MANIFEST` pins the name, byte length, and SHA-256 digest of every file in
`packages/control-plane/migrations`. `loadControlPlaneMigrationCatalog` requires:

- exactly `0001` through the current contiguous sequence;
- the canonical lowercase filename for every version;
- regular files in a non-symlink directory;
- non-empty UTF-8 SQL without unsafe control bytes;
- the pinned byte length and digest;
- no missing, renamed, additional, symlinked, or oversized files.

The returned catalog contains metadata only. SQL text and machine-local paths never enter adapter
errors, setup journals, or serialized diagnostics. Adding a migration requires an explicit manifest
update in the same reviewed change; editing an already published migration is catalog drift, not a
routine update.

## Resume contract

The injected `D1MigrationRunner` exposes only `listApplied(databaseId)` and
`applyPending(databaseId, migrationNames)`. The adapter accepts remote history only when it is an
exact prefix of the pinned catalog:

- full prefix: no mutation and return `applied`;
- partial prefix: pass only the missing suffix to the runner, then require a full re-read;
- unknown, duplicate, reversed, or gapped history: fail before mutation;
- incomplete or widened post-apply history: fail as an invalid response.

If the runner applies migrations and its response is lost, the setup journal retries the operation.
The adapter lists history again and does not replay names already present in the prefix. Stable
`D1MigrationRunnerError` values propagate unchanged; unknown runner exceptions become the
non-reflective `cloudflare_d1_migration_runner_failed` adapter code.

## Production runner boundary

`createCloudflareWranglerD1MigrationRunner` binds one immutable D1 UUID, database name, Wrangler
config path, API transport, and process executor. A fresh D1 database has no `d1_migrations` table,
so history uses two constant queries rather than parsing human-facing Wrangler output:

1. query `sqlite_schema` for the exact `d1_migrations` table name;
2. only when present, query applied names ordered by Wrangler's migration ID.

Both responses require one successful result, exact name rows, and a canonical prefix no longer than
the pinned manifest. SQL never includes operator input. Unknown fields, gaps, duplicates, excessive
rows, table drift, and provider exceptions become the stable non-reflective runner error.

Before mutation the runner re-reads history and requires the caller's non-empty names to equal the
canonical missing suffix. `createNodeWranglerD1MigrationProcess` then runs the repository-pinned
Wrangler script with `process.execPath`, an argv array, `shell: false`, ignored stdio, `CI=true`, and
metrics disabled. The only accepted command is equivalent to:

```text
wrangler d1 migrations apply <fixed-name> --remote --config <safe-relative-path> --install-skills=false
```

The repository root, config, and Wrangler script must resolve to regular non-symlink files inside
the same canonical root. Parent-directory symlink escapes, arbitrary argv, local/preview targets,
unsafe names, timeouts, signals, spawn failures, and non-zero exits fail closed. A mutation is never
automatically retried; resume must re-read remote history.

## No automatic down migration

Migration application has disposition `applied`, never `created`. `cleanupCreated` always rejects and
never calls the runner. Setup failure recovery may delete a D1 database created by the same run
through the D1 resource adapter, but it must never invent a down migration for an adopted or
pre-existing database.

## Stable errors

- `cloudflare_d1_migration_invalid_catalog`
- `cloudflare_d1_migration_invalid_configuration`
- `cloudflare_d1_migration_invalid_remote_state`
- `cloudflare_d1_migration_invalid_request`
- `cloudflare_d1_migration_invalid_response`
- `cloudflare_d1_migration_runner_failed`
- `cloudflare_d1_migration_unsupported_operation`

## Accountless verification

<!-- tenantscript-command cwd="." expected-exit="0" -->

```sh
pnpm --filter @tenantscript/cli test:security
```

<!-- tenantscript-command cwd="." expected-exit="0" -->

```sh
pnpm verify
```

Track remaining setup resources, CLI credential/composition work, and Tier 2 evidence in
[Issue #34](https://github.com/albert-einshutoin/TenantScript/issues/34).
