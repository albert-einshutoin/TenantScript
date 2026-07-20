# Schema diff in CI

`ext schema diff` compares two hook payload schemas before a host publishes a new schema version.
It reports removed fields, type changes, and stricter required-field rules as breaking changes so CI
can stop an incompatible release. This contract implements
[Phase 1 P1-T28](../../tasks/Phase1.md#チャンク-h-clit25t29).

## Invocation and output

Run `ext schema diff --from schemas/current.json --to schemas/candidate.json` with a pinned
TenantScript CLI artifact on `PATH`. `--from` is the currently published contract and `--to` is the
candidate contract. Reversing them produces the wrong compatibility decision.

Successful comparisons write one JSON object to standard output:

```json
{
  "compatible": true,
  "breaking": [],
  "warnings": []
}
```

`breaking` and `warnings` contain stable, human-readable reasons. CI should use the process exit
code as the gate and retain the JSON as build evidence; it should not infer success by matching
message text.

## Exit codes

| Outcome                      | Exit code | Output and CI behavior                                                                                         |
| ---------------------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| Compatible, no warnings      | `0`       | JSON on stdout with `compatible: true`; continue.                                                              |
| Compatible, warning-only     | `0`       | JSON on stdout with `warnings`; continue and surface the warning for review.                                   |
| Breaking change              | `1`       | JSON on stdout with `compatible: false` and one or more `breaking` reasons; stop the release.                  |
| Schema read or parse failure | `1`       | Diagnostic on stderr for a missing, unreadable, or invalid JSON input; stop the release and fix the job input. |
| Command usage error          | `2`       | Diagnostic on stderr for an unknown action or missing `--from` / `--to`; stop the release and fix the command. |

Exit code `1` deliberately covers both a valid breaking diff and a schema read/parse failure. A CI
job should fail for either case. Consumers that archive evidence may distinguish them by the
structured comparison JSON on stdout versus a diagnostic on stderr.

## GitHub Actions example

Install or restore a reviewed, pinned CLI artifact before this step; do not download an unpinned
executable in a pull-request job.

```yaml
- name: Reject breaking hook schema changes
  run: ext schema diff --from schemas/current.json --to schemas/candidate.json
```

No Cloudflare account, network access, or secret is required for the comparison. Keep this check in
Tier 1. Publishing the accepted schema or exercising it against a live Cloudflare runtime belongs
in a maintainer-controlled Tier 2 job.

## Dual-publish compatibility ranges

Each plugin manifest hook declares a semver `schemaVersionRange`, such as `^1.0.0`. This range is
the host payload contract and is independent from the plugin package `version`. During a breaking
schema migration, the host publishes old and new `VersionedHookSchema` entries together and uses
`routeHookPayloads` to choose the highest compatible stable version for every enabled installation.

The projection adapter starts from the host's canonical payload and produces the selected older or
newer shape. Tenant identity and host-only metadata must not be synthesized from plugin input. The
adapter output is validated against the selected Zod schema before dispatch; no compatible version,
an invalid range, duplicate published versions, or invalid adapter output blocks dispatch instead of
silently skipping an installation.

Run `ext schema diff` before adding the candidate publication. Keep the old publication until
migration tracking reports no installations whose range requires it. Follow the
[hook schema migration operations](../operations/schema-migrations.md) runbook for the app-wide
Admin UI evidence and the mandatory removal assertion.

## Field removal

Removing `memo` is breaking because an existing plugin may still read it.

```json
{
  "from": { "properties": { "memo": { "type": "string" } } },
  "to": { "properties": {} },
  "exitCode": 1,
  "breaking": ["field memo was removed"]
}
```

## Optional field addition

Adding optional `memo` is compatible. The command returns `0` and emits a warning so reviewers can
confirm that the field is intentionally optional.

```json
{
  "from": { "properties": {} },
  "to": { "properties": { "memo": { "type": "string" } } },
  "exitCode": 0,
  "warnings": ["optional field memo was added"]
}
```

## Field type change

Changing `amountCents` from `number` to `string` is breaking even when the field remains present.

```json
{
  "from": { "properties": { "amountCents": { "type": "number" } } },
  "to": { "properties": { "amountCents": { "type": "string" } } },
  "exitCode": 1,
  "breaking": ["field amountCents changed type from number to string"]
}
```

Making an existing optional field required or adding a new required field is also breaking. Adding
an optional field is currently the only warning-only change.

## Repository verification

The behavior matrix and this documentation contract are accountless and run as part of the root
test suite:

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/cli exec vitest run test/schema.test.ts
pnpm test:docs
```
