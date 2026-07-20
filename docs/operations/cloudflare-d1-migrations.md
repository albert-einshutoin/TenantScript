# Cloudflare D1 migration setup adapter

TenantScript's CLI includes an accountless adapter for
`apply:control-plane-migrations`. It verifies the repository's canonical SQL catalog, compares remote
applied names as an exact prefix, applies only the missing suffix through an injected runner, and
re-reads history before reporting `applied`.

This adapter does not execute SQL, spawn Wrangler, read credentials, or make a live Cloudflare call.
It defines the safety contract that a future Wrangler process runner and CLI composition must obey.
Do not treat its injected tests as clean-account Tier 2 evidence.

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

Track the live Wrangler runner, remaining setup resources, CLI composition, and Tier 2 evidence in
[Issue #34](https://github.com/albert-einshutoin/TenantScript/issues/34).
